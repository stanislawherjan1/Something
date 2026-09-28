/**
 * Tab relay — lets the assistant operate the browser tab the user is looking
 * at, through the browser extension's side panel.
 *
 *   assistant tool (workspace-api-mcp: tab_snapshot / tab_act / tab_screenshot)
 *     → POST /api/internal/tab-command   { actor, command }        (loopback)
 *     → GET  /api/tab/stream             event: command            (the user's open panel, SSE)
 *     → the panel page → postMessage → extension → chrome.debugger on the active tab
 *     → POST /api/tab/result             { id, ok, result | error } (the panel, as the user)
 *     → the tool call returns
 *
 * Looking (tab_snapshot / tab_screenshot) is allowed in any turn started from
 * the panel with the page shared. Acting (tab_act) needs the user's Act switch,
 * enforced in two independent places:
 *   - here: the panel reports its mode (POST /api/tab/mode); tab_act is refused
 *     unless it is "act", and switching to "look" — or the panel going away —
 *     fails every command still waiting, at once;
 *   - in the extension, which also refuses, detaches from the tab, and applies
 *     its hard limits (one site, idle timeout, rate limit, no password fields).
 * A command for someone without an open panel fails immediately, never hangs.
 *
 * A page turn (Look or Act) holds no integration tools (a page can carry
 * injected instructions). When a task needs them, it calls
 * use_integrations → POST /api/internal/tab-handoff { turnToken }: a second
 * turn runs from the user's own message and the tab's address, never the page
 * (lib/tab-handoff.js), and its answer is the tool's result.
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getUser, list as teamList, primaryAdminSlug, getTeamMode } from '../lib/team.js';
import { runClaudeTurn } from '../lib/claude.js';
import { runHandoff } from '../lib/tab-handoff.js';

const COMMAND_TIMEOUT_MS = 20_000;
const panels = new Map();   // slug → Set<res>   open panel streams
const modes = new Map();    // slug → 'act' (absent = look)
const pending = new Map();  // id → { slug, resolve, timer }
const turns = new Map();    // token → turn record (see openTabTurn)   turns started from the panel
const MAX_HANDOFFS_PER_TURN = 2;

// Only a turn the user started FROM the panel may drive their tab — never a
// Telegram message, a workspace chat, a reminder or a group turn, even while
// the panel is open in Act. routes/chat.js opens a token for a panel turn and
// closes it when the turn ends; the tools pass it back (IDE_TAB_TOKEN).
//
// For a hand-off (use_integrations) the record also keeps what that second
// turn may be given — the user's own message, the tab's address and title as
// the panel reported them, a replay of the chat's dialogue (`history`, lazy),
// who is asking — and `onEvent`, which streams its tool calls into this chat.
export function openTabTurn(slug, { act = false, message = '', url = '', title = '', history = null, actor = '',
  actorName = '', actorIsAdmin = false, teammates = [], onEvent = null } = {}) {
  const token = randomUUID();
  // Same resolution the tools' side uses ('default' = a solo workspace).
  const resolved = resolveSlug(slug === 'default' ? '' : slug);
  turns.set(token, { slug: resolved, act: !!act, message: String(message || ''), url: String(url || ''), title: String(title || ''),
    history, actor, actorName, actorIsAdmin, teammates, onEvent, handoff: null, handoffs: 0 });
  // The message says whether Act was on when it was sent; the panel's switch
  // is reported separately. Logging both makes a mismatch visible.
  process.stderr.write(`[tab] ${resolved}: panel turn (${act ? 'act' : 'look'}), switch is ${modes.get(resolved) === 'act' ? 'act' : 'look'}\n`);
  return token;
}
export function closeTabTurn(token) {
  if (!token) return;
  turns.get(token)?.handoff?.kill();
  turns.delete(token);
}

function loopbackOnly(req, res, next) {
  const ip = req.socket?.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  return res.status(403).json({ error: 'loopback only' });
}

// The turn's actor slug, as the assistant's tools pass it. Solo workspaces and
// the operator's own session run without one → the primary admin.
function resolveSlug(raw) {
  const slug = String(raw || '').trim();
  if (slug && /^[a-z0-9-]+$/.test(slug)) {
    if (!getTeamMode() || teamList().some(m => m.slug === slug)) return slug;
    return null;
  }
  return primaryAdminSlug() || 'default';
}

function viewerSlug(req) {
  return getUser(req.actor)?.slug || (getTeamMode() ? null : (primaryAdminSlug() || 'default'));
}

// Run one command on the user's tab and wait for the answer. Every check lives
// here.
function sendTabCommand(slug, turnToken, command) {
  if (!slug) return Promise.resolve({ ok: false, error: 'unknown actor' });
  if (!command || typeof command !== 'object' || !['snapshot', 'act', 'screenshot'].includes(command.op)) {
    return Promise.resolve({ ok: false, error: 'command required' });
  }
  const turn = turns.get(String(turnToken || ''));
  if (!turn || turn.slug !== slug) {
    return Promise.resolve({ ok: false, error: 'The browser tab can only be used in a conversation the user is having in the Something panel in Chrome, about the page they are on.' });
  }
  // Looking (snapshot / screenshot) is part of every panel turn that shares
  // the page; acting needs Act switched on, for this turn AND right now.
  const acting = command.op === 'act';
  const streams = panels.get(slug);
  if (!streams?.size) {
    return Promise.resolve({ ok: false, error: 'The browser panel is not open. Ask the user to open the Something panel in Chrome.' });
  }
  if (acting && !turn.act) {
    return Promise.resolve({ ok: false, error: 'This message was sent while Act was off, so in this reply you can look at the tab but not click or type. Tell the user what you would do; if Act is on now, they can send the request again.' });
  }
  if (acting && modes.get(slug) !== 'act') {
    return Promise.resolve({ ok: false, error: 'Act is off, so you can look at the tab but not click or type in it. Tell the user what you would do, or ask them to switch Act on.' });
  }
  const id = randomUUID();
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'The browser did not answer in time.' });
    }, COMMAND_TIMEOUT_MS);
    pending.set(id, { slug, resolve, timer });
  });
  const steps = Array.isArray(command.steps)
    ? command.steps.slice(0, 5).map((st) => ({ id: String(st?.id || ''), ...(typeof st?.text === 'string' ? { text: st.text } : {}) }))
    : undefined;
  const frame = `event: command\ndata: ${JSON.stringify({ id, op: command.op, target: command.target, text: command.text, steps })}\n\n`;
  for (const s of streams) { try { s.write(frame); } catch { /* closed */ } }
  // Audit trail: every command, who it was for, what it targeted.
  process.stderr.write(`[tab] ${slug}: ${command.op}${command.target ? ' ' + command.target : ''}${command.text != null ? ` (${String(command.text).length} chars)` : ''}${steps ? ` [${steps.map((st) => st.id).join(', ')}]` : ''}\n`);
  // Round trip = relay + the extension's own work; the extension reports the
  // latter in `timing`, so the log shows where a slow step spent its time.
  const sentAt = Date.now();
  return done.then((r) => {
    const ms = Date.now() - sentAt;
    const t = r.result?.timing;
    const relay = t ? ` relay ${ms - (t.executeMs || 0) - (t.observeMs || 0)} ms` : '';
    if (r.ok) process.stderr.write(`[tab] ${slug}: ${r.result?.audit || command.op} — ${ms} ms${relay}\n`);
    else process.stderr.write(`[tab] ${slug}: ${command.op} failed — ${ms} ms: ${String(r.error).slice(0, 120)}\n`);
    return r;
  });
}

// Pull the plug: fail everything waiting for this user, now.
function cancelPending(slug, reason) {
  for (const [id, p] of pending) {
    if (p.slug !== slug) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve({ ok: false, error: reason });
  }
}

export default function tabRouter() {
  const router = Router();

  // The panel's command stream (one per open panel).
  router.get('/tab/stream', (req, res) => {
    const slug = viewerSlug(req);
    if (!slug) return res.status(401).json({ error: 'Unauthorized.' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.socket?.setNoDelay?.(true);
    if (!panels.has(slug)) panels.set(slug, new Set());
    panels.get(slug).add(res);
    res.write('event: hello\ndata: {}\n\n');
    const beat = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { /* closed */ } }, 25_000);
    req.on('close', () => {
      clearInterval(beat);
      panels.get(slug)?.delete(res);
      if (!panels.get(slug)?.size) {
        panels.delete(slug);
        // No panel left: nothing can be acting any more.
        modes.delete(slug);
        cancelPending(slug, 'The browser panel was closed.');
      }
    });
  });

  // The panel reports the user's switch. Anything but "act" stops everything.
  router.post('/tab/mode', (req, res) => {
    const slug = viewerSlug(req);
    if (!slug) return res.status(401).json({ error: 'Unauthorized.' });
    const mode = req.body?.mode === 'act' ? 'act' : 'look';
    if (mode === 'act') modes.set(slug, 'act');
    else {
      modes.delete(slug);
      cancelPending(slug, 'The user switched the assistant off in their browser.');
    }
    process.stderr.write(`[tab] ${slug}: mode ${mode}\n`);
    return res.json({ ok: true, mode });
  });

  // The panel's answer to a command.
  router.post('/tab/result', (req, res) => {
    const slug = viewerSlug(req);
    const { id, ok, result, error } = req.body || {};
    const p = pending.get(id);
    if (!p || p.slug !== slug) return res.status(404).json({ ok: false, error: 'no such command' });
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve(ok ? { ok: true, result } : { ok: false, error: String(error || 'failed') });
    return res.json({ ok: true });
  });

  // From the assistant's tools: run one command on the user's tab.
  router.post('/internal/tab-command', loopbackOnly, async (req, res) => {
    const slug = resolveSlug(req.body?.actor);
    res.json(await sendTabCommand(slug, req.body?.turnToken, req.body?.command));
  });

  // From use_integrations: run the user's request through the integrations in
  // a turn that never sees the page. The body carries the turn token and nothing
  // else — no text from the model that read the page reaches that turn.
  router.post('/internal/tab-handoff', loopbackOnly, async (req, res) => {
    const slug = resolveSlug(req.body?.actor);
    const token = String(req.body?.turnToken || '');
    const turn = turns.get(token);
    if (!slug || !turn || turn.slug !== slug) {
      return res.json({ ok: false, error: 'The hand-off only works in a conversation the user is having in the Something panel in Chrome.' });
    }
    if (!turn.message.trim()) return res.json({ ok: false, error: 'There is no request to hand off.' });
    if (turn.handoff) return res.json({ ok: false, error: 'A hand-off is already running for this message.' });
    if (turn.handoffs >= MAX_HANDOFFS_PER_TURN) {
      return res.json({ ok: false, error: `Already handed off ${MAX_HANDOFFS_PER_TURN} times for this message. Tell the user what happened instead.` });
    }
    turn.handoffs += 1;
    process.stderr.write(`[tab] ${slug}: hand-off to the integrations (${turn.url.slice(0, 120)})\n`);
    const started = Date.now();
    turn.handoff = runHandoff({ runTurn: runClaudeTurn, turn });
    const result = await turn.handoff.done;
    turn.handoff = null;
    process.stderr.write(`[tab] ${slug}: hand-off ${result.ok ? 'done' : 'failed'} — ${Date.now() - started} ms${result.ok ? '' : `: ${String(result.error).slice(0, 120)}`}\n`);
    res.json(result);
  });

  return router;
}

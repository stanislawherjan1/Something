/**
 * /api/chat/* — multi-session web chat.
 *
 *   Sessions CRUD:
 *     GET    /api/chat/sessions[?include=archived]   — list (sidebar)
 *     POST   /api/chat/sessions                       — create new
 *     PATCH  /api/chat/sessions/:id                   — rename / pin / archive
 *     DELETE /api/chat/sessions/:id                   — soft-delete + archive jsonl
 *
 *   Turn + history (session-scoped):
 *     POST   /api/chat              { sessionId?, message, interrupt? }  — SSE stream
 *     GET    /api/chat/history      ?sessionId&before&limit               — page of history
 *     POST   /api/chat/reset        { sessionId? }                        — topic marker + clear claudeSessionId
 *     POST   /api/chat/sessions/:id/stop                                   — interrupt without follow-up
 *     POST   /api/chat/sessions/:id/forward-to-telegram { messageIds, note? } — Phase 6
 *
 * `sessionId` defaults to the current session (most recently touched
 * non-archived) when omitted, so older clients that don't know about
 * multi-session keep working. Phase 3 frontend always sends it explicitly.
 *
 * Interrupt + auto-relay (Phase 4): POST /chat with `interrupt: true` sends
 * SIGTERM to the active claude process for that sessionId, appends the
 * partial assistant text to history with state:'interrupted', then spawns a
 * fresh turn that --resume's the same Claude session (which now has the
 * partial visible in its session storage) plus the new user message.
 */

import { Router } from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { runClaudeTurn } from '../lib/claude.js';
import { hasClaudeToken, readClaudeToken } from '../lib/setup.js';
import {
  listSessions, getSession, createSession, updateSession,
  deleteSession, setClaudeSessionId, setSyncedSeq,
} from '../lib/sessions.js';
import {
  appendToSession, readSessionPage, readUndelivered, archiveSessionFile,
  appendMessage, readPage, appendResetMarker, summary,
} from '../lib/chatHistory.js';
import { writeRecentSnapshot } from '../lib/recent-snapshot.js';
import { saveAttachments, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES } from '../lib/attachments.js';
import { requireActor } from '../lib/auth.js';
import { CLAUDE_BIN } from '../lib/config.js';
import { getUser, list as teamRoster } from '../lib/team.js';
import { preferredLanguage } from '../lib/memory-loader.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize:  MAX_FILE_BYTES,
    files:     MAX_FILES,
    fieldSize: 1 * 1024 * 1024,
    fields:    10,
  },
});

const ATTACHMENT_BUCKET = 'main';

// Per-user web chat (team mode): each user's sessions + history live under their
// own actor key (their slug) at .team/users/<key>/. An unidentified actor falls
// back to 'default' (migrated to the admin's slug at startup so nothing is
// orphaned). req.chatActor / chatActorName / chatIsAdmin are set once per
// request by the middleware below and used throughout — including the per-turn
// actor context + PreToolUse scope guard fed to runClaudeTurn.

// ─── Replay in-session context when there's no Claude session to --resume ────
//
// A session can hold prior messages with NO claudeSessionId attached — most
// importantly one seeded by a proactive bot message (POST /internal/chat-session
// ← web_send_message MCP). The seed text was authored by the bot's tmux brain,
// not by any web `claude -p` turn, so there's no Claude session to resume. On
// the user's first reply claudeSid is null and the fresh process can't see the
// seed — it will deny having sent it ("I have no context for what this refers
// to"). Replay the tail of THIS session (since the last reset marker) into the
// prompt so the assistant recognises its own prior / proactive messages.
//
// Only this session's own file is read — never another session's — so this does
// NOT reintroduce the cross-conversation bleed that `|| null` (below) fixed.
const REPLAY_MAX_MESSAGES = 30;
const REPLAY_MAX_CHARS    = 6000;

function buildResumeContext(actor, sessionId) {
  let page;
  try { page = readSessionPage(actor, sessionId, { limit: REPLAY_MAX_MESSAGES }); }
  catch { return null; }
  let msgs = page.messages || [];
  // Drop everything up to and including the last reset marker — a reset means
  // "new topic", so pre-reset context stays out.
  let lastReset = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].kind === 'reset') { lastReset = i; break; }
  }
  if (lastReset >= 0) msgs = msgs.slice(lastReset + 1);
  // Keep only real dialogue turns that carry text.
  msgs = msgs.filter(m =>
    (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim());
  if (msgs.length === 0) return null;
  const lines = msgs.map(m =>
    `${m.role === 'assistant' ? 'assistant (you)' : 'user'}: ${String(m.text).trim()}`);
  let body = lines.join('\n\n');
  // Trim from the front to fit the budget (keep the most recent context).
  while (body.length > REPLAY_MAX_CHARS && lines.length > 1) {
    lines.shift();
    body = lines.join('\n\n');
  }
  return body;
}

// ─── Helper — pick a working session id for a request ────────────────────────

/**
 * Resolve the session this request operates on. Explicit `sessionId` wins;
 * fallback to the most-recent non-archived session (creating one if the
 * workspace has none).
 */
function resolveSessionId(actor, explicit) {
  if (typeof explicit === 'string' && explicit) {
    const s = getSession(actor, explicit);
    if (!s) return null;          // 404 — caller surfaces the error
    return explicit;
  }
  const sessions = listSessions(actor);
  for (const s of sessions) if (!s.archived) return s.id;
  // Fresh workspace — create the first session on demand.
  return createSession(actor, {}).id;
}

// ─── Helper — auto-title via Haiku (Phase 5) ─────────────────────────────────

/**
 * Fire-and-forget: after a session's first user+assistant pair lands, ask
 * Haiku 4.5 to produce a 5-7 word title and PATCH the manifest. Skips when
 * the session already has a user-set or LLM-set title, or when the session
 * has fewer than 2 messages.
 *
 * Uses claude -p directly (no streaming, no resume) so it's cheap and doesn't
 * collide with the main session.
 */
function maybeAutoTitle(actor, sessionId) {
  const s = getSession(actor, sessionId);
  if (!s) return;
  if (s.titleSource !== 'default') return;
  if (s.messageCount < 2) return;

  const page = readSessionPage(actor, sessionId, { limit: 4 });
  const turns = page.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${(m.text || '').slice(0, 600)}`)
    .join('\n\n');
  if (!turns) return;

  const prompt = `Produce a 5-7 word title (no quotes, no trailing punctuation) for this conversation. Title should describe the topic concretely (not "User asks question" — describe what the question is about). Reply with ONLY the title.\n\n${turns}`;

  // workspace-api runs as the coder user (uid 1000) whose env has no
  // CLAUDE_CODE_OAUTH_TOKEN by default — the main runClaudeTurn path injects
  // it from the encrypted store via readClaudeToken(). We have to do the
  // same here or claude exits 1 with "Not logged in".
  const childEnv = { ...process.env };
  if (!childEnv.CLAUDE_CODE_OAUTH_TOKEN && hasClaudeToken()) {
    try { childEnv.CLAUDE_CODE_OAUTH_TOKEN = readClaudeToken(); }
    catch (err) { process.stderr.write(`[chat/auto-title] token decrypt failed: ${err.message}\n`); }
  }

  const proc = spawn(CLAUDE_BIN, [
    '-p',
    '--dangerously-skip-permissions',
    '--model', 'claude-haiku-4-5',
    '--output-format', 'text',
  ], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });

  proc.stdin.write(prompt);
  proc.stdin.end();

  let out = '';
  proc.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`[chat/auto-title] ${chunk.toString('utf8')}`);
  });
  proc.on('close', (code) => {
    if (code !== 0) {
      process.stderr.write(`[chat/auto-title] haiku exited ${code}\n`);
      return;
    }
    let title = out.trim().split('\n')[0] || '';
    // Sanitize: strip surrounding quotes/braces, trailing dot, cap at 80 chars.
    title = title.replace(/^["'`\[\(]+|["'`\]\)]+$/g, '').replace(/[.!?]+$/, '').trim();
    if (title.length > 80) title = title.slice(0, 80).trim();
    if (!title || title.length < 3) return;
    updateSession(actor, sessionId, { title });
    // updateSession marks titleSource='user' when title is set via patch.
    // Override to 'llm' so the UI shows the auto-generated affordance.
    updateSession(actor, sessionId, { titleSource: 'llm' });
  });
}

// ─── Router ──────────────────────────────────────────────────────────────────

export default function chatRouter() {
  const router = Router();

  // Auth gate everything under /chat. /branding (in another router) stays open.
  router.use('/chat', requireActor);
  // Resolve the per-user storage key once per request (used everywhere below).
  router.use('/chat', (req, _res, next) => {
    const u = getUser(req.actor);
    req.chatActor     = u?.slug || 'default';
    req.chatActorName = u?.displayName || null;
    req.chatIsAdmin   = u?.role === 'admin';
    // The OTHER teammates, as { name, slug, lang } — the NAME lets the bot
    // recognise when the user refers to a different person; the SLUG is what it
    // must pass as `recipient` to relay (web_send_message) or scope a per-user
    // action; LANG (their declared working language, or null) lets the bot
    // compose a relay in the RECIPIENT's language. The name alone is not enough:
    // relay routing keys on the slug (B3).
    req.chatTeammates = u
      ? teamRoster()
          .filter(x => x.slug && x.slug !== u.slug)
          .map(x => ({ name: x.displayName || x.slug, slug: x.slug, lang: preferredLanguage(x.slug) }))
      : [];
    next();
  });

  // Per-session active process tracker. Maps sessionId → ChildProcess so an
  // interrupt request can find and SIGTERM the right turn. Today we expect
  // ≤1 concurrent turn per session (the UI only allows one); the map shape
  // is forward-compatible if that constraint relaxes.
  const activeBySession = new Map();
  let currentGen = 0;

  // ─── Sessions CRUD ──────────────────────────────────────────────────────────

  router.get('/chat/sessions', (req, res) => {
    try {
      const includeArchived = req.query.include === 'archived';
      const sessions = listSessions(req.chatActor, { archived: includeArchived });
      // Strip claudeSessionId from the response — internal only, never shown
      // in UI and a small data-minimization win.
      res.json({ sessions: sessions.map(s => {
        const { claudeSessionId, relayPeers, ...pub } = s;
        return pub;
      }) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/chat/sessions', (req, res) => {
    try {
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : undefined;
      const created = createSession(req.chatActor, title ? { title } : {});
      const { claudeSessionId, relayPeers, ...pub } = created;
      res.status(201).json(pub);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/chat/sessions/:id', (req, res) => {
    try {
      const patch = {};
      if (typeof req.body?.title    === 'string')  patch.title    = req.body.title.trim();
      if (typeof req.body?.pinned   === 'boolean') patch.pinned   = req.body.pinned;
      if (typeof req.body?.archived === 'boolean') patch.archived = req.body.archived;
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'no patchable fields supplied' });
      }
      const updated = updateSession(req.chatActor, req.params.id, patch);
      if (!updated) return res.status(404).json({ error: 'session not found' });
      const { claudeSessionId, relayPeers, ...pub } = updated;
      res.json(pub);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/chat/sessions/:id', (req, res) => {
    try {
      // Kill any in-flight turn for this session BEFORE archiving the jsonl,
      // so the SIGTERM'd onDone doesn't try to append into a session that
      // just got removed from the manifest.
      const active = activeBySession.get(req.params.id);
      if (active) {
        active.proc.kill('SIGTERM');
        activeBySession.delete(req.params.id);
      }
      const removed = deleteSession(req.chatActor, req.params.id);
      if (!removed) return res.status(404).json({ error: 'session not found' });
      archiveSessionFile(req.chatActor, req.params.id);
      res.json({ ok: true, id: req.params.id, archivedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── History (session-scoped, with legacy fallback) ─────────────────────────

  router.get('/chat/history', (req, res) => {
    try {
      const explicit = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
      const sid = resolveSessionId(req.chatActor, explicit);
      if (!sid) return res.status(404).json({ error: 'session not found' });

      const before = typeof req.query.before === 'string' ? req.query.before : undefined;
      const limit  = req.query.limit ? Number(req.query.limit) : undefined;
      const page = readSessionPage(req.chatActor, sid, { before, limit });
      const s = getSession(req.chatActor, sid);
      res.json({
        ...page,
        sessionId: sid,
        summary: { active: s?.messageCount || 0 },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Reset (legacy single-conversation topic boundary) ──────────────────────

  router.post('/chat/reset', (req, res) => {
    try {
      const explicit = typeof req.body?.sessionId === 'string' ? req.body.sessionId : null;
      const sid = resolveSessionId(req.chatActor, explicit);
      if (!sid) return res.status(404).json({ error: 'session not found' });

      // Kill any in-flight turn for this session before resetting.
      const active = activeBySession.get(sid);
      if (active) {
        active.proc.kill('SIGTERM');
        activeBySession.delete(sid);
        currentGen++;
      }

      appendToSession(req.chatActor, sid, { role: 'system', text: '--- new topic ---', kind: 'reset' });
      setClaudeSessionId(req.chatActor, sid, null);
      // Advance the never-blind watermark to the reset point: a "new topic" means
      // the user declared everything before it consumed, so a relay that arrived
      // pre-reset is NOT resurrected into the new topic. (Post-reset relays still
      // surface — they have a higher index than this watermark.) readUndelivered
      // reports the current message count via `total`.
      try {
        const { total } = readUndelivered(req.chatActor, sid, 0);
        setSyncedSeq(req.chatActor, sid, total);
      } catch (err) { process.stderr.write(`[chat/reset] watermark advance failed: ${err.message}\n`); }

      try { writeRecentSnapshot({ channel: 'web' }); }
      catch (err) { process.stderr.write(`[chat/reset] snapshot refresh failed: ${err.message}\n`); }

      res.json({ ok: true, sessionId: sid });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Stop (interrupt without follow-up — Phase 4) ───────────────────────────

  router.post('/chat/sessions/:id/stop', (req, res) => {
    const sid = req.params.id;
    const active = activeBySession.get(sid);
    if (!active) return res.json({ ok: true, stopped: false, reason: 'no active turn' });

    // Persist whatever assistant text we've streamed so far as an interrupted
    // turn — this way the user's history doesn't lose the partial response.
    if (active.assistantText && active.assistantText.length > 0) {
      try {
        appendToSession(req.chatActor, sid, {
          role:  'assistant',
          text:  active.assistantText,
          state: 'interrupted',
        });
      } catch (err) {
        process.stderr.write(`[chat/stop] partial persist failed: ${err.message}\n`);
      }
    }

    active.proc.kill('SIGTERM');
    activeBySession.delete(sid);
    currentGen++;
    res.json({ ok: true, stopped: true });
  });

  // ─── Forward to Telegram (Phase 6 — stub for now, real impl later) ─────────

  router.post('/chat/sessions/:id/forward-to-telegram', (req, res) => {
    // Phase 6: implement actual TG bot send. For now return 501 so the UI
    // can surface a "Coming soon" toast without exploding.
    res.status(501).json({
      error: 'forward-to-telegram not yet implemented',
      hint:  'tracked in docs/future-plans/WEB_CHAT_MULTI_SESSION.md Phase 6',
    });
  });

  // ─── POST /chat — the SSE turn ─────────────────────────────────────────────

  router.post('/chat', upload.array('files', MAX_FILES), (req, res) => {
    const { message } = req.body || {};
    const explicitSid = typeof req.body?.sessionId === 'string' ? req.body.sessionId : null;
    const interrupt   = req.body?.interrupt === true || req.body?.interrupt === 'true';

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    const sid = resolveSessionId(req.chatActor, explicitSid);
    if (!sid) return res.status(404).json({ error: 'session not found' });

    // Interrupt: SIGTERM the in-flight turn for THIS session, persist its
    // partial assistant text as state:'interrupted', then proceed to spawn
    // a new turn with the new user message. Claude --resume picks up the
    // session including the just-appended partial (validation pending —
    // see WEB_CHAT_MULTI_SESSION.md "Critical open question").
    const prevActive = activeBySession.get(sid);
    if (prevActive) {
      // Persist whatever the previous turn already streamed as an interrupted
      // assistant message — whether the client set the explicit interrupt flag
      // OR just sent a follow-up mid-stream (a fast reply / double-tap). The text
      // was shown to the user; discarding it on a plain collision made a visible
      // reply vanish on the next page refresh. The superseded turn's own finish()
      // is gen-guarded out below, so there's no double-append.
      if (prevActive.assistantText) {
        try {
          appendToSession(req.chatActor, sid, {
            role:  'assistant',
            text:  prevActive.assistantText,
            state: 'interrupted',
          });
        } catch (err) {
          process.stderr.write(`[chat] interrupt-persist failed: ${err.message}\n`);
        }
      } else if (!interrupt) {
        process.stderr.write('[chat] new message mid-turn (no partial text) — killing previous\n');
      }
      prevActive.proc.kill('SIGTERM');
      activeBySession.delete(sid);
    }
    const myGen = ++currentGen;

    let savedAttachments = [];
    try { savedAttachments = saveAttachments(ATTACHMENT_BUCKET, req.files); }
    catch (err) { return res.status(413).json({ error: err.message }); }

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.socket?.setNoDelay?.(true);

    const sendData  = (text) => res.write(`data: ${JSON.stringify(text)}\n\n`);
    const sendEvent = (name, payload) => {
      res.write(`event: ${name}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // Send the sessionId back to the client immediately so a brand-new session
    // (created on the fly when explicitSid was omitted) can be picked up by
    // the frontend without an extra roundtrip.
    sendEvent('session', { sessionId: sid });

    // claudeSessionId for --resume comes from THIS session's manifest entry,
    // and ONLY this session's. A new conversation has none yet → claudeSid is
    // null → claude.js skips --resume → a fresh Claude session is created
    // (onDone persists its id back here). The old `|| getSessionId()` fallback
    // was catastrophic: getSessionId() returns the most-recently-touched OTHER
    // session's Claude id, so opening a new chat would --resume an unrelated
    // prior conversation's full context — "a completely different thread, and
    // something old broke through". Never borrow another session's brain.
    const sessionEntry = getSession(req.chatActor, sid);
    const claudeSid = sessionEntry?.claudeSessionId || null;

    // B3 v2 — is THIS session a relay channel? If it's paired with teammates
    // (relayPeers), the user's messages here are part of a 2-way conversation
    // WITH those people (the bot is the courier), not messages to the bot. Pass
    // the peers so the turn knows to relay the user's answers back, in-thread.
    const relayThread = sessionEntry?.relayPeers
      ? Object.keys(sessionEntry.relayPeers).map(slug => {
          const mate = (req.chatTeammates || []).find(t => t.slug === slug);
          return { slug, name: mate?.name || slug };
        })
      : [];

    // ── Never-blind context ───────────────────────────────────────────────
    // Out-of-band messages (relay-in / proactive) are appended to this session's
    // jsonl by ANOTHER process and are NOT in Claude's --resume session, so the
    // brain would reply blind to them. We force-feed everything appended since
    // the watermark into the prompt. Two mutually-exclusive blocks:
    //   • !claudeSid → full dialogue REPLAY (Block A, today's behaviour) — it
    //     already contains the relay-in/proactive lines, so no separate block.
    //   • claudeSid  → --resume restores the dialogue; inject only the UNDELIVERED
    //     out-of-band lines (Block B) the resume can't know about.
    // Computed BEFORE appending the user message so its index is excluded.
    const syncedSeq = (typeof sessionEntry?.syncedSeq === 'number') ? sessionEntry.syncedSeq : 0;
    const { messages: sinceMsgs, total: msgCountBefore } = readUndelivered(req.chatActor, sid, syncedSeq);
    const undelivered = claudeSid
      ? sinceMsgs.filter(m =>
          (m.kind === 'bot' || m.kind === 'telegram-reply') && String(m.text || '').trim())
      : [];
    const resumeContext = claudeSid ? null : buildResumeContext(req.chatActor, sid);
    // The watermark to stamp once this turn is consumed: everything up to AND
    // including the user message we're about to append. Captured BEFORE spawn so
    // anything that lands mid-turn keeps a higher index and surfaces next turn.
    const consumedThroughSeq = msgCountBefore + 1;

    appendToSession(req.chatActor, sid, { role: 'user', text: message, attachments: savedAttachments });

    const baseMessage = savedAttachments.length === 0
      ? message
      : `${message}\n\n[Attachments — read these files to answer]\n${
          savedAttachments.map(a => `- ${a.path}`).join('\n')
        }`;

    let promptForClaude = baseMessage;
    if (resumeContext) {
      promptForClaude =
        `[Earlier in THIS web chat — you are continuing this conversation, not starting it. `
        + `Lines marked "assistant (you)" are messages you already sent in this chat; some may `
        + `have been sent proactively by you and delivered here. Treat them as your own prior `
        + `turns — don't deny sending them — and stay consistent.]\n\n${resumeContext}\n\n`
        + `---\n\n[The user's new message — reply to it:]\n\n${baseMessage}`;
    } else if (undelivered.length) {
      const block = undelivered
        .map(m => `${m.role === 'assistant' ? 'you' : (m.role || 'message')}: ${String(m.text).trim()}`)
        .join('\n\n');
      promptForClaude =
        `[Delivered into THIS thread since your last reply — you have NOT seen these yet (they are `
        + `not in your resumed session), but they were already shown to the people in this `
        + `conversation. Lines marked "you" are your own prior sends — don't deny them. Some are `
        + `messages relayed from a teammate; treat them as real and catch up, THEN answer the new `
        + `message:]\n\n${block}\n\n---\n\n[The user's new message — reply to it:]\n\n${baseMessage}`;
    }

    let finished = false;
    let proc;
    let spawned = false;
    let assistantText = '';

    const finish = (kind, payload) => {
      if (finished) return;
      if (myGen !== currentGen) return;
      finished = true;
      // Only clear the active entry when it's still ours. A fresh interrupt
      // turn may have replaced us moments ago; deleting unconditionally
      // would wipe the new entry and break the new turn's stop/interrupt.
      const cur = activeBySession.get(sid);
      if (cur && cur.gen === myGen) activeBySession.delete(sid);
      if (kind === 'done' && assistantText) {
        appendToSession(req.chatActor, sid, { role: 'assistant', text: assistantText });
        // Phase 5: kick off auto-title async if eligible.
        try { maybeAutoTitle(req.chatActor, sid); }
        catch (err) { process.stderr.write(`[chat] auto-title scheduling failed: ${err.message}\n`); }
      } else if (assistantText) {
        // Errored / interrupted while still the CURRENT turn (not superseded —
        // the gen guard above let us through). Keep the streamed text as an
        // interrupted message so a visible reply doesn't vanish on refresh.
        try {
          appendToSession(req.chatActor, sid, { role: 'assistant', text: assistantText, state: 'interrupted' });
        } catch (err) { process.stderr.write(`[chat] partial-persist failed: ${err.message}\n`); }
      }
      // Advance the never-blind watermark on EVERY terminal path (done / error /
      // interrupt / abort) — once the prompt was built and the process spawned,
      // the undelivered set WAS fed to the brain, so it's consumed. Not advancing
      // on error/interrupt would re-inject the same relays forever with "you have
      // NOT seen these" framing, contradicting a brain that already saw them.
      // Guarded by `spawned` so a pre-spawn failure never marks unseen relays as
      // consumed. Monotonic (setSyncedSeq never moves backward).
      if (spawned) {
        try { setSyncedSeq(req.chatActor, sid, consumedThroughSeq); }
        catch (err) { process.stderr.write(`[chat] setSyncedSeq: ${err.message}\n`); }
      }
      sendEvent(kind, payload);
      res.end();
    };

    req.on('close', () => {
      if (!finished && proc && !proc.killed && req.aborted) {
        process.stderr.write('[chat] request aborted, killing claude\n');
        proc.kill('SIGTERM');
      }
      const cur = activeBySession.get(sid);
      if (cur && cur.gen === myGen) activeBySession.delete(sid);
    });

    proc = runClaudeTurn({
      message:       promptForClaude,
      sessionId:     claudeSid,
      webSessionId:  sid,                // B3 v2: our manifest id → IDE_SESSION_ID for relay threading
      relayThread,                       // B3 v2: peers this thread is a relay channel with (reply→relay back)
      actor:         req.chatActor,      // PreToolUse scope-guard hook
      actorName:     req.chatActorName,  // per-turn [ACTOR …] context line
      actorIsAdmin:  req.chatIsAdmin,
      teammates:     req.chatTeammates,  // roster so the bot recognises other people
      onText:      (delta) => { assistantText += delta; sendData(delta); },
      onToolStart: ({ id, name })      => sendEvent('tool_start', { id, name }),
      onToolEnd:   ({ id, ok, error }) => sendEvent('tool_end', { id, ok, error: error || null }),
      onImage:     ({ mediaType, data }) => sendEvent('image', { mediaType, data }),
      onError:     (msg) => finish('error', { error: msg }),
      onDone: ({ sessionId: newClaudeSid }) => {
        // Phase 1 bug fix: persist claudeSessionId to the manifest EVERY turn,
        // not just on rotation. Otherwise _index.json's claudeSessionId stays
        // null forever (the manifest entry's claudeSessionId stays out of sync
        // with what claude actually used).
        if (newClaudeSid) {
          try { setClaudeSessionId(req.chatActor, sid, newClaudeSid); }
          catch (err) { process.stderr.write(`[chat] setClaudeSessionId: ${err.message}\n`); }
        }
        finish('done', { ok: true, session_id: newClaudeSid, sessionId: sid });
      },
    });
    // The process is live and the prompt (incl. the undelivered set) was fed —
    // mark consumed so finish() advances the watermark on any terminal path.
    spawned = true;

    activeBySession.set(sid, {
      proc,
      get assistantText() { return assistantText; },   // live view — see Stop / interrupt
      gen:  myGen,
      startedAt: new Date(),
    });
  });

  // multer error mapping
  router.use((err, _req, res, next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE'  ? `File too large — max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB per file.`
                : err.code === 'LIMIT_FILE_COUNT' ? `Too many files — max ${MAX_FILES} per message.`
                : err.code === 'LIMIT_FIELD_VALUE' ? 'Message too long.'
                : `Upload rejected (${err.code}).`;
      return res.status(413).json({ error: msg });
    }
    next(err);
  });

  return router;
}

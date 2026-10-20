/**
 * A teammate's direct message to the bot — over Telegram or Slack — is
 * answered by a turn that runs AS that teammate — their own identity, their
 * own private memory and files, the same tools a web turn of theirs has — not
 * by the operator's brain in tmux.
 *
 * The brain is the operator's assistant: it holds the operator's private
 * cards and recent Telegram, and answers in the operator's name. A member's
 * Telegram DM used to land there (the plugin passed every non-relay DM on), so
 * the member was answered from the operator's context. Now bot.sh is told the
 * message is handled (routed) and the answer comes from here. Slack has no
 * brain at all: every DM there, the admin's included, is a turn as the person.
 *
 * Continuity: one CLI session per member and surface is kept (`--resume`),
 * stored in the member's own private tree, so a conversation carries on from
 * message to message. The exchange is also written into a "Telegram" / "Slack"
 * chat in the member's web history, the record they can read and answer from —
 * and the file the memory consolidator reads it from.
 */
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from '../config.js';
import { runClaudeTurn } from '../claude.js';
import { createSession, listSessions } from '../sessions.js';
import { appendToSession } from '../chatHistory.js';

const SILENT_RE = /^\s*`{0,3}\s*\[\[\s*SILENT\s*\]\]/i;
const RESUME_LOST_RE = /no conversation found|not found|exited with code 1\b/i;

// What each surface is called in the person's web history, and how a reply
// there should read.
const SURFACES = {
  telegram: {
    title: 'Telegram',
    note: '[SURFACE] This message came in over Telegram, from the person you are talking to. ' +
      'Your final reply is delivered to them on Telegram by the system — write it as a plain Telegram message ' +
      '(short, no Markdown tables, no headings), and do not call web_send_message to reach THIS person; ' +
      'that tool is for OTHER teammates only. If there is nothing to say, reply [[SILENT]].',
  },
  slack: {
    title: 'Slack',
    note: '[SURFACE] This message came in over Slack, as a direct message from the person you are talking to. ' +
      'Your final reply is delivered to them in that Slack conversation by the system — write it as a Slack message ' +
      '(short; plain Markdown is fine, no HTML), and do not call web_send_message to reach THIS person; ' +
      'that tool is for OTHER teammates only. If there is nothing to say, reply [[SILENT]].',
  },
};
export function surfaceOf(name) {
  return SURFACES[name] ? name : 'telegram';
}

function sessionFile(slug, surface) {
  return join(PROJECT_DIR, '.team', 'users', slug, `${surface}-session.json`);
}
function loadSession(slug, surface) {
  try {
    const s = JSON.parse(readFileSync(sessionFile(slug, surface), 'utf8'));
    return s && typeof s.sessionId === 'string' && s.sessionId ? s.sessionId : null;
  } catch { return null; }
}
function saveSession(slug, surface, sessionId) {
  try {
    mkdirSync(join(PROJECT_DIR, '.team', 'users', slug), { recursive: true, mode: 0o770 });
    writeFileSync(sessionFile(slug, surface), JSON.stringify({ sessionId, at: new Date().toISOString() }), { mode: 0o660 });
  } catch (err) { process.stderr.write(`[member-dm] ${slug}: session save failed: ${err.message}\n`); }
}
function clearSession(slug, surface) {
  try { unlinkSync(sessionFile(slug, surface)); } catch { /* already gone */ }
}

// The member's "Telegram" / "Slack" chat in their web history: found, or made once.
function webSessionFor(slug, surface) {
  const title = SURFACES[surface].title;
  try {
    const hit = listSessions(slug, { archived: false }).find(s => s.title === title);
    if (hit) return hit.id;
  } catch { /* no history yet */ }
  return createSession(slug, { title }).id;
}

// One turn per member at a time, in the order the messages arrived.
const chains = new Map();

/**
 * Run one turn for the member and deliver the reply. `deps` are injectable
 * for tests: runTurn(params) → Promise<{ text, sessionId, error, sentItself }>,
 * send(target, text) → Promise<{ ok }>. `surface` is 'telegram' (default) or
 * 'slack'; `target` is where the reply goes (the Telegram chat id by default,
 * a Slack conversation id for Slack).
 */
export async function answerMemberDm(member, body, deps = {}) {
  const surface = surfaceOf(deps.surface);
  const runTurn = deps.runTurn || defaultRunTurn;
  const send = deps.send || (async (chatId, text) => (await import('./telegram-sync.js')).sendTelegramMessage(chatId, text));
  const target = deps.target ?? member.telegramChatId;
  const slug = member.slug;
  const webId = webSessionFor(slug, surface);
  try { appendToSession(slug, webId, { role: 'user', text: body, kind: surface }); } catch { /* record only */ }

  let sessionId = loadSession(slug, surface);
  let r = await runTurn({ member, body, sessionId, surface });
  if (r.error && sessionId && RESUME_LOST_RE.test(String(r.error))) {
    // The saved session is gone (the CLI's store was cleaned, a redeploy):
    // start afresh once rather than failing every message from now on.
    clearSession(slug, surface);
    sessionId = null;
    r = await runTurn({ member, body, sessionId: null, surface });
  }
  if (r.sessionId && r.sessionId !== sessionId) saveSession(slug, surface, r.sessionId);

  const text = String(r.text || '').trim();
  if (r.error && !text) {
    process.stderr.write(`[member-dm] ${slug}: turn failed: ${String(r.error).slice(0, 200)}\n`);
    return { delivered: false, reason: 'error' };
  }
  if (r.sentItself) return { delivered: true, reason: 'sent by the model' };
  if (!text || SILENT_RE.test(text)) return { delivered: false, reason: 'silent' };

  let ok = false;
  try { ok = !!(await send(target, text))?.ok; }
  catch (err) { process.stderr.write(`[member-dm] ${slug}: send failed: ${err.message}\n`); }
  try {
    appendToSession(slug, webId, {
      role: 'assistant', text, kind: 'bot',
      delivery: {
        channel: ok ? surface : 'web',
        ...(surface === 'telegram' ? { tgChatId: ok ? String(target) : null } : { slackChannel: ok ? String(target) : null }),
        at: new Date().toISOString(),
      },
    });
  } catch { /* record only */ }
  return { delivered: ok, reason: ok ? surface : 'send failed' };
}

/** Queue a member's DM behind their previous one and return at once. */
export function startMemberDm(member, body, deps) {
  const prev = chains.get(member.slug) || Promise.resolve();
  const next = prev.then(() => answerMemberDm(member, body, deps)).catch((err) => {
    process.stderr.write(`[member-dm] ${member.slug}: ${err.message}\n`);
  });
  chains.set(member.slug, next);
  return next;
}

function defaultRunTurn({ member, body, sessionId, surface }) {
  return new Promise((resolve) => {
    let out = '', lastSegment = '', sentItself = false, error = null, done = false;
    const finish = (sid) => {
      if (done) return;
      done = true;
      // The closing text after the last tool call is the answer; what came
      // between tool calls is narration ("Checking…"), not for the person.
      resolve({ text: (out.trim() ? out : lastSegment).trim(), sessionId: sid || null, error, sentItself });
    };
    try {
      runClaudeTurn({
        message: body,
        actor: member.slug,
        actorName: member.displayName || member.slug,
        // Privacy is by path, never by role: the flag only tells the turn who
        // is asking, the way a web turn of theirs would.
        actorIsAdmin: member.role === 'admin',
        teammates: [],
        sessionId: sessionId || undefined,
        systemNote: SURFACES[surfaceOf(surface)].note,
        onText: (t) => { out += t; },
        onToolStart: (info) => {
          if (/web_send_message/.test(String(info?.name || ''))) sentItself = true;
          if (out.trim()) lastSegment = out;
          out = '';
        },
        onToolEnd: () => {}, onImage: () => {},
        // A non-zero exit reports through onError only (no onDone follows).
        onError: (e) => { error = e; finish(null); },
        onDone: ({ sessionId: sid } = {}) => finish(sid),
      });
    } catch (err) { error = err; finish(null); }
  });
}

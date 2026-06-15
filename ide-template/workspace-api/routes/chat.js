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
  deleteSession, setClaudeSessionId,
} from '../lib/sessions.js';
import {
  appendToSession, readSessionPage, archiveSessionFile,
  appendMessage, readPage, appendResetMarker, summary,
} from '../lib/chatHistory.js';
import { writeRecentSnapshot } from '../lib/recent-snapshot.js';
import { saveAttachments, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES } from '../lib/attachments.js';
import { requireActor } from '../lib/auth.js';
import { CLAUDE_BIN } from '../lib/config.js';

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
const ACTOR = 'default';   // Single-user until MULTI_USER_TEAM_MODE; req.actor will populate this later

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
      const sessions = listSessions(ACTOR, { archived: includeArchived });
      // Strip claudeSessionId from the response — internal only, never shown
      // in UI and a small data-minimization win.
      res.json({ sessions: sessions.map(s => {
        const { claudeSessionId, ...pub } = s;
        return pub;
      }) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/chat/sessions', (req, res) => {
    try {
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : undefined;
      const created = createSession(ACTOR, title ? { title } : {});
      const { claudeSessionId, ...pub } = created;
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
      const updated = updateSession(ACTOR, req.params.id, patch);
      if (!updated) return res.status(404).json({ error: 'session not found' });
      const { claudeSessionId, ...pub } = updated;
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
      const removed = deleteSession(ACTOR, req.params.id);
      if (!removed) return res.status(404).json({ error: 'session not found' });
      archiveSessionFile(ACTOR, req.params.id);
      res.json({ ok: true, id: req.params.id, archivedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── History (session-scoped, with legacy fallback) ─────────────────────────

  router.get('/chat/history', (req, res) => {
    try {
      const explicit = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
      const sid = resolveSessionId(ACTOR, explicit);
      if (!sid) return res.status(404).json({ error: 'session not found' });

      const before = typeof req.query.before === 'string' ? req.query.before : undefined;
      const limit  = req.query.limit ? Number(req.query.limit) : undefined;
      const page = readSessionPage(ACTOR, sid, { before, limit });
      const s = getSession(ACTOR, sid);
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
      const sid = resolveSessionId(ACTOR, explicit);
      if (!sid) return res.status(404).json({ error: 'session not found' });

      // Kill any in-flight turn for this session before resetting.
      const active = activeBySession.get(sid);
      if (active) {
        active.proc.kill('SIGTERM');
        activeBySession.delete(sid);
        currentGen++;
      }

      appendToSession(ACTOR, sid, { role: 'system', text: '--- new topic ---', kind: 'reset' });
      setClaudeSessionId(ACTOR, sid, null);

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
        appendToSession(ACTOR, sid, {
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

    const sid = resolveSessionId(ACTOR, explicitSid);
    if (!sid) return res.status(404).json({ error: 'session not found' });

    // Interrupt: SIGTERM the in-flight turn for THIS session, persist its
    // partial assistant text as state:'interrupted', then proceed to spawn
    // a new turn with the new user message. Claude --resume picks up the
    // session including the just-appended partial (validation pending —
    // see WEB_CHAT_MULTI_SESSION.md "Critical open question").
    const prevActive = activeBySession.get(sid);
    if (prevActive) {
      if (interrupt && prevActive.assistantText) {
        try {
          appendToSession(ACTOR, sid, {
            role:  'assistant',
            text:  prevActive.assistantText,
            state: 'interrupted',
          });
        } catch (err) {
          process.stderr.write(`[chat] interrupt-persist failed: ${err.message}\n`);
        }
      } else {
        // Non-interrupt collision: a frantic double-tap on send. Existing
        // behavior is to abort + replace — keep that for the no-interrupt
        // flag path so older clients don't get stuck.
        process.stderr.write('[chat] new message mid-turn (no interrupt flag) — killing previous\n');
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
    const sessionEntry = getSession(ACTOR, sid);
    const claudeSid = sessionEntry?.claudeSessionId || null;

    appendToSession(ACTOR, sid, { role: 'user', text: message, attachments: savedAttachments });

    const promptForClaude = savedAttachments.length === 0
      ? message
      : `${message}\n\n[Attachments — read these files to answer]\n${
          savedAttachments.map(a => `- ${a.path}`).join('\n')
        }`;

    let finished = false;
    let proc;
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
        appendToSession(ACTOR, sid, { role: 'assistant', text: assistantText });
        // Phase 5: kick off auto-title async if eligible.
        try { maybeAutoTitle(ACTOR, sid); }
        catch (err) { process.stderr.write(`[chat] auto-title scheduling failed: ${err.message}\n`); }
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
      message:     promptForClaude,
      sessionId:   claudeSid,
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
          try { setClaudeSessionId(ACTOR, sid, newClaudeSid); }
          catch (err) { process.stderr.write(`[chat] setClaudeSessionId: ${err.message}\n`); }
        }
        finish('done', { ok: true, session_id: newClaudeSid, sessionId: sid });
      },
    });

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

/**
 * Claude Code CLI wrapper.
 *
 * Spawns `claude -p --output-format stream-json` for one user turn at a time,
 * writes the message to stdin, parses stream-json events line by line, and
 * forwards relevant pieces to the caller through callbacks.
 *
 * Iteration 1: only `text_delta` events are surfaced. Tool-use chips, error
 * events, etc. land in iteration 2 (see workspace (todo).md).
 *
 * Auth: CLAUDE_CODE_OAUTH_TOKEN is inherited from process.env — same path
 * the Telegram bot uses.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { userInfo } from 'node:os';
import { CLAUDE_BIN, PROJECT_DIR } from './config.js';
import { hasClaudeToken, readClaudeToken } from './setup.js';
import { buildCachedPrefix } from './memory-loader.js';
import { syncMcpServers } from './integrations/runtime.js';

// mcpServers config for the web chat's claude (written by syncMcpServers).
const BOT_CLAUDE_CONFIG = '/home/bot/.claude.json';

/**
 * Run one user turn. Returns the spawned ChildProcess so the caller can
 * SIGTERM it on client abort.
 *
 * Callbacks:
 *   onText(delta)               — text_delta from the assistant
 *   onToolStart({id, name})     — assistant invoked a tool (chip should appear)
 *   onToolEnd({id, ok, error?}) — tool finished; ok=false when claude reported is_error
 *   onImage({mediaType, data})  — image returned by a tool (e.g. Playwright
 *                                 screenshot); data is base64 without the
 *                                 `data:` prefix.
 *   onError(message)            — spawn / non-zero exit
 *   onDone({sessionId})         — clean exit
 */
export function runClaudeTurn({ message, sessionId, webSessionId, actor, actorName, actorIsAdmin, teammates, onText, onToolStart, onToolEnd, onImage, onError, onDone }) {
  const args = [
    '-p',
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',  // stream-json requires --verbose to actually stream
    // Expand Claude's trusted scope beyond PROJECT_DIR so it can read/write
    // global skills (~/.claude/skills/) and CLAUDE.md without permission prompts.
    '--add-dir', join(dirname(PROJECT_DIR), '.claude'),
    // mcpServers config lives in /home/bot/.claude.json (CLAUDE_CONFIG_PATH
    // env in ecosystem.config.js points wsapi's syncMcpServers writes here).
    // Without this flag claude -p resolves ~/.claude.json against wsapi's
    // HOME (=/home/wsapi after the Phase-2 broker isolation gave wsapi uid
    // 1001 + its own home — earlier comments here said /home/coder, that
    // was pre-Phase-2). /home/wsapi/.claude.json carries no mcpServers, so
    // without this flag the web chat would see 4 native tools (memory,
    // playwright, reminders, workspace-api) instead of the full active set.
    // wsapi is in the botshare group, so it can read the bot file at mode
    // 0660 group=botshare.
    '--mcp-config', BOT_CLAUDE_CONFIG,   // may be swapped for a per-user clone below
  ];

  // Memory cached prefix — ≥4096 token block from project/memory/ so
  // Anthropic's prompt cache fires (otherwise nothing is cached and every
  // turn pays full input tokens). Failures here are non-fatal: we log and
  // continue without the prefix, claude still works just without cache hit.
  try {
    // Exclude RECENT_WEB on the web path. Each web session resumes its own
    // Claude session (per-session --resume in routes/chat.js), so a rolling
    // tail of OTHER web conversations is pure same-surface bleed with no
    // upside — the model treats it as "your conversation memory" and pulls
    // unrelated web threads into a fresh chat.
    //
    // RECENT_TELEGRAM STAYS — cross-surface awareness (one bot across
    // surfaces) is a feature, not a bug. The fix for the bleed it caused
    // ("a fresh web chat answered an ambiguous question from the Telegram
    // Trello thread") is in the memory-loader guidance: RECENT_TELEGRAM is
    // framed as a DIFFERENT conversation on another surface — draw context
    // from it, but don't treat it as a direct continuation, and when a
    // question is ambiguous, ask rather than assume it's about that thread.
    const prefix = buildCachedPrefix({
      memoryDir: join(PROJECT_DIR, 'memory'),
      excludeIds: ['RECENT_WEB'],
      // Team mode: load THIS user's profile/preferences from their private
      // memory (memory/users/<slug>/), not the shared flat card. Solo →
      // actor is 'default', the loader ignores it and reads flat.
      actor,
    });
    if (prefix && prefix.block) {
      args.push('--append-system-prompt', prefix.block);
    }
  } catch (err) {
    process.stderr.write(`[claude/prefix] buildCachedPrefix failed: ${err.message}\n`);
  }

  // Team mode: tell this turn's claude WHO it's helping, so "Your Files" and the
  // hard boundary (global-claude.md "Team workspace") resolve to the right
  // person. Skipped in solo ('default') — absence of an [ACTOR] line is the
  // single-user signal the system prompt keys on.
  if (actor && actor !== 'default') {
    const me = actorName || 'this user';
    const who = actorName ? `${actorName} (slug: ${actor})` : `slug: ${actor}`;
    const mates = (Array.isArray(teammates) ? teammates : [])
      .filter(t => t && (t.slug || t.name))
      .map(t => (typeof t === 'string' ? { name: t, slug: '' } : t));
    const fmtMate = (t) => {
      if (!t.slug) return t.name;
      const lang = t.lang ? `, writes in ${t.lang}` : '';
      return `${t.name} (slug: ${t.slug}${lang})`;
    };
    const roster = mates.length
      ? ` Your teammates (DIFFERENT people): ${mates.map(fmtMate).join(', ')}. ` +
        `When the user names one of them, they mean that other person — not themselves. ` +
        `To RELAY a message to a teammate (the user says "tell X", "ask X", "let X know", "pass this to X"), call web_send_message with recipient = that teammate's slug from this list. ` +
        `Compose the relay as a natural, human message addressed to THEM — greet them, weave the sender in conversationally ("${me} is asking whether…", "${me} wanted me to let you know…"), and DON'T write a robotic "X asked me to forward" preamble; what you write is delivered verbatim. Write it in the RECIPIENT's language — if their roster entry shows "writes in <lang>", use that language; otherwise match the language they'd most likely prefer.`
      : '';
    const adminNote = actorIsAdmin ? ' This user is an admin and may access all files.' : '';
    args.push('--append-system-prompt',
      `[ACTOR ${who}] You are talking to ${me} — the person typing right now. "I", "me", "my", "we" from them mean ${me}.${roster} ` +
      `WHO ${me} IS — use these, in order: (1) this [ACTOR] line, (2) the USER_PROFILE / USER_PREFERENCES / USER_RELATIONSHIPS / USER_REFLECTIONS cards already in your prefix. In team mode THOSE USER_* cards ARE ${me}'s OWN private profile (loaded from memory/users/${actor}/) — they hold ${me}'s real name, facts, and taste, so READ them and use them directly. If a USER_* card has content, NEVER say "I have no profile for you" or "I don't know your name" — the answer is right there in the card. ` +
      `SEPARATELY — do not confuse the workspace OWNER with ${me}: the SHARED cards (AGENT_IDENTITY, AGENT_TOOLS, RULES, INDEX, topics), the project CLAUDE.md, the knowledge graph, and any auto-memory were authored for this workspace's OWNER/operator, very likely a DIFFERENT person than ${me}. When THAT shared context names a person, says "the user/you", or lists clients/projects, it's the OWNER's — NOT ${me}'s. Never call ${me} by the owner's name or attribute the owner's clients/profile to ${me}. ` +
      `${me}'s private "Your Files" = project/users/${actor}/; the SHARED workspace = the project root — everyone's common work. ` +
      `SHARED-FIRST: most questions about a teammate — "did X finish Y?", "what's the status of Z?", their progress on a shared project or task — are really about the SHARED space. Look in the shared files, Tasks, and shared memory FIRST and answer from there; if it'd help, you can even relay the question to them (see above). Do NOT deflect a work question with "that's private" — collaboration is the default. ` +
      `The one thing you genuinely can't reach is another teammate's OWN private space (project/users/<them>/, memory/users/<them>/). That only matters if the user specifically asks you to read THOSE private files — and even then, just help with the shared work unless they insist on cracking into someone's private files, in which case say each person's private space is theirs. Never invent another teammate's private content, and don't report ${me}'s own activity as if it were someone else's.${adminNote}`);
  }

  if (sessionId) args.push('--resume', sessionId);

  // Refresh BROKER_NONCE for each integration MCP before spawning.
  // Each spawn needs a fresh single-use nonce: syncMcpServers() calls
  // issueGrant(id) per MCP and writes the result to CLAUDE_CONFIG_PATH
  // (=/home/bot/.claude.json). Without this, every spawn after the first
  // consumes already-used nonces from the previous spawn → broker
  // rejects → 11 of 12 integration MCPs (everything except `docs-comments`,
  // which doesn't use the broker) silently fail to load creds and don't
  // register their tools. Caught 2026-06-03: web chat persistently saw
  // only 5 MCPs (4 native + docs-comments) regardless of which integrations
  // were activated.
  //
  // Failure here is non-fatal — claude still spawns, just without fresh
  // nonces, so the user sees the same 5-MCPs symptom. We log + continue.
  // Safe to call from concurrent turns: issueGrant generates independent
  // nonces per call, broker tracks them server-side.
  try { syncMcpServers(); }
  catch (err) { process.stderr.write(`[claude/sync-mcps] ${err.message}\n`); }

  // Per-user knowledge graph (team mode). The mcp__memory server otherwise reads
  // ONE shared memory.jsonl for the whole team — so a member's bot could pull
  // another teammate's entities via mcp__memory__search_nodes (the KG bypasses the
  // file-path scope-guard hook). Give each MEMBER a private KG by cloning the
  // just-synced /home/bot/.claude.json with the memory server's MEMORY_FILE_PATH
  // pointed at their own (scope-guarded) memory/users/<slug>/kg.jsonl. Admin +
  // Telegram + solo keep the shared store (it's the operator's accumulated KG —
  // no migration). The clone carries broker nonces, so it's written 0600 in
  // wsapi's own home (claude runs as wsapi and reads it). Per-actor file → no
  // cross-actor race; falls back to the shared config (logged) on any error.
  if (actor && actor !== 'default' && !actorIsAdmin && /^[a-z0-9-]+$/.test(actor)) {
    try {
      const cfg = JSON.parse(readFileSync(BOT_CLAUDE_CONFIG, 'utf8'));
      const mem = cfg.mcpServers && cfg.mcpServers.memory;
      if (mem && mem.env) {
        const kgDir = join(PROJECT_DIR, 'memory', 'users', actor);
        mkdirSync(kgDir, { recursive: true });
        mem.env.MEMORY_FILE_PATH = join(kgDir, 'kg.jsonl');
        // userInfo().homedir reads the PASSWD home (/home/wsapi, mode 700) —
        // independent of the process HOME env (pm2 may set it anywhere), and a
        // private dir so the clone (which carries broker nonces) can't be
        // pre-placed/symlinked by another uid the way a /tmp path could. claude
        // runs as wsapi and reads it.
        const perUserCfg = join(userInfo().homedir, `.kg-mcp-${actor}.json`);
        writeFileSync(perUserCfg, JSON.stringify(cfg), { mode: 0o600 });
        const mci = args.indexOf('--mcp-config');
        if (mci !== -1) args[mci + 1] = perUserCfg;
      }
    } catch (err) {
      process.stderr.write(`[claude/per-user-kg] ${err.message} — falling back to shared KG\n`);
    }
  }

  // Inject the stored OAuth token if it exists and isn't already in env.
  // This covers the self-service wizard path: token saved via /api/setup/token,
  // decrypted on-demand here so it never has to sit in process.env at boot.
  const childEnv = { ...process.env };
  if (!childEnv.CLAUDE_CODE_OAUTH_TOKEN && hasClaudeToken()) {
    try { childEnv.CLAUDE_CODE_OAUTH_TOKEN = readClaudeToken(); }
    catch (err) { process.stderr.write(`[claude] token decrypt failed: ${err.message}\n`); }
  }
  // Per-user scope for the PreToolUse path-guard hook (hooks/scope-guard.js):
  // it denies this turn's claude from reading/touching another user's
  // project/users/<slug>/. Admin turns set IS_ADMIN=1 → the hook lets all through.
  // Only a REAL team member gets a slug — the solo/legacy 'default' actor must
  // not trigger the scope hook (it has no private tree to guard), keeping solo
  // behaviour identical to pre-team. The hook keys on IDE_ACTOR_SLUG presence.
  if (actor && actor !== 'default') childEnv.IDE_ACTOR_SLUG = String(actor);
  // B3 v2 relay threading: the web tools (web-channel-mcp) read this to pair the
  // sender's current thread with the recipient's relay session, so a reply lands
  // back in the same thread instead of a new one. Our manifest session id (NOT
  // claude's internal --resume id). Absent on Telegram / pre-session turns.
  if (webSessionId) childEnv.IDE_SESSION_ID = String(webSessionId);
  childEnv.IDE_ACTOR_IS_ADMIN = actorIsAdmin ? '1' : '0';

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: PROJECT_DIR,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stdin.write(message);
  proc.stdin.end();

  let buffer = '';
  let capturedSessionId = sessionId || null;
  // Track whether any text has been sent this turn so we can inject a
  // paragraph break when a second text block starts (e.g. after a tool call).
  let hasStartedText = false;
  // tool_use id → tool name, captured at content_block_start. Lets us skip
  // forwarding images from `Read` tool results: those are the user's own
  // pasted/attached image being read back, and echoing it into the assistant
  // bubble is noise. Genuine tool images (Playwright screenshots) still show.
  const toolNamesById = new Map();
  const shouldForwardImage = (toolUseId) => toolNamesById.get(toolUseId) !== 'Read';

  // Set CLAUDE_DEBUG_STREAM=1 in env to log every parsed event to PM2 stderr.
  // Useful to discover SDK event types we may be ignoring (permission prompts,
  // trust requests, MCP-side approvals, etc.).
  const debugStream = process.env.CLAUDE_DEBUG_STREAM === '1';

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); }
      catch (err) {
        process.stderr.write(`[claude] parse error: ${err.message}\n`);
        continue;
      }

      if (debugStream) {
        // Trim noisy text_delta payloads to keep logs readable.
        const trimmed = JSON.parse(JSON.stringify(evt));
        if (trimmed?.event?.delta?.text && trimmed.event.delta.text.length > 60) {
          trimmed.event.delta.text = trimmed.event.delta.text.slice(0, 60) + '…';
        }
        process.stderr.write(`[claude/stream] ${JSON.stringify(trimmed)}\n`);
      }

      // Capture session_id from any event that carries it.
      if (!capturedSessionId && evt.session_id) capturedSessionId = evt.session_id;

      // Tool results land as a TOP-LEVEL `user` envelope (not inside
      // stream_event) — flip the chip from running to done/error here.
      // If the tool returned image blocks (e.g. Playwright screenshot),
      // forward each one to onImage so the chat can render it inline.
      if (evt.type === 'user' && Array.isArray(evt.message?.content)) {
        for (const block of evt.message.content) {
          if (block?.type === 'tool_result') {
            onToolEnd?.({
              id:    block.tool_use_id,
              ok:    !block.is_error,
              error: block.is_error ? extractText(block.content) : null,
            });
            if (shouldForwardImage(block.tool_use_id)) {
              for (const img of extractImages(block.content)) {
                onImage?.(img);
              }
            }
          }
        }
        continue;
      }

      if (evt.type !== 'stream_event') {
        // Permissions are handled declaratively via ~/.claude/settings.json
        // (`permissions.allow` lists trusted tools like `mcp__*`, `Read`,
        // `Bash`, `Edit`, etc.) — that's the secure path. Don't blanket-
        // approve permission_request events here: doing so would bypass the
        // settings allow-list and let any tool through, which defeats the
        // point of having one. If a permission_request arrives, log it so
        // we know which tool needs to be added to the allow-list.
        if (evt.type === 'permission_request' || (evt.request_id && evt.tool_name)) {
          process.stderr.write(`[claude/permission-blocked] tool=${evt.tool_name || '?'} — add to settings.json permissions.allow if intended\n`);
          continue;
        }
        if (!debugStream && evt.type && evt.type !== 'system' && evt.type !== 'assistant' && evt.type !== 'result') {
          process.stderr.write(`[claude/unknown-top] type=${evt.type} keys=${Object.keys(evt).join(',')}\n`);
        }
        continue;
      }
      const ev = evt.event;

      // New text block starting — inject a paragraph separator if text has
      // already been sent (happens after tool calls or thinking blocks).
      if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text') {
        if (hasStartedText) onText('\n\n');
        continue;
      }

      // Text deltas — append to assistant bubble.
      if (
        ev?.type === 'content_block_delta' &&
        ev.delta?.type === 'text_delta' &&
        typeof ev.delta.text === 'string'
      ) {
        hasStartedText = true;
        onText(ev.delta.text);
        continue;
      }

      // Tool invocation — surface as a chip in the UI.
      if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        toolNamesById.set(ev.content_block.id, ev.content_block.name);
        onToolStart?.({
          id:   ev.content_block.id,
          name: ev.content_block.name,
        });
        continue;
      }

      // Tool result — chip flips to ✓ or ⚠.
      if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_result') {
        onToolEnd?.({
          id:    ev.content_block.tool_use_id,
          ok:    !ev.content_block.is_error,
          error: ev.content_block.is_error ? extractText(ev.content_block.content) : null,
        });
        if (shouldForwardImage(ev.content_block.tool_use_id)) {
          for (const img of extractImages(ev.content_block.content)) {
            onImage?.(img);
          }
        }
        continue;
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`[claude] ${chunk.toString('utf8')}`);
  });

  proc.on('error', (err) => onError(`spawn failed: ${err.message}`));

  proc.on('close', (code, signal) => {
    if (code === 0) onDone({ sessionId: capturedSessionId });
    else onError(`claude exited with code ${code}${signal ? `, signal ${signal}` : ''}`);
  });

  return proc;
}

/**
 * Tool result content can be a plain string or an array of content blocks
 * ([{ type:'text', text:'...' }, ...]). Best-effort extraction so the UI can
 * surface error details inline on the chip.
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => (typeof b === 'string' ? b : b?.text || '')).filter(Boolean).join(' ');
  }
  return null;
}

/**
 * Pull image blocks out of tool_result content. Returns an array of
 * { mediaType, data } objects (data is base64, no `data:` prefix).
 *
 * Tool results returning images use the Anthropic content-block shape:
 *   { type: 'image', source: { type: 'base64', media_type, data } }
 *
 * Defensive: returns [] for any other content shape.
 */
function extractImages(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (b?.type === 'image' && b.source?.type === 'base64'
        && typeof b.source?.media_type === 'string'
        && typeof b.source?.data === 'string') {
      out.push({ mediaType: b.source.media_type, data: b.source.data });
    }
  }
  return out;
}

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
import { join, dirname } from 'node:path';
import { CLAUDE_BIN, PROJECT_DIR } from './config.js';
import { hasClaudeToken, readClaudeToken } from './setup.js';
import { buildCachedPrefix } from './memory-loader.js';
import { syncMcpServers } from './integrations/runtime.js';

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
export function runClaudeTurn({ message, sessionId, onText, onToolStart, onToolEnd, onImage, onError, onDone }) {
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
    '--mcp-config', '/home/bot/.claude.json',
  ];

  // Memory cached prefix — ≥4096 token block from project/memory/ so
  // Anthropic's prompt cache fires (otherwise nothing is cached and every
  // turn pays full input tokens). Failures here are non-fatal: we log and
  // continue without the prefix, claude still works just without cache hit.
  try {
    // Exclude RECENT_WEB on the web path: each session resumes its own
    // Claude session (per-session --resume in routes/chat.js), so the
    // rolling cross-conversation web tail is redundant here and actively
    // bleeds unrelated threads into the prompt. RECENT_TELEGRAM stays —
    // it's cross-surface awareness from a different channel.
    const prefix = buildCachedPrefix({
      memoryDir: join(PROJECT_DIR, 'memory'),
      excludeIds: ['RECENT_WEB'],
    });
    if (prefix && prefix.block) {
      args.push('--append-system-prompt', prefix.block);
    }
  } catch (err) {
    process.stderr.write(`[claude/prefix] buildCachedPrefix failed: ${err.message}\n`);
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

  // Inject the stored OAuth token if it exists and isn't already in env.
  // This covers the self-service wizard path: token saved via /api/setup/token,
  // decrypted on-demand here so it never has to sit in process.env at boot.
  const childEnv = { ...process.env };
  if (!childEnv.CLAUDE_CODE_OAUTH_TOKEN && hasClaudeToken()) {
    try { childEnv.CLAUDE_CODE_OAUTH_TOKEN = readClaudeToken(); }
    catch (err) { process.stderr.write(`[claude] token decrypt failed: ${err.message}\n`); }
  }

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

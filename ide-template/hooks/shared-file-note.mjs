#!/usr/bin/env node
/**
 * PostToolUse (Edit | MultiEdit | Write): after the assistant changes a file
 * that is shared by link, tell it so. Anyone with the link reads the file as it
 * is now, without signing in, so a private detail written into it leaks the
 * moment it is saved. The note goes back to the model only (additionalContext);
 * nothing is blocked or changed.
 *
 * workspace-api answers yes or no for a path the turn could open itself
 * (GET /api/internal/shared, the turn's own token). Any failure here is silent:
 * a hook must never break a turn over its own problem.
 */
import { relative, resolve, isAbsolute } from 'node:path';

const PROJECT = resolve(process.env.PROJECT_DIR || '/home/coder/project');
const PORT = process.env.WORKSPACE_API_PORT || '3001';

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const evt = JSON.parse(input || '{}');
  const file = evt?.tool_input?.file_path || evt?.tool_input?.notebook_path || '';
  if (!file || !/\.md$/i.test(file)) return;
  const abs = isAbsolute(file) ? file : resolve(evt.cwd || PROJECT, file);
  const rel = relative(PROJECT, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return;
  const res = await fetch(`http://127.0.0.1:${PORT}/api/internal/shared?path=${encodeURIComponent(rel.split('\\').join('/'))}`, {
    headers: { 'X-IDE-Turn': process.env.IDE_TURN_ID || '' },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) return;
  const out = await res.json();
  if (!out?.shared) return;
  const until = out.expiresAt ? ` until ${String(out.expiresAt).slice(0, 10)}` : '';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `"${rel}" is shared by link${until}: anyone who has the link reads it as it is now, without signing in. ` +
        'Keep private details (anything about one person, money, health, credentials, internal notes) out of it. ' +
        'If what you just wrote is like that, say so to the person and offer to move it to another file; ' +
        'mention the file is shared when you tell them what you changed.',
    },
  }));
}

main().catch(() => {}).finally(() => process.exit(0));

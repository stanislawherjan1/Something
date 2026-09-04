/**
 * Build-failing guards for entrypoint.sh — the two ways it has silently
 * mis-booted a client, both invisible at deploy time.
 *
 * (1) UNQUOTED HEREDOCS. The MCP config block is `python3 - <<PYEOF` (not
 *     <<'PYEOF'), because it interpolates shell variables into the Python. That
 *     also means bash expands backticks and $( ) inside the *whole* block —
 *     including prose in comments. Three backticked words in a comment made the
 *     boot log read `managed: command not found`, and bash executed them. Those
 *     pairs happened to enclose single words in Python comments, so nothing was
 *     lost; one pair spanning real code would have written a truncated config
 *     with no error anyone would notice.
 *
 * (2) UNBOUNDED CLEANUP BEFORE THE PROCESSES START. `pm2 delete all` wedged for
 *     5+ minutes on a fresh container, and it sits above the lines that start
 *     workspace-api and the bot — so nothing started, while the container went
 *     on reporting healthy because the frontend answers. Cleanup must never be
 *     able to hang the boot.
 *
 * Run: node lib/entrypoint-guards.test.mjs   (wired into `npm test`)
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}`); } };

const src = readFileSync(new URL('../../entrypoint.sh', import.meta.url), 'utf8');
const lines = src.split('\n');

// Collect every heredoc body whose delimiter is NOT quoted — those are the ones
// bash expands.
const unquoted = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/<<-?([A-Za-z_][A-Za-z0-9_]*)\s*(?:$|[|&>])/);
  if (!m) continue;                     // no heredoc, or delimiter is quoted
  const end = lines.indexOf(m[1], i + 1);
  const body = lines.slice(i + 1, end === -1 ? lines.length : end);
  unquoted.push({ startLine: i + 1, delimiter: m[1], body });
}

ok('the expanding heredocs are still found (guard has not gone blind)', unquoted.length > 0);

for (const h of unquoted) {
  const ticks = h.body.filter(l => l.includes('`'));
  ok(`no backticks in the expanded <<${h.delimiter} at line ${h.startLine}` +
     (ticks.length ? ` — bash would run: ${ticks[0].trim().slice(0, 60)}` : ''),
  ticks.length === 0);
}

// pm2 cleanup must be bounded, and bounded BEFORE anything is started.
const cleanup = lines.findIndex(l => /^\s*(timeout \d+ )?pm2 delete all/.test(l));
ok('pm2 delete all is still there to guard', cleanup !== -1);
ok('pm2 delete all cannot hang the boot', /^\s*timeout \d+ pm2 delete all/.test(lines[cleanup] || ''));
const firstStart = lines.findIndex(l => /^\s*pm2 start /.test(l));
ok('the cleanup really does gate the process starts (ordering assumption holds)',
  firstStart !== -1 && cleanup < firstStart);

// pm2 itself must be pinned: an unpinned global install is how 7.0.4 arrived
// unannounced in a --no-cache rebuild and wedged the boot.
const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
ok('pm2 is version-pinned in the image', /npm install -g pm2@\d+\.\d+\.\d+/.test(dockerfile));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

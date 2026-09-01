/**
 * Build-failing guard for outbound MARKER handling in the group brain.
 *
 * A marker the parser cannot match is not merely unhandled — it is POSTED. On
 * 2026-09-01 a 937-character [[PRIVATE_TASK …]] exceeded a 600-char cap in both
 * the capture regex and the "residual strip" that was supposed to catch what the
 * capture missed. Because both shared the same cap, the marker was sent to a
 * group verbatim, exposing internal file paths, and the delegated task never ran
 * while the bot told the group the result was on its way.
 *
 * Two invariants are locked here:
 *   1. the capture regex must handle a realistically long task description
 *   2. the last-resort scrub must be UNBOUNDED — it must never share the
 *      failure mode of the thing it is guarding
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'integrations', 'group-watcher.js'), 'utf8');

test('the PRIVATE_TASK payload cap is generous enough for a real delegation', () => {
  const m = SRC.match(/PRIVATE_TASK_MAX\s*=\s*(\d+)/);
  assert.ok(m, 'PRIVATE_TASK_MAX must exist as a named cap, not a magic number');
  assert.ok(Number(m[1]) >= 4000, `payload cap ${m[1]} is too small; a marker longer than the cap is POSTED, not dropped`);
});

test('the last-resort marker scrub is unbounded', () => {
  const m = SRC.match(/const ANY_MARKER_RE\s*=\s*(\/.*\/[gimsuy]*)/);
  assert.ok(m, 'ANY_MARKER_RE must exist');
  // Only a cap on the PAYLOAD matters — `{0,3}` on the optional backticks is fine.
  assert.ok(!/\[\\s\\S\]\{\d+/.test(m[1]), 'the scrub must not cap the payload length — that is how the 2026-09-01 leak happened');
  assert.ok(/g/.test(m[1].split('/').pop()), 'the scrub must be global');
});

test('a 937-char marker is captured and scrubbed, not posted', () => {
  const MAX = Number(SRC.match(/PRIVATE_TASK_MAX\s*=\s*(\d+)/)[1]);
  const RE = new RegExp('`{0,3}\\[\\[\\s*PRIVATE_TASK\\s+([\\s\\S]{1,' + MAX + '}?)\\s*\\]\\]`{0,3}', 'i');
  const ANY = /`{0,3}\[\[\s*(?:PRIVATE_TASK|SEND_FILE|SEND_FILE_DM)\b[\s\S]*?\]\]`{0,3}/gi;

  const payload = 'Review the roster file and research every fund with more than one named address. '.repeat(12).slice(0, 937);
  const text = `On it.\n[[PRIVATE_TASK ${payload}]]`;

  const captured = text.match(RE);
  assert.ok(captured, 'a 937-char marker must be captured');
  assert.equal(captured[1].length, 937);

  const scrubbed = text.replace(ANY, '').trim();
  assert.ok(!/\[\[\s*PRIVATE_TASK/i.test(scrubbed), 'no marker may survive into posted text');
  assert.equal(scrubbed, 'On it.');
});

test('a marker spanning newlines is still captured', () => {
  const MAX = Number(SRC.match(/PRIVATE_TASK_MAX\s*=\s*(\d+)/)[1]);
  const RE = new RegExp('`{0,3}\\[\\[\\s*PRIVATE_TASK\\s+([\\s\\S]{1,' + MAX + '}?)\\s*\\]\\]`{0,3}', 'i');
  assert.ok('[[PRIVATE_TASK do this\nand then\nthat]]'.match(RE));
});

test('an unparsed marker must block the send', () => {
  assert.ok(/refusing to post: unparsed marker survived/.test(SRC),
    'group compose must refuse to post text that still contains marker syntax');
});

test('the streamed [[SEND]] flush path also scrubs markers', () => {
  // The 2026-09-01 leak reached the group through this path: a marker too long
  // to capture stayed in the buffer, and the chunk before the next [[SEND]] was
  // posted verbatim. Raising the capture cap alone leaves the same hole further
  // out, so the flush must scrub and refuse independently.
  const flush = SRC.match(/const flushSends = \(\) => \{[\s\S]*?\n    \};/);
  assert.ok(flush, 'flushSends must exist');
  assert.ok(/ANY_MARKER_RE/.test(flush[0]), 'flushSends must scrub markers before sending');
  assert.ok(/dropping streamed chunk/.test(flush[0]), 'flushSends must refuse a chunk with a surviving marker');
});

test('an oversized marker is dropped, not posted, on the streaming path', () => {
  const ANY = /`{0,3}\[\[\s*(?:PRIVATE_TASK|SEND_FILE|SEND_FILE_DM)\b[\s\S]*?\]\]`{0,3}/gi;
  const huge = 'x '.repeat(6000);                       // far beyond any capture cap
  const chunk = `Working on it.\n[[PRIVATE_TASK ${huge}]]`;
  const scrubbed = chunk.replace(ANY, '').trim();
  assert.equal(scrubbed, 'Working on it.');
  assert.ok(!/\[\[/.test(scrubbed));
});

/**
 * One helper decides what is a group id. A Telegram group is its bare negative
 * chat id and keeps working unchanged; another surface's id carries its prefix;
 * nothing that could walk a path or name a scope by accident passes.
 * Run: node lib/group-id.test.mjs
 */
import { groupIdKind, isGroupId, normalizeGroupId } from './group-id.js';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}`); } };

for (const id of ['-1001234567890', '-100777', '-1234', '-99999999999999999999']) {
  ok(`${id} is a Telegram group`, groupIdKind(id) === 'telegram' && isGroupId(id) && normalizeGroupId(id) === id);
}
ok('a number is accepted and comes back as a string', normalizeGroupId(-1001234567890) === '-1001234567890');
ok('surrounding whitespace is trimmed', normalizeGroupId(' -100777 ') === '-100777');
for (const id of ['slack-C0123ABCD', 'slack-G01ABCDEF', 'slack-C012345678901234567']) {
  ok(`${id} is a Slack group`, groupIdKind(id) === 'slack' && normalizeGroupId(id) === id);
}
for (const id of [
  '', null, undefined, '-', '-123', '123456789', '100777', '-100777x', '-1.5', '--100777', '-100777/../x',
  'slack-', 'slack-c0123abcd', 'slack-0123ABCD', 'slack-C01', 'slack-C0123ABCD/..', 'slack-C0123 ABCD', 'Slack-C0123ABCD',
  'telegram--100777', 'group:-100777', '-100777\n-100778', '../-100777', 'C0123ABCD',
]) {
  ok(`${JSON.stringify(id)} is not a group id`, groupIdKind(id) === null && !isGroupId(id) && normalizeGroupId(id) === null);
}
console.log(`group-id: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

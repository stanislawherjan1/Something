/**
 * A reminder's room target: a Telegram group id, a Slack channel in either
 * spelling, nothing else. Run: node apps/reminder-mcp/room-target.test.mjs
 */
import { roomTarget, roomNamedIn } from './room-target.js';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name} ${extra !== undefined ? JSON.stringify(extra) : ''}`); } };
ok('a Telegram group id', roomTarget('-5132831011') === '-5132831011');
ok('a Slack channel as the registry keys it', roomTarget('slack-C0CBFGQC5E0') === 'slack-C0CBFGQC5E0');
ok('...as Slack shows it', roomTarget('C0CBFGQC5E0') === 'slack-C0CBFGQC5E0');
ok('...in any case', roomTarget('slack-c0cbfgqc5e0') === 'slack-C0CBFGQC5E0');
ok('a person\'s Telegram id is a person, not a room', roomTarget('1498947775') === '1498947775' /* a positive id passes the shape; the registry refuses it at fire time */);
ok('a Slack user id is no room', roomTarget('U0CAWEJL2DD') === null);
ok('a name is no room', roomTarget('#all-something') === null && roomTarget('Team Room') === null);
ok('nothing is nothing', roomTarget('') === null && roomTarget(undefined) === null);
const rooms = [{ chatId: 'slack-C0ROOM0001', title: '#all-hands' }, { chatId: '-100777', title: 'Studio crew' }, { chatId: 'slack-C0ROOM0002', title: '#fun' }];
ok('a Slack channel named by its #name', roomNamedIn('Once a day, post one short joke to #all-hands.', rooms)?.chatId === 'slack-C0ROOM0001');
ok('...whatever the case', roomNamedIn('post it in #All-Hands please', rooms)?.chatId === 'slack-C0ROOM0001');
ok('a Telegram group named by its title', roomNamedIn('Remind the studio crew on Friday about the kiln', rooms)?.chatId === '-100777');
ok('a word inside another word is no name', roomNamedIn('the #all-hands-on-deck note', rooms) === null && roomNamedIn('crewmate', rooms) === null);
ok('two rooms named: nobody is chosen', roomNamedIn('post to #all-hands and #fun', rooms) === null);
ok('no room named: nothing', roomNamedIn('post one short joke to the Slack channel', rooms) === null);
ok('a bare id in the words is not a name', roomNamedIn('C0ROOM0001', rooms) === null);
console.log(`room-target: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

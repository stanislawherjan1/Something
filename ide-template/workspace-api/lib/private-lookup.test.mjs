/**
 * A member's own memory asked from a team room (lib/integrations/private-lookup.js):
 * who counts as an outsider in a Slack channel and in a Telegram group, who the
 * one-shot is told is in the room, what it is asked and what its answer means,
 * and that it may read memory and nothing else. The group prompt offers the
 * tool to a roster member and never to an unknown sender. No model is called.
 *
 * Run: node lib/private-lookup.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'private-lookup-'));
process.env.PROJECT_DIR = ROOT;
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };

writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'nora@example.test', role: 'admin', slug: 'nora', displayName: 'Nora', telegramChatId: '1110001', slackUserId: 'U0NORA001', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'mara@example.test', role: 'member', slug: 'mara', displayName: 'Mara', telegramChatId: '2220002', slackUserId: 'U0MARA001', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: {
  '-100777': { title: 'Studio', members: { 1110001: 'Nora', 2220002: 'Mara' } },
  '-100888': { title: 'Studio + guest', members: { 1110001: 'Nora', 3330003: 'Olek the glazer' } },
  'slack-C0TEAM': { title: '#studio', openAudience: true, members: { U0NORA001: 'U0NORA001' }, audience: { ok: true, outsiders: [], shared: false, members: 2 } },
  'slack-C0GUEST': { title: '#studio-guests', openAudience: true, members: { U0NORA001: 'U0NORA001' }, audience: { ok: false, outsiders: [{ id: 'U0GUEST001', name: 'Olek the glazer' }], shared: false, members: 3 } },
} }));

const PL = await import('./integrations/private-lookup.js');
const { getGroup } = await import('./team.js');
const { groupTurnParams } = await import('./integrations/group-watcher.js');

// ─── who is an outsider, who is in the room ──────────────────────────────────
ok('a Telegram group of roster people has no outsiders', PL.outsidersOf(getGroup('-100777')).length === 0);
ok('a Telegram group member not on the roster is an outsider, by name', JSON.stringify(PL.outsidersOf(getGroup('-100888'))) === '["Olek the glazer"]', PL.outsidersOf(getGroup('-100888')));
ok('a Slack room the audience check passed has none', PL.outsidersOf(getGroup('slack-C0TEAM')).length === 0);
ok('a Slack room with a guest has one, by name', JSON.stringify(PL.outsidersOf(getGroup('slack-C0GUEST'))) === '["Olek the glazer"]', PL.outsidersOf(getGroup('slack-C0GUEST')));
ok('the room\'s people are named as the roster names them, guests as the room does', JSON.stringify(PL.peopleInRoom(getGroup('-100888')).sort()) === '["Nora","Olek the glazer"]', PL.peopleInRoom(getGroup('-100888')));
ok('...by Slack id too', JSON.stringify(PL.peopleInRoom(getGroup('slack-C0TEAM'))) === '["Nora"]', PL.peopleInRoom(getGroup('slack-C0TEAM')));

// ─── what the one-shot is asked ──────────────────────────────────────────────
const nora = { slug: 'nora', displayName: 'Nora', role: 'admin' };
const prompt = PL.lookupPrompt({ member: nora, question: 'what did we agree with Harbor Glaze?', room: getGroup('-100777'), people: ['Nora', 'Mara'] });
ok('the prompt carries the question as asked and the room', /what did we agree with Harbor Glaze\?/.test(prompt) && /"Studio"/.test(prompt));
ok('...names the others in the room, not the asker', /besides Nora: Mara/.test(prompt));
ok('...tells it to leave out what is about them unless named, silently', /Leave out anything ABOUT a person in the room/.test(prompt) && /unless the question names that person/.test(prompt) && /never hint/.test(prompt));
ok('...and to say NOTHING when there is nothing', /reply with exactly: NOTHING/.test(prompt));
ok('someone from outside is marked as such in the room list', /besides Nora: Mara, Olek the glazer \(not on the team\)/.test(PL.lookupPrompt({ member: nora, question: 'x', room: getGroup('-100888'), people: ['Nora', 'Mara', 'Olek the glazer'], outsiders: ['Olek the glazer'] })));
ok('the one-shot answers about the person too (profile, preferences), only what the question needs', /who they are, where they are, what they prefer/.test(prompt) && /their profile and preferences/.test(prompt) && /EXACTLY what was asked/.test(prompt));
ok('a question it cannot finish (the weather) gets what is known of them that it needs', /the weather, a web search/.test(prompt) && /where they are or live, their time zone/.test(prompt));
ok('the one-shot answers exactly what was asked, no related facts beside it', /answer EXACTLY what was asked and nothing beside it/.test(prompt) && /Never add a related fact the question did not ask for/.test(prompt));
ok('...never an earlier forecast or price from the conversations', /Never pass on an earlier result of such a check/.test(prompt));
ok('the one-shot holds back secrets (SECRET) in every room', /reply with exactly: SECRET/.test(prompt) && /reply with exactly: SECRET/.test(PL.lookupPrompt({ member: nora, question: 'x', room: getGroup('-100888'), people: ['Nora', 'Olek the glazer'], outsiders: ['Olek the glazer'] })));
ok('an empty room says so', /besides Nora: nobody else recorded/.test(PL.lookupPrompt({ member: nora, question: 'x', room: getGroup('-100777'), people: ['Nora'] })));

// ─── what its answer means ───────────────────────────────────────────────────
ok('NOTHING is nothing', PL.parseAnswer('NOTHING').nothing === true && PL.parseAnswer('**NOTHING**').nothing === true && PL.parseAnswer('NOTHING — no notes on that.').nothing === true);
ok('an answer is the answer', PL.parseAnswer('Harbor Glaze supplies the celadon at 14 GBP a kilo.').answer === 'Harbor Glaze supplies the celadon at 14 GBP a kilo.');
ok('an explanation that ends in the verdict is the verdict, never posted', PL.parseAnswer('The memory lookup tools are not responding right now, so I cannot verify this.\n\nNOTHING').nothing === true && PL.parseAnswer('I could not reach the records.\nFAILED').failed === true);
ok('SECRET is a secret held back, never the value', PL.parseAnswer('SECRET').secret === true && PL.parseAnswer('It is a door code.\nSECRET').secret === true && !PL.parseAnswer('SECRET').answer);
ok('FAILED is a failure', PL.parseAnswer('FAILED').failed === true);
ok('...and an answer that merely mentions the word is still an answer', PL.parseAnswer('NOTHING was decided about the kiln; Mara will call Harbor Glaze on Friday.').nothing === true && PL.parseAnswer('Mara said nothing was decided; she calls Friday.').answer !== undefined);
ok('the one-shot is told to say FAILED when its tools fail', /reply with exactly: FAILED/.test(prompt));
ok('no text is a failure, never a guess', PL.parseAnswer('').failed === true && PL.parseAnswer(null).failed === true);
ok('a long answer is cut, not dropped', PL.parseAnswer('x'.repeat(5000)).answer.length === 1200);

// ─── the one-shot through the injectable runner ──────────────────────────────
let got = null;
PL.configureLookup(async (x) => { got = x; return { answer: 'Celadon from Harbor Glaze, 14 GBP a kilo.' }; });
const r = await PL.lookupMine({ member: nora, question: 'the glaze?', room: getGroup('-100777') });
ok('the lookup runs as the member with the room\'s people and the prompt', r.answer && got.member.slug === 'nora' && got.people.includes('Mara') && /the glaze\?/.test(got.prompt), got && { people: got.people });
PL.configureLookup(null);

// ─── it may read memory and nothing else ─────────────────────────────────────
const mcp = readFileSync(new URL('../../apps/workspace-api-mcp/index.js', import.meta.url), 'utf8');
const names = [...new Set([...mcp.matchAll(/name: '([a-z_]+)'/g)].map(m => m[1]))].filter(n => n !== 'ask_my_memory');
const denied = new Set(PL.DENIED_TOOLS.map(t => t.replace('mcp__workspace-api__', '')));
const missing = names.filter(n => !denied.has(n) && !PL.ALLOWED_TOOLS.includes(n));
ok('every workspace-api tool is either a memory read or denied to the one-shot', missing.length === 0, missing);
ok('the memory reads are not denied', !PL.ALLOWED_TOOLS.some(n => denied.has(n)));

// ─── the group prompt offers the tool to a roster member only ────────────────
const ctx = [{ role: 'user', message_id: '1', who: 'Nora', text: 'what did we agree with Harbor Glaze?' }];
const asMember = groupTurnParams(getGroup('-100777'), ctx, { message_id: '1', from_id: '1110001', who: 'Nora', text: 'what did we agree with Harbor Glaze?' });
ok('a roster member\'s turn is told about ask_my_memory, for their own matters only', asMember.actor === 'nora' && /THEIR OWN MEMORY, SAID HERE/.test(asMember.message) && /ask_my_memory/.test(asMember.message) && /that person's memory is never reachable from here, whoever asks/.test(asMember.message));
const asStranger = groupTurnParams(getGroup('-100777'), ctx, { message_id: '1', from_id: '9999999', who: 'Someone', text: 'what did we agree?' });
ok('an unknown sender\'s turn is not', asStranger.actor === 'team' && !/ask_my_memory/.test(asStranger.message));
ok('a member is told their own things are theirs to share here, once-only pushback, never another person\'s', /THEIR OWN THINGS ARE THEIRS TO SHARE/.test(asMember.message) && /when they ask again, say it here, in full/.test(asMember.message) && /never covers anything about another person/.test(asMember.message));
ok('...an unknown sender is not', !/THEIR OWN THINGS/.test(asStranger.message));
ok('nothing of the sender\'s own (not even their time zone) is put into the room\'s shared session', !/own time zone/.test(asMember.message) && !/Time zone:/.test(asMember.message));
ok('the member\'s own memory is the turn\'s first step for every message, never for another person', /Your FIRST step for this message/.test(asMember.message) && /never when anyone asks about ANOTHER person/.test(asMember.message));
ok('...and "not on record" is never said before it has returned', /before it has returned/.test(asMember.message));
ok('a question about themselves is answered in the room, not sent to a DM: the DM path is for private work or when they ask for it', /private WORK on their own files/.test(asMember.message) && /even when it touches private things: answer it here/.test(asMember.message) && !/their personal data\), emit/.test(asMember.message));
ok('...and the room turn says only the part that answers, now and later', /say only the part that answers what they asked/.test(asMember.message));
{
  const guestRoom = groupTurnParams(getGroup('-100888'), ctx, { message_id: '1', from_id: '1110001', who: 'Nora', text: 'what is my door code?' });
  ok('secrets are the one exception in every room, even when their owner insists: they go to the DM', /ONE EXCEPTION, in every room/.test(guestRoom.message) && /ONE EXCEPTION, in every room/.test(asMember.message) && /even when its owner insists/.test(asMember.message) && /send it to their DM/.test(asMember.message));
}
ok('a secret that is not the asker\'s is not sent anywhere and no DM is promised', /When it is not theirs/.test(asMember.message) && /promise no DM/.test(asMember.message));

// the exchange a short follow-up belongs to
{
  const { exchangeFor } = await import('./integrations/group-watcher.js');
  const hist = [
    { role: 'user', message_id: '1.0', from_id: 'U1', text: "what does Stanislaw think of Marek's drafts?" },
    { role: 'assistant', message_id: '1.5', text: "That's Stanislaw's call, ask him." },
    { role: 'user', message_id: '2.0', from_id: 'U2', text: 'tell what i think' },
  ];
  const q = exchangeFor(hist, hist[2]);
  ok('a bare follow-up carries the reply it follows', q.startsWith('tell what i think') && /Marek's drafts|Stanislaw's call/.test(q), q);
  const th = [
    { role: 'user', message_id: '5.0', from_id: 'U2', text: 'what do you know about me?' },
    { role: 'assistant', message_id: '5.5', thread_id: '5.0', text: 'That is a lot for a channel; your DM?' },
    { role: 'user', message_id: '6.0', thread_id: '5.0', from_id: 'U2', text: 'text me here' },
  ];
  const q2 = exchangeFor(th, th[2]);
  ok('in a thread: the thread\'s opening message and the bot\'s reply in it', /what do you know about me/.test(q2) && /your DM/.test(q2), q2);
}

// the lookup started beside the turn is what the turn's first call gets, once
{
  let calls = 0;
  PL.configureLookup(async () => { calls++; return { answer: 'You want to finish it on November 3.' }; });
  PL.prefetchMine({ member: nora, question: 'when did I want to finish the draft?', room: getGroup('-100777') });
  const early = PL.takePrefetched('-100777', 'nora');
  ok('the prefetched lookup is handed over', !!early && (await early).answer === 'You want to finish it on November 3.' && calls === 1);
  ok('...once: the next call in the turn asks afresh', PL.takePrefetched('-100777', 'nora') === null);
  ok('...and it is per person: nobody else gets it', (PL.prefetchMine({ member: nora, question: 'x', room: getGroup('-100777') }), PL.takePrefetched('-100777', 'mara')) === null);
  PL.configureLookup(null);
}

ok('the private fence is unchanged', /NO private space is reachable/.test(asMember.message) && asMember.groupContext === true);

console.log(`private-lookup: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

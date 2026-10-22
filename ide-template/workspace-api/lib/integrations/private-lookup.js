/**
 * private-lookup — a verified member's own memory, asked from a team room.
 *
 * In a Slack channel or a Telegram group the bot knows the room and the team's
 * shared memory, never anyone's private memory: the room's session is one
 * conversation shared by every sender, and what one turn reads another turn
 * can recite. A member who asks "what did we agree with R-PAC?" in the room
 * still wants the fact they told the bot in their own chat — said here, to
 * the team, now.
 *
 * So the group brain gets a tool (`ask_my_memory`, apps/workspace-api-mcp),
 * and the tool runs a ONE-SHOT private turn AS that member (their own scopes,
 * no group context, no session, memory reads only) that answers the question
 * in at most three sentences fit for the room. Only that answer enters the
 * group session; the search results stay in the one-shot. Who may ask is
 * decided in code by the route (routes/memory-v4.js, `/internal/memory/v4/mine`):
 * the turn's token names the sender, the roster vouches for them, the room
 * must be the team's. What is SAID is the one-shot's judgement: anything about
 * a person in the room is left out unless the question names them — silently,
 * because "that's about X, ask me privately" would itself tell X.
 *
 * The same path serves Slack and Telegram: both rooms go through the group
 * watcher, and the difference is only how the room's people are known.
 */
import { runClaudeTurn } from '../claude.js';
import { list as rosterList, userByChatId, userBySlackId } from '../team.js';
import { groupIdKind } from '../group-id.js';

const LOOKUP_TIMEOUT = Number(process.env.GROUP_LOOKUP_TIMEOUT_MS) || 120_000;

// The one-shot reads memory and nothing else: every other workspace-api tool
// is denied (it never writes, sends, or looks at the person's other surfaces).
export const ALLOWED_TOOLS = ['memory_search', 'memory_timeline'];
export const DENIED_TOOLS = [
  'memory_write', 'memory_note', 'memory_forget', 'memory_import', 'memory_grep', 'memory_log', 'memory_now',
  'recent_messages', 'fix_sent_message', 'set_my_settings', 'add_routine', 'use_integrations',
  'tab_act', 'tab_screenshot', 'tab_snapshot',
].map(n => `mcp__workspace-api__${n}`);

let runner = null;
/** Replace the one-shot (tests): `fn({ member, question, room, people, prompt }) → { answer, nothing }`. */
export function configureLookup(fn) { runner = fn; }

/** People in the room who are not on the roster, by name — Slack from the audience check, Telegram from the members seen. */
export function outsidersOf(group) {
  if (!group) return [];
  if (groupIdKind(group.chatId) === 'slack') {
    const a = group.audience;
    if (!a || a.ok !== false) return [];
    return (a.outsiders || []).map(o => (typeof o === 'string' ? o : o?.name || o?.id || 'someone'));
  }
  const out = [];
  for (const [id, name] of Object.entries(group.members || {})) if (!userByChatId(id)) out.push(name || id);
  return out;
}

/** Everyone the room is known to hold, by the name the roster (or the room) gives them. */
export function peopleInRoom(group) {
  const names = new Set();
  const slack = groupIdKind(group?.chatId) === 'slack';
  for (const [id, name] of Object.entries(group?.members || {})) {
    const m = slack ? userBySlackId(id) : userByChatId(id);
    names.add(m ? (m.displayName || m.slug) : (name || id));
  }
  for (const o of outsidersOf(group)) names.add(o);
  return [...names].filter(Boolean);
}

export function lookupPrompt({ member, question, room, people = [] }) {
  const name = member.displayName || member.slug;
  const others = people.filter(p => p !== name);
  return [
    `[PRIVATE LOOKUP — asked in the team room "${String(room?.title || room?.chatId || 'the room').slice(0, 60)}"] ${name} asked there, in front of the team, about something that may be in THEIR OWN memory — the conversations you have had with them. Answer from their memory, for the room to read.`,
    '',
    `THE QUESTION, as ${name} asked it: ${String(question).slice(0, 500)}`,
    `PEOPLE IN THE ROOM besides ${name}: ${others.length ? others.join(', ') : 'nobody else recorded'}`,
    '',
    'RULES:',
    `- Search their memory (memory_search, memory_timeline) and answer in at most three plain sentences, in the language of the question, with the names, numbers and dates the memory holds. Facts only: no advice, no questions back, no suggestions.`,
    `- Leave out anything ABOUT a person in the room — what they earn, their health, their work, their performance, what ${name} thinks of them — unless the question names that person. Never say that something was left out and never hint at it.`,
    `- Leave out anything ${name} asked to keep quiet or private, whoever it concerns.`,
    '- If their memory holds nothing that answers the question, reply with exactly: NOTHING',
    '- Your whole output is the answer. No preamble, no mention of memory, tools or this task.',
  ].join('\n');
}

/** The one-shot's text → what the room may hear. */
export function parseAnswer(text) {
  const t = String(text || '').trim();
  if (!t) return { failed: true };
  if (/^\**\s*NOTHING\s*\**\.?$/i.test(t)) return { nothing: true };
  // A reply that starts with the word and goes on is still a nothing ("NOTHING — I have no …").
  if (/^\**\s*NOTHING\b/i.test(t)) return { nothing: true };
  return { answer: t.slice(0, 1200) };
}

/**
 * Ask a member's own memory one question, as them, in a one-shot turn.
 * Returns `{ answer }`, `{ nothing: true }` or `{ failed: true }` — never a guess.
 */
export async function lookupMine({ member, question, room }) {
  const people = peopleInRoom(room);
  const prompt = lookupPrompt({ member, question, room, people });
  if (runner) return runner({ member, question, room, people, prompt });
  const text = await new Promise((resolve) => {
    let out = '', lastSegment = '', done = false, proc = null;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { proc && proc.kill('SIGKILL'); } catch { /* gone */ } resolve(r); };
    const timer = setTimeout(() => finish(null), LOOKUP_TIMEOUT);
    try {
      proc = runClaudeTurn({
        message: prompt,
        actor: member.slug,
        actorName: member.displayName || member.slug,
        actorIsAdmin: member.role === 'admin',
        teammates: [],
        onlyMcp: [],                  // workspace-api alone, no built-in tools
        disallowedTools: DENIED_TOOLS,
        // Only the text after the last tool call is the answer (the model
        // narrates between calls; runPrivateDelegate learnt this the hard way).
        onText: (t) => { out += t; },
        onToolStart: () => { if (out.trim()) lastSegment = out; out = ''; },
        onToolEnd: () => {}, onImage: () => {},
        onError: () => finish(null),
        onDone: () => finish((out.trim() ? out : lastSegment).trim()),
      });
    } catch { finish(null); }
  });
  if (text == null) return { failed: true };
  return parseAnswer(text);
}

/** The roster entry a turn's actor names, or null. */
export function memberBySlug(slug) {
  if (!slug || slug === 'team') return null;
  return rosterList().find(m => m.slug === slug) || null;
}

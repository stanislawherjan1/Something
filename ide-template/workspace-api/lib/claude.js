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
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CLAUDE_BIN, PROJECT_DIR } from './config.js';
import { hasClaudeToken, readClaudeToken } from './setup.js';
import { buildCachedPrefix, buildTeamPrefix, buildCachedPrefixV4 } from './memory-loader.js';
import { v4Mode, readableScopes } from './memory-ledger.js';
import { rulesCard, now as liveStatuses, readDigest } from './memory-views.js';
import { readRoutines } from './routines-store.js';
import { routinesOwner } from './memory-v4-writes.js';
import { syncMcpServers } from './integrations/runtime.js';
import { primaryAdminSlug, memberGroupsOf, getTeamMode, list as teamList, getDefaultTimezone } from './team.js';
import { buildRecallBlock, withRecall } from './memory-recall.js';
import { limitNotice } from './usage-limit.js';
import { resolve as resolveBranding } from './branding.js';
import { issueTurnToken, revokeTurnToken } from './turn-identity.js';

// mcpServers config for the web chat's claude (written by syncMcpServers).
// How much of claude's stderr to keep for diagnosing a failed turn.
const STDERR_TAIL_MAX = 4000;

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
/**
 * Build this turn's cached memory prefix. Exported (and pure apart from disk
 * reads) so the group-privacy guard test can exercise the SAME code the spawn
 * path uses — the previous hand-written exclusion list drifted from the card
 * registry and leaked a private RESPONSIBILITIES card into group prompts, and a
 * test that rebuilt the list itself would have missed it.
 *
 *  - GROUP turn → buildTeamPrefix: no actor + the ENTIRE user tier excluded.
 *    A group reply is public to the chat and the session is shared across turns
 *    run as different senders, so nothing private may be preloaded — not even
 *    the sender's own. This is the structural boundary; the scope-guard hook
 *    closes the other door (private reads at tool time).
 *  - 1:1 turn → buildCachedPrefix with the actor, so the USER-tier cards come
 *    from memory/users/<slug>/.
 *      · RECENT_WEB is always excluded: each web session resumes its own Claude
 *        session, so a rolling tail of OTHER web conversations is same-surface
 *        bleed with no upside.
 *      · RECENT_TELEGRAM is the bot's ONE Telegram conversation = the OPERATOR's
 *        DMs (single token, not per-user). Cross-surface awareness is a feature
 *        for THAT person; loading it into another teammate's prefix would leak
 *        the operator's private chats — so it is included only for the operator.
 */
export function buildTurnPrefix({ actor, groupContext, groupId = null, isTgOperator, callerExcludeIds, memoryDir } = {}) {
  const caller = Array.isArray(callerExcludeIds) ? callerExcludeIds : [];
  // Memory v4 reading: a small prefix — the product rules, identity cards, the
  // person's routines and the standing rules they stated. What they said before
  // arrives per turn with the message (lib/memory-recall.js), not in here.
  if (['read', 'on'].includes(v4Mode())) {
    if (groupContext) {
      const gid = /^-\d{4,20}$/.test(String(groupId || '')) ? String(groupId) : null;
      return buildCachedPrefixV4({ memoryDir, extraCards: [
        { id: 'STANDING_RULES', body: gid ? rulesCard([`group:${gid}`]) : '' },
        { id: 'WHAT_IS_GOING_ON', body: gid ? groupGoingOnCard(gid) : '' },
      ] });
    }
    const me = actor && actor !== 'default' ? actor : primaryAdminSlug();
    return buildCachedPrefixV4({ memoryDir, actor: me, flatPersonal: !getTeamMode(), extraCards: [
      { id: 'MY_SETTINGS', body: settingsCard(me) },
      { id: 'ROUTINES', body: routinesCard(me) },
      { id: 'STANDING_RULES', body: rulesCard([`user:${me}`]) },
      { id: 'WHAT_IS_GOING_ON', body: goingOnCard(me) },
    ] });
  }
  if (groupContext) {
    // buildTeamPrefix adds every USER_TIER id itself, derived from the card
    // registry — so a new private card is fenced out of groups the day it is
    // added, without anyone remembering to update a list here.
    return buildTeamPrefix({ memoryDir, excludeIds: caller });
  }
  const excludeIds = isTgOperator
    ? ['RECENT_WEB', ...caller]
    : ['RECENT_WEB', 'RECENT_TELEGRAM', ...caller];
  return buildCachedPrefix({ memoryDir, excludeIds, actor });
}

/**
 * The person's time zone and reply language, from Settings. The bot changes
 * them (set_my_settings) when the person asks or plainly says they are now
 * somewhere else — unless they locked it in Settings.
 */
/** " (it was <weekday, date, time> there when this was written)" — so a run never has to guess the hour. */
function localNow(tz) {
  try {
    return ` (it was ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date())} there when this was written)`;
  } catch { return ''; }
}

export function settingsCard(slug) {
  try {
    const m = teamList().find(x => x.slug === slug);
    const tz = m?.timezone || getDefaultTimezone();
    const lock = (on) => (on ? ' Locked by the person — you can\'t change it; they can in Settings.' : '');
    return [
      `Time zone: ${tz}${m?.timezone ? '' : ' (the workspace default — they haven\'t set their own)'}.${lock(m?.timezoneLocked)}`,
      `Reply language: ${m?.preferredLanguage || 'the language of each message'}.${lock(m?.languageLocked)}`,
      `Times you say, plan or schedule are in this time zone; get the local time with \`TZ=${tz} date\`${localNow(tz)}.`,
      'When they ask you to change either, or plainly say they are now in another time zone, call set_my_settings with a short why.',
    ].join('\n');
  } catch { return ''; }
}

/**
 * What is going on for this person — the Memory screen's Short-term memory as
 * the bot sees it: statuses still in force, then the digest (one line per
 * thing they are keeping track of, with its state). Without it the bot could
 * not answer "what am I keeping track of?" although the screen showed it.
 * Last of the extra cards: it changes nightly, the ones before it rarely.
 */
export function goingOnCard(slug) {
  let scopes = [`user:${slug}`, 'shared'];
  try { scopes = readableScopes({ actor: slug, memberGroups: memberGroupsOf(slug) }); } catch { /* the two above */ }
  return goingOnFor({ key: `user:${slug}`, scopes, whose: 'this person (their Short-term memory on the Memory screen)', they: 'they' });
}
/**
 * The same for a group turn: the group's own digest (rendered nightly from
 * shared + that group, never anyone's private memory) and the live statuses
 * in those two scopes. Without it the group brain answered "is X dead?" from
 * old shared pages while the group's digest said "closed on the 29th".
 */
function groupGoingOnCard(gid) {
  return goingOnFor({ key: `group:${gid}`, scopes: ['shared', `group:${gid}`], whose: 'this group (its shared memory)', they: 'the team' });
}
function goingOnFor({ key, scopes, whose, they }) {
  const lines = [];
  try {
    const live = liveStatuses(scopes);
    if (live.length) lines.push('Right now:', ...live.map(s => `- ${s.text}${s.expires ? ` (until ${s.expires})` : ''}`));
    const d = readDigest(key);
    if (d.items?.length) lines.push(`What ${they} are keeping track of${d.at ? ` (as of ${String(d.at).slice(0, 10)})` : ''}:`, ...d.items.map(i => `- ${i.name} (${i.state || 'active'}): ${i.line}`));
  } catch { return ''; }
  if (!lines.length) return '';
  return [`What is going on for ${whose}:`, ...lines].join('\n');
}

/**
 * How to run any routine — said once here instead of in every routine's text.
 * A routine is the bot's duty: the planner turns it into reminders FOR THE BOT,
 * and each run follows the routine's full instruction plus these rules.
 */
const ROUTINE_RULES = [
  'The list below IS the person\'s routines (their Routines page, Marketplace ones included). Reminders are not routines: a reminder is one firing the planner set, and a routine without a reminder today is still a routine. Before saying a routine does not exist or offering to add one, read this list (memory_now has the current copy).',
  'How to run them (every routine, every run):',
  '- Silence: message the person only if the result would change what they do; otherwise send nothing — never "nothing to report".',
  '- State: keep each routine\'s working notes (snapshots of the board, baselines, ids already reported, the person\'s one-time answers) in the workspace file `.routines/<routine title in kebab-case>.md` (team mode: under the person\'s own folder). Read it at the start of a run, update it at the end.',
  '- Never report the same item twice unless it changed.',
  '- If a routine needs something only the person knows (which people, pages, competitors…), look in its notes first; if missing, ask once in a normal message, save the answer, and skip this run.',
  '- No side effects on your own: never send, post, publish, archive, delete, pay, refund, pause, change budgets or trigger a platform\'s reminders. Prepare a draft (create_draft for mail, otherwise in the chat or a workspace file) and say where it is; act only after the person says yes, only on what you showed.',
  '- If a source the routine needs isn\'t connected or errors, tell the person once and stop; don\'t guess.',
  '- "Off" / "unusual" means more than 30% from the same-weekday average of the last 4 weeks (at least 10 events), unless the routine says otherwise; build that baseline in the notes when a tool can\'t return history.',
  '- When two routines would report the same item, report it once.',
].join('\n');

/** The person's routines (routines.json) as a card: what the bot does for them. */
export function routinesCard(slug) {
  let list = [];
  try { list = readRoutines(routinesOwner(slug)).routines.filter(r => !r.retired); } catch { return ''; }
  if (!list.length) return '';
  return ['Your standing duties toward this person (they manage these on their Routines page).',
    ROUTINE_RULES,
    ...list.map(r => `- ${r.title}${r.description ? ` — ${String(r.description).replace(/\s+/g, ' ').slice(0, 1500)}` : ''}`)].join('\n');
}

// The model every web turn runs on: the one the bot is pinned to
// (bootstrap/claude-settings.json, which entrypoint merges into the bot's
// settings). workspace-api's own user has no settings file, so without this
// the web chat and the side panel ran on the CLI's built-in default — an older
// model than the Telegram bot's. IDE_WEB_MODEL overrides it.
const BOOTSTRAP_SETTINGS = '/opt/ide/bootstrap/claude-settings.json';
let webModel;
function turnModel() {
  if (webModel === undefined) {
    webModel = process.env.IDE_WEB_MODEL || '';
    if (!webModel) {
      try { webModel = String(JSON.parse(readFileSync(BOOTSTRAP_SETTINGS, 'utf8')).model || ''); } catch { webModel = ''; }
    }
  }
  return webModel;
}
// A turn that operates the browser tab takes many small steps, each waiting on
// the model; less deliberation per click keeps it moving. IDE_ACT_EFFORT
// overrides it.
const ACT_EFFORT = process.env.IDE_ACT_EFFORT || 'medium';

export function runClaudeTurn({ tabToken, actTurn = false, systemNote = '', message, sessionId, webSessionId, relayThread, actor, actorName, actorIsAdmin, teammates, excludeIds: callerExcludeIds, groupContext, groupId = null, recallQuery = null, recallHistory = [], disallowedTools, onlyMcp = null, onText, onToolStart, onToolEnd, onImage, onError, onDone }) {
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

  // A turn whose OUTPUT the system delivers must not also hold tools that can
  // deliver. Otherwise both fire: the model sends the answer with a tool, its
  // closing text becomes a report about that send, and the system delivers the
  // report as a second message. Prompting against it is not enough — the model
  // reads a narrow ban narrowly — so the tools are taken away instead.
  // A turn in which the assistant may operate the user's browser tab (the panel
  // is in Act). A web page can try to steer it (prompt injection), so the turn
  // gets an allow-list, not the full toolbox: the tab tools and read-only
  // workspace access, nothing that can send, publish, fetch, run commands or
  // write — so whatever a page talks it into, it cannot carry anything out of
  // the browser or plant instructions for later turns. Only workspace-api-mcp is
  // loaded (strict MCP config); if its entry cannot be read, NO MCP server is.
  // AskUserQuestion opens an interactive picker: a -p turn has no terminal to
  // show it, so the call fails and the chat shows an error chip instead of the
  // question. The product asks in plain words anyway — no pickers in a
  // conversation — so the tool is never offered here.
  const blocked = ['AskUserQuestion', ...(Array.isArray(disallowedTools) ? disallowedTools : [])];
  // A page turn — started from the browser panel with the page shared, Look
  // or Act — reads a web page, and a page can carry injected instructions. So
  // it holds nothing a page could turn against the user: no built-in tools at
  // all (no file reads, shell, web), only the workspace-api MCP, and of that
  // only the tab tools and use_integrations — the hand-off to a turn that has
  // the integrations and never sees the page (lib/tab-handoff.js). The user's
  // memory cards are still in the prompt; only reaching further is gone.
  const pageTurn = !!tabToken;
  let actMcpFile = null;
  // `--tools ''` was supposed to drop every built-in tool from a restricted
  // turn, and the model still ran shell commands through Monitor (an import
  // turn, 170 calls, to read a transcript it was not allowed to). So every
  // built-in is also refused by name — the belt under the braces.
  const NO_BUILTINS = ['Bash', 'BashOutput', 'KillShell', 'Monitor', 'Agent', 'Task', 'Workflow', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS',
    'WebFetch', 'WebSearch', 'Skill', 'TaskStop', 'TaskOutput', 'TodoWrite', 'ToolSearch', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup',
    'EnterWorktree', 'ExitWorktree', 'EnterPlanMode', 'ExitPlanMode', 'SendMessage', 'ListAgents', 'RemoteTrigger', 'PushNotification', 'Artifact'];
  if (pageTurn) {
    let servers = {};
    try {
      const entry = JSON.parse(readFileSync(BOT_CLAUDE_CONFIG, 'utf8'))?.mcpServers?.['workspace-api'];
      if (entry) servers = { 'workspace-api': entry };
    } catch (err) {
      process.stderr.write(`[claude] page turn: no MCP config (${err.message}) — running with none\n`);
    }
    actMcpFile = join(tmpdir(), `page-turn-${randomUUID()}.json`);
    writeFileSync(actMcpFile, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    args[args.indexOf('--mcp-config') + 1] = actMcpFile;
    args.push('--strict-mcp-config');
    args.push('--tools', '');
    blocked.push(...NO_BUILTINS,
      'mcp__workspace-api__memory_write', 'mcp__workspace-api__memory_grep', 'mcp__workspace-api__memory_log',
      'mcp__workspace-api__recent_messages', 'mcp__workspace-api__fix_sent_message',
    );
  }
  // A turn that must reach only a few MCP servers (the night memory import:
  // the person's notetakers and the memory tools) gets a config of those
  // alone, strict, and no built-in tools — nothing to run, read or write with.
  let onlyMcpFile = null;
  if (!pageTurn && Array.isArray(onlyMcp)) {
    let servers = {};
    try {
      const all = JSON.parse(readFileSync(BOT_CLAUDE_CONFIG, 'utf8'))?.mcpServers || {};
      for (const name of ['workspace-api', ...onlyMcp]) if (all[name]) servers[name] = all[name];
    } catch (err) {
      process.stderr.write(`[claude] restricted turn: no MCP config (${err.message}) — running with none\n`);
    }
    onlyMcpFile = join(tmpdir(), `only-mcp-${randomUUID()}.json`);
    writeFileSync(onlyMcpFile, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    args[args.indexOf('--mcp-config') + 1] = onlyMcpFile;
    args.push('--strict-mcp-config');
    args.push('--tools', '');
    blocked.push(...NO_BUILTINS, 'mcp__workspace-api__memory_write', 'mcp__workspace-api__memory_forget', 'mcp__workspace-api__memory_note', 'mcp__workspace-api__web_send_message', 'mcp__workspace-api__add_routine', 'mcp__workspace-api__set_my_settings');
  }
  args.push('--disallowedTools', blocked.join(','));
  if (turnModel()) args.push('--model', turnModel());
  if (actTurn && ACT_EFFORT) args.push('--effort', ACT_EFFORT);

  // Memory cached prefix — ≥4096 token block from project/memory/ so
  // Anthropic's prompt cache fires (otherwise nothing is cached and every
  // turn pays full input tokens). Failures here are non-fatal: we log and
  // continue without the prefix, claude still works just without cache hit.
  try {
    const prefix = buildTurnPrefix({
      actor,
      groupContext,
      groupId,
      isTgOperator: actor === primaryAdminSlug(),
      callerExcludeIds,
      memoryDir: join(PROJECT_DIR, 'memory'),
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
  if (groupContext && actor && actor !== 'default') {
    // GROUP-CONTEXT [ACTOR] variant: attribution WITHOUT the private-profile
    // plumbing. The 1:1 block below instructs the model to lean on USER_* cards
    // — which are deliberately absent from a group prefix — and describes the
    // sender's private tree as reachable, which in a group turn it is not.
    const me = actorName || 'this teammate';
    const who = actorName ? `${actorName} (slug: ${actor})` : `slug: ${actor}`;
    args.push('--append-system-prompt',
      `[ACTOR ${who}] You are replying in a shared GROUP conversation; the message you are answering was written by ${me}. "I", "me", "my" in that message mean ${me}. ` +
      `This is a SHARED context: you act on the shared workspace (the project root) only. NO private space is accessible here — not other teammates' and not ${me}'s own (their profile cards are not loaded and private paths are blocked): the group context is shared, so nothing private may enter it. ` +
      `If ${me} asks for something that needs THEIR OWN private files, notes, or memory, emit the [[PRIVATE_TASK ...]] marker (per your instructions) so it runs privately and reaches them in a DM — never try to read private paths here, and never present a guess as their private data.`);
  } else if (actor && actor !== 'default') {
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
        `web_send_message is the ONLY way to reach a teammate from here — use it EVEN when the user says "on Telegram": there is NO separate Telegram tool on this surface. By default the recipient gets the message on whichever channel THEY prefer (their workspace always; their Telegram if that's their preference). But if the user EXPLICITLY names a channel ("on Telegram", "in their workspace"), pass channel="telegram" or channel="web" to web_send_message to honor it — that OVERRIDES the recipient's default. (The same applies to messaging the CURRENT user: "message me on Telegram" → web_send_message with channel="telegram" and no recipient.) ` +
        `NEVER tell ${me} you sent or passed something on unless you ACTUALLY called web_send_message and it returned success — do not narrate a send you didn't make. The tool result says WHERE it landed; relay that truthfully (if it says web only, tell ${me} it's in the teammate's workspace, don't claim Telegram). ` +
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

    // B3 v2 — relay-thread awareness. If THIS session is a relay channel, the
    // user is mid-conversation WITH the paired teammate(s) through you. Without
    // this, the bot reads a short "yes, I have it" as a remark to itself and the answer never
    // gets back to the asker — the exact failure this fixes.
    const peers = Array.isArray(relayThread) ? relayThread.filter(p => p && p.slug) : [];
    if (peers.length) {
      const peerList = peers.map(p => `${p.name} (slug: ${p.slug})`).join(', ');
      args.push('--append-system-prompt',
        `[RELAY THREAD] This conversation is a live relay channel between ${me} and ${peerList}. ` +
        `${me} is talking WITH them THROUGH you — you're the courier. Earlier in this thread you delivered a message from them; ${me}'s messages here are part of that exchange, NOT remarks to you. ` +
        `So when ${me} answers or reacts to what the teammate said ("yes, I do", "ok, tell them that…", a yes/no, a counter-question for them), relay it straight back to that teammate IMMEDIATELY via web_send_message (recipient = their slug), composed naturally in their language, then confirm to ${me} in one line. Do NOT ask "do you want me to pass that on?" for a clear answer — just pass it on. Keep using this same thread. ` +
        `Only handle a message yourself (without relaying) when ${me} is plainly addressing YOU — e.g. asking what you meant, a side request, or troubleshooting. If you're genuinely unsure whether a line is for the teammate or for you, ask in one short question; but a direct answer to their question should just go back.`);
    }
  }

  // Rules for this kind of turn (the browser panel's, from routes/chat.js) go
  // into the system prompt: in the user's message a page could pose as them,
  // and the model rightly distrusted a rule that changed mid-conversation there.
  if (systemNote) args.push('--append-system-prompt', String(systemNote));

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
  // The CLI's own auto-memory (~/.claude/projects/*/memory/MEMORY.md) is a
  // second memory beside this product's, and it answered "what do you remember"
  // with notes from months ago. settings.json switches it off for the bot's
  // home, but a web turn runs under wsapi's home, which has no settings file;
  // the env var holds whatever the home.
  childEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
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
  // Group-context flag for the scope-guard hook: hard-blocks ALL private trees
  // (including the sender's own and an admin's) — see hooks/scope-guard.mjs.
  if (groupContext) childEnv.IDE_GROUP_CONTEXT = '1';
  // Proof of who this turn is, for the memory routes (lib/turn-identity.js):
  // they take the actor and group flag from this token, never from a header.
  const turnId = issueTurnToken({ actor, group: !!groupContext, groupId });
  childEnv.IDE_TURN_ID = turnId;
  // A turn started from the browser extension's panel carries a one-turn token
  // that lets the tab tools reach the user's tab (routes/tab.js). No other turn
  // — Telegram, workspace chat, reminders, groups — ever gets one.
  if (tabToken) childEnv.IDE_TAB_TOKEN = String(tabToken);
  // A page turn gets use_integrations; the hand-off turn has neither flag, so
  // it cannot hand off again.
  if (pageTurn) {
    childEnv.IDE_PAGE_TURN = '1';
    // Nothing secret in a turn that reads web pages: the server's own keys
    // (session signing, OAuth clients, integration tokens) are dropped from its
    // environment. Only the CLI's own credential stays — it cannot run without
    // it, and with no built-in tools nothing in the turn can read it.
    for (const k of Object.keys(childEnv)) {
      if (k === 'CLAUDE_CODE_OAUTH_TOKEN' || k === 'IDE_TAB_TOKEN') continue;
      if (/SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|_KEY$|CREDENTIAL|PRIVATE/i.test(k)) delete childEnv[k];
    }
    // Load every tool up front. With tool search the CLI shows only tool
    // NAMES and the model must look each one up first: an Act turn then spent
    // calls finding tab_act's schema, and missed use_integrations entirely
    // (looked it up by the wrong name) and asked the user to switch Act off.
    // An Act turn has a handful of tools, so there is nothing to save.
    childEnv.ENABLE_TOOL_SEARCH = 'false';
  }

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: PROJECT_DIR,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Memory v4 (MEMORY_V4=read|on): the most relevant past excerpts go in FRONT
  // of the message — the user message, not the system prompt, which would void
  // the cached prefix. The CLI is already starting while the search runs; stdin
  // is written when it answers, within the recall budget. Group turns read
  // shared + that group only; page turns get nothing (lib/memory-recall.js).
  proc.stdin.on('error', () => { /* the CLI died first — its exit is reported below */ });
  (async () => {
    let recall = { block: null };
    try {
      const me = actor && actor !== 'default' ? actor : primaryAdminSlug();
      recall = await buildRecallBlock({
        actor: groupContext ? null : me,
        groupId: groupContext ? groupId : null,
        memberGroups: groupContext ? [] : memberGroupsOf(me),
        pageTurn,
        sessionKey: webSessionId || sessionId || null,
        message: recallQuery ?? message,   // the person's own words when the caller wrapped them
        history: recallHistory,
      });
    } catch (err) {
      process.stderr.write(`[claude/recall] ${err.message}\n`);
    }
    try { proc.stdin.write(withRecall(recall.block, message)); proc.stdin.end(); } catch { /* gone */ }
  })();

  let buffer = '';
  let capturedSessionId = sessionId || null;
  // Track whether any text has been sent this turn so we can inject a
  // paragraph break when a second text block starts (e.g. after a tool call).
  let hasStartedText = false;
  // `resetsAt` from the first rejection of this turn, or true when the CLI
  // rejected without one. Read on close: a spent plan makes claude exit
  // non-zero, and the generic "exited with code 1 :: <stderr>" is what a
  // person was being shown instead of the reason.
  let limitRejectedAt = null;
  // tool_use id → tool name, captured at content_block_start. Lets us skip
  // forwarding images from `Read` tool results: those are the user's own
  // pasted/attached image being read back, and echoing it into the assistant
  // bubble is noise. The same goes for the extension's tab_screenshot: the user
  // is looking at that tab already, the tool pill says the bot looked too.
  // Genuine tool images (Playwright screenshots) still show.
  const toolNamesById = new Map();
  const shouldForwardImage = (toolUseId) => {
    const name = toolNamesById.get(toolUseId);
    return name !== 'Read' && name !== 'mcp__workspace-api__tab_screenshot';
  };

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
        // The plan is spent. The CLI reports this as a structured event and no
        // longer prints it into the reply, so usage-limit.js's regexes — which
        // read the output — stopped seeing it, the turn produced no text, and
        // the bot simply went quiet. The reset time was in this event the whole
        // time, being discarded one line below as an unknown type.
        //
        // `status` distinguishes a real rejection from a warning; only a
        // rejection means nothing will come back.
        if (evt.type === 'rate_limit_event') {
          const info = evt.rate_limit_info || {};
          if (info.status === 'rejected' && !limitRejectedAt) {
            limitRejectedAt = info.resetsAt || true;
            process.stderr.write(`[claude/rate-limit] ${info.rateLimitType || 'limit'} rejected, resets ${info.resetsAt || '?'}\n`);
          }
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

  // Keep the tail of claude's own stderr. Without it a failed turn reached the
  // caller as a bare "exited with code 1", so every non-zero exit had to be
  // GUESSED at — the group brain reported plain crashes to the chat as "usage
  // limit exhausted", and the reset time the CLI actually prints was thrown
  // away. Bounded, and never shown to a user raw: callers parse it.
  let stderrTail = '';
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_MAX);
    process.stderr.write(`[claude] ${text}`);
  });

  proc.on('error', (err) => { revokeTurnToken(turnId); onError(`spawn failed: ${err.message}`); });

  proc.on('close', (code, signal) => {
    revokeTurnToken(turnId);
    if (actMcpFile) { try { unlinkSync(actMcpFile); } catch { /* already gone */ } }
    if (onlyMcpFile) { try { unlinkSync(onlyMcpFile); } catch { /* already gone */ } }
    if (code === 0) return onDone({ sessionId: capturedSessionId });

    // A spent plan is not a crash and must not read like one. The turn failed
    // because there is no quota left, and the CLI told us so in a
    // rate_limit_event along with when it returns — so that is the error, in
    // place of "exited with code 1" plus a stderr dump. One message, and the
    // one thing the reader wants to know.
    //
    // The wording keeps "usage limit reached" because group-watcher matches
    // that phrase (usage-limit.js isUsageLimit) to announce once and then stay
    // quiet rather than repeating every retry.
    if (limitRejectedAt) {
      let who = '';
      try { const b = resolveBranding(); who = b.botDisplayName || b.botName || ''; } catch { /* unnamed is fine */ }
      return onError(limitNotice(limitRejectedAt === true ? null : limitRejectedAt, who));
    }

    onError(`claude exited with code ${code}${signal ? `, signal ${signal}` : ''}`
      + (stderrTail.trim() ? ` :: ${stderrTail.trim().slice(-600)}` : ''));
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

/**
 * A turn nobody is talking to — a system job run AS a person (the night memory
 * import): their identity and scope, only the named MCP servers plus the
 * memory tools, no built-in tools, no delivery. Resolves with the reply text
 * once the turn is done; rejects on a spawn error.
 */
const HEADLESS_MINUTES = Number(process.env.MEMORY_IMPORT_TURN_MINUTES) || 30;
export function runHeadlessTurn({ message, actor, actorName, servers = [], label = 'headless', minutes = HEADLESS_MINUTES }) {
  return new Promise((resolve, reject) => {
    let text = '';
    let failed = null;
    let calls = 0;
    const t0 = Date.now();
    const log = (m) => process.stderr.write(`[claude/${label}] ${actor}: ${m}\n`);
    // Nobody is watching this turn, so its tool calls go to the log — the one
    // place to see what a night's import did — and it cannot run for ever.
    const proc = runClaudeTurn({
      message, actor, actorName: actorName || actor, actorIsAdmin: false, teammates: [],
      onlyMcp: servers,
      onText: (t) => { text += t; },
      onToolStart: (info) => { calls++; log(`tool ${String(info?.name || '?').replace(/^mcp__/, '')} (${Math.round((Date.now() - t0) / 1000)} s)`); },
      onToolEnd: () => {}, onImage: () => {},
      onError: (e) => { failed = e; },
      onDone: () => {
        clearTimeout(timer);
        log(`done: ${calls} tool call${calls === 1 ? '' : 's'}, ${Math.round((Date.now() - t0) / 1000)} s${failed ? `, error: ${String(failed?.message || failed).slice(0, 160)}` : ''}`);
        if (failed && !text) return reject(failed instanceof Error ? failed : new Error(String(failed)));
        resolve(text);
      },
    });
    const timer = setTimeout(() => {
      failed = new Error(`stopped after ${minutes} minutes`);
      log(`stopping after ${minutes} minutes`);
      try { proc?.kill?.('SIGTERM'); } catch { /* already gone */ }
    }, minutes * 60_000);
    timer.unref?.();
  });
}

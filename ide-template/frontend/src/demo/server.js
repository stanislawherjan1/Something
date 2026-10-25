// The demo's backend, in the browser: answers the workspace's /api/* and
// /auth/* calls from the sample data in ./data, so every screen works without
// a server. Writes change state for this tab only and are gone on reload.
// The chat has no answer: the demo has no model behind it.
//
// Ported from the local dev mock (Vite middleware); the handlers keep its
// shapes, which follow workspace-api's routes.

import integrationsCatalog from '../../../workspace-api/integrations.catalog.json';
import routinesCatalog from '../../../workspace-api/routines.catalog.json';
import { PEOPLE, VIEWERS, COMPANY } from './data/cast.js';
import { memoryFor, searchFor } from './data/memory.js';
import {
  FILES, FILE_CONTENT, SESSIONS, HISTORIES, TASKS, REMINDERS, SKILLS,
  INTEGRATIONS, TELEGRAM_GROUPS, SLACK_CHANNELS, LOCKS, BRANDING,
} from './data/workspace.js';
import { inMinutes } from './time.js';
import { getViewer, DEMO_REPLY, SHOWCASE } from './flags.js';
import { showcaseTurn, SHOWCASE_PEOPLE, SHOWCASE_TASKS } from './showcase.js';

const BASE = import.meta.env.BASE_URL;

// ── Who is looking ───────────────────────────────────────────────────────────
const viewer = getViewer();
const isMember = viewer === 'member';
const meSlug = VIEWERS[viewer];
const me = PEOPLE[meSlug];

// ── State for this tab ───────────────────────────────────────────────────────
const clone = (x) => JSON.parse(JSON.stringify(x));
const state = {
  teamMode: true,
  me: { displayName: me.name, preferredLanguage: me.language, languageLocked: false, timezone: 'Europe/Lisbon', timezoneLocked: false, timezoneFrom: 'Settings', timezoneSetAt: inMinutes(-60 * 24 * 20) },
  defaultTz: 'Europe/Lisbon',
  branding: clone(BRANDING),
  tasks: clone(TASKS),
  sessions: clone(SESSIONS[meSlug] || []),
  newSession: 0,
  cancelledReminders: new Set(),
  removedMembers: new Set(),
  madeSkills: [],
  locks: clone(LOCKS),
  routines: null,
  sharing: null,
  catalogAdded: new Set(),
  files: new Map(Object.entries(FILE_CONTENT)),
  tree: clone(FILES),
};
const memory = memoryFor(viewer);

// ── Helpers ──────────────────────────────────────────────────────────────────
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
const notFound = (msg = 'Not in the demo.') => json({ ok: false, error: msg }, 404);
const today = () => new Date().toISOString().slice(0, 10);
function person(slug) {
  const p = PEOPLE[slug];
  return p ? { slug, name: p.name, avatarUrl: p.avatar } : { slug, name: 'a former member', avatarUrl: null, gone: true };
}
function lockOf(path) {
  const parts = path.split('/');
  for (let i = parts.length; i >= 1; i--) {
    const k = parts.slice(0, i).join('/');
    if (state.locks[k]) return { path: k, by: state.locks[k].by, byName: PEOPLE[state.locks[k].by]?.name || 'Nora', inherited: i !== parts.length };
  }
  return undefined;
}
// Another person's private tree is out of reach, as on the server.
function visible(path) {
  const m = /^(?:memory\/)?users\/([^/]+)/.exec(path);
  return !m || m[1] === meSlug;
}

// ── Me, auth, team ───────────────────────────────────────────────────────────
function mePayload() {
  return {
    email: me.email, slug: me.slug, role: me.role, isAdmin: !isMember,
    teamMode: state.teamMode, personalRoot: state.teamMode ? `users/${me.slug}` : null,
    avatarUrl: me.avatar, telegramChatId: me.telegramChatId, preferredSurface: 'both', surfaces: ['web', 'telegram'], slackUserId: me.slackUserId || null,
    ...state.me, defaultTimezone: state.defaultTz, effectiveTimezone: state.me.timezone || state.defaultTz,
  };
}
function teamPayload() {
  const entries = Object.values(PEOPLE)
    .filter((p) => !state.removedMembers.has(p.email))
    // The landing's replay shows a smaller team: the people its conversations name.
    .filter((p) => !SHOWCASE || SHOWCASE_PEOPLE.includes(p.slug))
    .map((p, i) => ({
      email: p.email, role: p.role, displayName: p.name, slug: p.slug, avatarUrl: p.avatar,
      addedAt: inMinutes(-60 * 24 * (120 - i * 9)), telegramChatId: p.telegramChatId, slackUserId: p.slackUserId || null,
      preferredSurface: p.telegramChatId ? 'both' : 'web', surfaces: p.telegramChatId ? ['web', 'telegram'] : ['web'], preferredLanguage: p.language, slackLinked: !!p.slackUserId,
    }));
  return { teamMode: state.teamMode, entries, me: { email: me.email, role: me.role, isAdmin: !isMember } };
}

// ── Files ────────────────────────────────────────────────────────────────────
function filesTree(path) {
  const prefix = path ? path.replace(/\/$/, '') + '/' : '';
  const entries = state.tree
    // Private trees show under "Yours" (personalRoot), never among the shared files.
    .filter((it) => visible(it.path) && !(path === '' && it.path === 'users'))
    .filter((it) => (path === '' ? !it.path.includes('/') : it.path.startsWith(prefix) && it.path.slice(prefix.length) && !it.path.slice(prefix.length).includes('/')))
    .map((it) => ({
      name: it.name, type: it.type, path: it.path, locked: lockOf(it.path),
      size: it.type === 'file' ? (state.files.get(it.path) || '').length : undefined,
      mtime: it.mtime || inMinutes(-60 * 24 * 3),
    }));
  return { path: '/' + path, entries };
}
function fileRead(path) {
  if (!visible(path)) return json({ error: 'Not found' }, 404);
  const content = state.files.get(path);
  if (content == null) return json({ error: 'Not found' }, 404);
  const locked = lockOf(path);
  return json({ content, path, encoding: 'utf8', ...(locked ? { locked: { path: locked.path, by: locked.by, byName: locked.byName } } : {}) });
}
function filesSearch(q) {
  q = (q || '').trim().toLowerCase();
  if (q.length < 2) return { ok: true, results: [] };
  const results = [];
  for (const f of state.tree) {
    if (f.type !== 'file' || !visible(f.path) || results.length >= 40) continue;
    const content = state.files.get(f.path) || '';
    const nameMatch = f.name.toLowerCase().includes(q);
    let snippet = null; let line = null;
    const idx = content.toLowerCase().indexOf(q);
    if (idx !== -1) {
      const s = content.lastIndexOf('\n', idx) + 1;
      let e = content.indexOf('\n', idx); if (e === -1) e = content.length;
      line = content.slice(0, idx).split('\n').length;
      snippet = content.slice(s, e).trim().slice(0, 160);
    }
    if (nameMatch || snippet) results.push({ path: f.path, name: f.name, type: 'file', line, snippet, nameMatch });
  }
  results.sort((a, b) => (a.nameMatch === b.nameMatch ? 0 : a.nameMatch ? -1 : 1));
  return { ok: true, results: results.map((r) => { const out = { ...r }; delete out.nameMatch; return out; }) };
}
function addToTree(path, type) {
  if (state.tree.some((x) => x.path === path)) return;
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (!state.tree.some((x) => x.path === dir)) state.tree.push({ path: dir, type: 'dir', name: parts[i - 1] });
  }
  state.tree.push({ path, type, name: parts[parts.length - 1], mtime: new Date().toISOString() });
}

// ── Integrations ─────────────────────────────────────────────────────────────
const CATALOG = integrationsCatalog.integrations;
const ACTIVATED = inMinutes(-60 * 24 * 40);
function workspaceActive(id) { return INTEGRATIONS.workspace.includes(id); }
function mineActive(id, slug = meSlug) { return (INTEGRATIONS.personal[slug] || []).includes(id); }
function integrationsList() {
  const integrations = CATALOG.map((raw) => {
    const entry = { ...raw }; delete entry.process;
    const active = workspaceActive(entry.id);
    const mine = mineActive(entry.id) ? { active: true, activatedAt: ACTIVATED, summary: null, itemCount: null } : { active: false, activatedAt: null };
    const people = Object.keys(INTEGRATIONS.personal).filter((s) => mineActive(entry.id, s)).map(person);
    return {
      ...entry,
      active, activatedAt: active ? ACTIVATED : null,
      credentialSummary: active && !isMember ? { length: 32, last4: 'k9f2' } : null,
      itemCount: active && entry.multi ? 2 : null,
      globalFieldValues: {},
      connectedBy: active ? person('nora') : null,
      reach: active ? 'workspace' : null,
      access: active ? ((INTEGRATIONS.accessReadOnly || []).includes(entry.id) ? 'read' : 'write') : null,
      personal: Boolean(entry.personal),
      mine,
      ...(isMember ? {} : { activeFor: people }),
      canConnectWorkspace: !isMember,
      canConnectPersonal: Boolean(entry.personal),
    };
  });
  return { ready: true, readyError: null, integrations };
}
function integrationDetail(id) {
  const cat = CATALOG.find((x) => x.id === id);
  if (!cat) return json({ error: `Unknown integration "${id}".` }, 404);
  const fieldsOf = (defs = []) => defs.map((d) => (['secret', 'remote-mcp-oauth', 'json'].includes(d.type)
    ? { name: d.name, set: true, summary: { length: 32, last4: 'k9f2' } }
    : { name: d.name, set: true, value: d.options?.[0]?.value || d.default || 'hello@saltmarsh.example' }));
  const conn = (reach, owner) => ({
    key: reach === 'personal' ? `${id}@${owner}` : id, id, owner, reach,
    access: reach === 'personal' ? 'write' : ((INTEGRATIONS.accessReadOnly || []).includes(id) ? 'read' : 'write'),
    activatedAt: ACTIVATED,
    ...(cat.multi
      ? { items: [{ index: 0, fields: fieldsOf(cat.fields) }, { index: 1, fields: fieldsOf(cat.fields) }] }
      : { fields: fieldsOf(cat.fields) }),
  });
  const ws = workspaceActive(id);
  const people = Object.keys(INTEGRATIONS.personal).filter((s) => mineActive(id, s)).map((s) => ({ ...person(s), activatedAt: ACTIVATED }));
  return json({
    ...cat,
    workspaceActive: ws,
    connectedBy: ws ? person('nora') : null,
    workspace: ws && !isMember ? { ...conn('workspace', 'nora'), connectedBy: person('nora') } : null,
    mine: mineActive(id) ? conn('personal', meSlug) : null,
    ...(isMember ? {} : { activeFor: people }),
    canConnectWorkspace: !isMember,
    canConnectPersonal: Boolean(cat.personal),
    globalFieldValues: {},
  });
}
const restartShape = (extra = {}) => ({ ok: true, demo: true, restarting: false, restartFailed: false, ...extra });

// ── Routines catalog (the real one, grouped as the server does) ──────────────
function routinesCatalogPayload() {
  const active = new Set([...INTEGRATIONS.workspace, ...(INTEGRATIONS.personal[meSlug] || [])]);
  const label = (x) => CATALOG.find((i) => i.id === x)?.label || x;
  const logo = (x) => CATALOG.find((i) => i.id === x)?.logo || null;
  const groups = new Map();
  for (const r of routinesCatalog.routines) {
    const req = r.requires || [];
    const allOk = (r.requiresAll || []).every((x) => active.has(x));
    let via = req.length ? req.find((x) => active.has(x)) : (r.requiresAll?.[0] || '');
    if (!allOk) via = undefined;
    const key = via === undefined ? (req[0] || r.requiresAll?.[0]) : via;
    if (!groups.has(key)) groups.set(key, { id: key || 'everyday', label: key ? label(key) : 'Everyday', logo: key ? logo(key) : null, connected: key ? active.has(key) : true, routines: [] });
    const pub = { ...r }; delete pub.requires; delete pub.requiresAll;
    groups.get(key).routines.push({ ...pub, integrations: [...req, ...(r.requiresAll || [])], added: state.catalogAdded.has(r.id), available: via !== undefined });
  }
  const rank = (g) => (g.id === 'everyday' ? 0 : g.connected ? 1 : 2);
  const CATS = [['life', 'Everyday life'], ['planning', 'Planning'], ['email', 'Email'], ['calendar', 'Calendar & meetings'], ['sales', 'Sales & clients'], ['shop', 'Shop'], ['money', 'Money'], ['marketing', 'Marketing & ads'], ['content', 'Content & social'], ['dev', 'Dev & ops'], ['team', 'Team'], ['research', 'Research']];
  const ids = [];
  for (const r of routinesCatalog.routines) for (const x of [...(r.requires || []), ...(r.requiresAll || [])]) if (!ids.includes(x)) ids.push(x);
  const ilist = ids.map((x) => ({ id: x, label: label(x), logo: logo(x), connected: active.has(x) }));
  return { ok: true, categories: CATS.map(([id, l]) => ({ id, label: l })), integrations: [...ilist.filter((i) => i.connected), ...ilist.filter((i) => !i.connected)], groups: [...groups.values()].sort((x, y) => rank(x) - rank(y)) };
}
function myRoutines() {
  if (!state.routines) {
    const base = memory['/routines'] || { ok: true, mode: 'on', routines: [], unparsed: [] };
    state.routines = { ...clone(base), routines: base.routines.map((r, i) => ({ id: r.id || `r_${String(i).padStart(12, '0')}`, ...r })) };
  }
  return state.routines;
}

// ── Memory v4 ────────────────────────────────────────────────────────────────
function sharing() {
  if (!state.sharing) state.sharing = { ...clone(memory['/memory/v4/privacy'] || { ok: true, teamMode: true, mode: 'ask', rules: [], asks: [], sharedFromMe: [], hidden: [], erased: [] }), _gone: [] };
  return state.sharing;
}
function memoryGet(pathname, search) {
  const key = pathname.replace(/^\/api/, '');
  if (key === '/memory/v4/search') return json(searchFor(viewer, new URLSearchParams(search).get('q') || ''));
  const hit = memory[key + search] || memory[key]
    || (key.startsWith('/memory/v4/facts') && (new URLSearchParams(search).has('history') ? memory['/memory/v4/facts?history=1&limit=500'] : memory['/memory/v4/facts']));
  return hit ? json(hit) : notFound();
}
async function memorySharing(method, path, body) {
  const S = sharing();
  if (method === 'GET') { const { _gone, ...out } = S; return json(out); }
  const answer = (id, decision) => {
    const i = S.asks.findIndex((a) => a.id === id);
    if (i < 0) return { id, ok: false, error: 'already shared or kept' };
    const [a] = S.asks.splice(i, 1);
    if (decision === 'share') S.sharedFromMe.unshift({ id: `${a.id}n0`, recordId: `${a.id}r`, ts: new Date().toISOString(), source: a.source, title: a.fact?.title || null, text: a.fact?.text || a.text, kind: a.fact?.kind || 'fact', subject: a.fact?.subject || null, concerns: a.fact?.concerns || null, aboutPerson: !!a.aboutPerson, entities: a.fact?.entities || [] });
    if (body.rememberSubject && a.fact?.subject) { S.rules = S.rules.filter((r) => r.subject !== a.fact.subject); S.rules.push({ subject: a.fact.subject, decision, at: new Date().toISOString() }); }
    return { id, ok: true };
  };
  if (path === '/api/memory/v4/sharing/mode') { S.mode = body.mode; return json({ ok: true, mode: body.mode }); }
  if (path === '/api/memory/v4/sharing/rules/clear') { S.rules = S.rules.filter((r) => r.subject !== body.subject); return json({ ok: true }); }
  if (path === '/api/memory/v4/asks/batch') { const results = (body.ids || []).map((id) => answer(id, body.decision)); return json({ ok: results.every((r) => r.ok), results }); }
  if (path.startsWith('/api/memory/v4/asks/')) { const r = answer(decodeURIComponent(path.slice('/api/memory/v4/asks/'.length)), body.decision); return json(r, r.ok ? 200 : 422); }
  const m = path.match(/^\/api\/memory\/v4\/shared\/([^/]+)\/(withdraw|restore)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (m[2] === 'withdraw') { const i = S.sharedFromMe.findIndex((x) => x.id === id); if (i >= 0) S._gone.push(...S.sharedFromMe.splice(i, 1)); }
    else { const i = S._gone.findIndex((x) => x.id === id); if (i >= 0) S.sharedFromMe.unshift(...S._gone.splice(i, 1)); }
  }
  return json({ ok: true });
}

// ── Tasks ────────────────────────────────────────────────────────────────────
const TASK_STATUSES = ['backlog', 'in_progress', 'done'];
// A task points at the fact it came from, when memory has one that links it.
const factOfTask = (() => {
  const map = {};
  for (const f of memory['/memory/v4/facts']?.items || []) if (f.task?.id && !map[f.task.id]) map[f.task.id] = { id: f.id, scope: f.scope, title: f.title };
  return map;
})();
function tasksPayload() {
  const people = {};
  for (const p of Object.values(PEOPLE)) people[p.slug] = { name: p.name, avatar: p.avatar };
  // The landing's replay shows a shorter board: the tasks its conversations name, and a few around them.
  const tasks = SHOWCASE ? state.tasks.filter((t) => SHOWCASE_TASKS.some((x) => t.title.startsWith(x))) : state.tasks;
  return { ok: true, teamMode: state.teamMode, me: meSlug, people, tasks: tasks.map((t) => (factOfTask[t.id] ? { ...t, fact: factOfTask[t.id] } : t)) };
}

// ── Skills ───────────────────────────────────────────────────────────────────
function skillsPayload() {
  const canTeam = !isMember;
  const team = SKILLS.team.filter((x) => x.name !== 'legacy-drive-sync').map((x) => ({ ...x, scope: 'team', editable: x.editable === false ? false : canTeam }));
  const own = (SKILLS.personal[meSlug] || []).map((x) => ({ origin: 'personal', scope: 'personal', source: 'personal', editable: true, tags: [], references: [], ...x }));
  const made = state.madeSkills.map((x) => ({ ...x, editable: x.scope === 'team' ? canTeam : true }));
  return { skills: [...team, ...own, ...made], teamMode: state.teamMode, canEditTeam: canTeam };
}

// ── Chat: one answer, as server-sent events ──────────────────────────────────
function demoTurn() {
  const words = DEMO_REPLY.split(/(?<= )/);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctl) {
      await new Promise((r) => setTimeout(r, 700));
      for (const w of words) {
        ctl.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(w)}\n\n`));
        await new Promise((r) => setTimeout(r, 28));
      }
      ctl.enqueue(enc.encode('event: done\ndata: {}\n\n'));
      ctl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

// ── Router ───────────────────────────────────────────────────────────────────
export async function handle(method, url, body) {
  const u = new URL(url, location.origin);
  const path = u.pathname;
  const q = u.searchParams;
  const b = body || {};

  // Auth and the setup gate: always signed in, always set up.
  if (path === '/auth/me') return json({ email: me.email, name: me.name, picture: me.avatar, role: me.role, isAdmin: !isMember, teamMode: state.teamMode });
  if (path === '/auth/verify') return json({ ok: true });
  if (path === '/auth/session' || path === '/api/me/sign-out') return json({ ok: true });
  if (path === '/api/setup/status') return json({ complete: true, missing: [], state: { hasClaudeToken: true, claudeTokenSetAt: inMinutes(-60 * 24 * 60), hasCompletedOnboarding: true, isLegacyClient: false, title: COMPANY.name, botName: state.branding.botName } });
  if (path === '/api/health') return json({ ok: true, session: 'active' });

  if (path === '/api/me' && method === 'GET') return json(mePayload());
  if (path === '/api/me' && method === 'PATCH') {
    for (const k of ['displayName', 'preferredLanguage']) if (b[k] !== undefined) state.me[k] = b[k] || null;
    for (const k of ['languageLocked', 'timezoneLocked']) if (b[k] !== undefined) state.me[k] = !!b[k];
    if (b.timezone !== undefined) Object.assign(state.me, { timezone: b.timezone || null, timezoneFrom: 'Settings', timezoneSetAt: new Date().toISOString() });
    return json({ ok: true, user: mePayload() });
  }
  if (path === '/api/me/avatar') return json({ ok: true, avatarUrl: me.avatar });

  if (path === '/api/team' && method === 'GET') return json(teamPayload());
  if (path === '/api/team/mode') { if (typeof b.enabled === 'boolean') state.teamMode = b.enabled; return json({ ok: true, teamMode: state.teamMode, merged: [] }); }
  if (path === '/api/team/default-timezone') { state.defaultTz = b.timezone || 'UTC'; return json({ ok: true, defaultTimezone: state.defaultTz }); }
  if (path === '/api/team/telegram-groups') return json({ ok: true, canEdit: !isMember, groups: TELEGRAM_GROUPS });
  if (path === '/api/team/channels' && method === 'GET') return json({ ok: true, canEdit: !isMember, groups: isMember ? [] : SLACK_CHANNELS.groups, pending: isMember ? [] : SLACK_CHANNELS.pending, pendingPeople: isMember ? [] : SLACK_CHANNELS.pendingPeople });
  if (path === '/api/team/channels' && method === 'POST') { const p = SLACK_CHANNELS.pending.find((x) => x.chatId === b.chatId); if (p) { SLACK_CHANNELS.pending = SLACK_CHANNELS.pending.filter((x) => x !== p); SLACK_CHANNELS.groups.push({ chatId: p.chatId, kind: 'slack', title: p.title, requireMention: true, language: '', members: {}, audience: { ok: true, outsiders: [], shared: false, members: p.members, checkedAt: new Date().toISOString() }, addedAt: new Date().toISOString(), addedBy: me.email }); } else { const g = SLACK_CHANNELS.groups.find((x) => x.chatId === b.chatId); if (g) { if (b.language !== undefined) g.language = b.language; if (b.requireMention !== undefined) g.requireMention = !!b.requireMention; } } return json({ ok: true }); }
  if (/^\/api\/team\/channels\/pending-people\//.test(path) && method === 'DELETE') { const id = decodeURIComponent(path.split('/')[5]); SLACK_CHANNELS.pendingPeople = SLACK_CHANNELS.pendingPeople.filter((x) => x.id !== id); return json({ ok: true }); }
  if (/^\/api\/team\/channels\/[^/]+\/recheck$/.test(path)) { const id = decodeURIComponent(path.split('/')[4]); const g = SLACK_CHANNELS.groups.find((x) => x.chatId === id); if (g) g.audience = { ...(g.audience || {}), checkedAt: new Date().toISOString() }; return json({ ok: true, audience: g?.audience || null, group: g || null }); }
  if (/^\/api\/team\/channels\/[^/]+$/.test(path) && method === 'DELETE') { const id = decodeURIComponent(path.split('/')[4]); SLACK_CHANNELS.groups = SLACK_CHANNELS.groups.filter((x) => x.chatId !== id); SLACK_CHANNELS.pending = SLACK_CHANNELS.pending.filter((x) => x.chatId !== id); return json({ ok: true, removed: id }); }
  if (path.startsWith('/api/team/') && method === 'DELETE') { state.removedMembers.add(decodeURIComponent(path.split('/')[3]).toLowerCase()); return json({ ok: true }); }
  if (path.startsWith('/api/team')) return json({ ok: true });

  // Branding (the bot's name, picture, the workspace title).
  if (path === '/api/branding' && method === 'GET') return json(state.branding);
  if (path === '/api/branding' || path === '/api/setup/branding' || path === '/api/setup/logo') {
    for (const k of ['title', 'botName', 'hideIdeText', 'backstory', 'personality']) if (b[k] !== undefined) state.branding[k] = b[k];
    if (b.botName !== undefined) state.branding.botDisplayName = b.botName;
    return json({ ok: true, branding: state.branding });
  }
  if (path === '/api/setup/avatar/preset') {
    const n = String(b.preset || '1').replace(/[^0-9]/g, '') || '1';
    state.branding.botAvatarUrl = `${BASE}avatars/${n}.png`;
    return json({ ok: true, branding: state.branding });
  }
  if (path === '/api/branding/avatar' || path === '/api/setup/avatar') return json({ error: 'Uploading a picture is off in the demo. Pick one of the presets.' }, 400);
  if (path === '/api/setup/token') return json(restartShape({ status: { hasClaudeToken: true, claudeTokenSetAt: new Date().toISOString() } }));

  // Files.
  if (path === '/api/files/tree') return json(filesTree(q.get('path') || ''));
  if (path === '/api/files/read' || path === '/api/files/raw') return fileRead(q.get('path') || '');
  if (path === '/api/files/search') return json(filesSearch(q.get('q')));
  if (path === '/api/files/locks') return json({ canManage: !isMember, locks: Object.entries(state.locks).map(([p, v]) => ({ path: p, by: v.by, byName: PEOPLE[v.by]?.name, at: v.at, exists: state.tree.some((x) => x.path === p) })) });
  if (path === '/api/files/lock') { state.locks[b.path] = { by: meSlug, at: new Date().toISOString() }; return json({ ok: true }); }
  if (path === '/api/files/unlock') { delete state.locks[b.path]; return json({ ok: true }); }
  if (path === '/api/files/write' || path === '/api/files/create') {
    if (b.path) {
      if (lockOf(b.path) && isMember) return json({ error: 'This is locked. Only an admin can change it.' }, 423);
      state.files.set(b.path, String(b.content ?? ''));
      addToTree(b.path, 'file');
      const m = String(b.path).match(/^(?:\.claude\/skills|users\/[^/]+\/\.skills)\/([^/]+)\/SKILL\.md$/);
      if (m && path === '/api/files/create') {
        const personal = b.path.startsWith('users/');
        const desc = (String(b.content || '').match(/^description:\s*(.+)$/m) || [])[1] || '';
        state.madeSkills.push({ name: m[1], origin: personal ? 'personal' : 'project', scope: personal ? 'personal' : 'team', source: personal ? 'personal' : 'project', editable: true, description: desc, tags: [], references: [] });
      }
    }
    return json({ ok: true });
  }
  if (path === '/api/files/mkdir') { if (b.path) addToTree(b.path, 'dir'); return json({ ok: true }); }
  if (path === '/api/files/delete') {
    const p = q.get('path') || b.path || '';
    state.tree = state.tree.filter((x) => x.path !== p && !x.path.startsWith(p + '/'));
    state.files.delete(p);
    const m = p.match(/^(?:\.claude\/skills|users\/[^/]+\/\.skills)\/([^/]+)$/);
    if (m) state.madeSkills = state.madeSkills.filter((x) => x.name !== m[1]);
    return json({ ok: true });
  }
  if (path === '/api/files/move') {
    const from = b.from || b.path; const to = b.to || b.dest;
    if (from && to) {
      for (const it of state.tree) if (it.path === from || it.path.startsWith(from + '/')) { it.path = to + it.path.slice(from.length); it.name = it.path.split('/').pop(); }
      for (const [k, v] of [...state.files]) if (k === from || k.startsWith(from + '/')) { state.files.delete(k); state.files.set(to + k.slice(from.length), v); }
    }
    return json({ ok: true });
  }
  if (path === '/api/files/download') return json({ error: 'Downloads are off in the demo.' }, 400);

  // Chat: the conversations are there to read; there is no model to answer.
  // The landing's replay starts from an empty chat.
  if (path === '/api/chat/sessions' && method === 'GET') return json({ sessions: SHOWCASE ? state.sessions.filter((x) => x.id.startsWith('demo-new-')) : state.sessions });
  if (path === '/api/chat/sessions' && method === 'POST') {
    const s = { id: `demo-new-${++state.newSession}`, title: 'New chat', pinned: false, archived: false, messageCount: 0, lastMessageAt: new Date().toISOString() };
    state.sessions.unshift(s);
    return json(s);
  }
  if (path.startsWith('/api/chat/sessions/')) {
    const id = decodeURIComponent(path.slice('/api/chat/sessions/'.length));
    if (method === 'DELETE') state.sessions = state.sessions.filter((s) => s.id !== id);
    else { const s = state.sessions.find((x) => x.id === id); if (s) Object.assign(s, b); }
    return json({ ok: true });
  }
  if (path === '/api/chat/history') {
    const sid = q.get('sessionId') || state.sessions[0]?.id || '';
    const messages = SHOWCASE ? [] : (HISTORIES[sid] || []);
    return json({ messages, total: messages.length, has_more: false });
  }
  if (path === '/api/chat/threads') return json({ threads: [] });
  // Anything said to Aria gets the same answer, streamed as a real turn is.
  if (path === '/api/chat') return SHOWCASE ? showcaseTurn() : demoTurn();
  if (path === '/api/bot/send') return json({ ok: true });

  // Reminders.
  if (path === '/api/reminders' && method === 'GET') {
    const people = {};
    for (const p of Object.values(PEOPLE)) people[p.slug] = { name: p.name, avatar: p.avatar };
    const reminders = (REMINDERS[meSlug] || []).filter((r) => !state.cancelledReminders.has(r.id)).map(({ dueInMin, ...r }) => ({ ...r, due: inMinutes(Number(dueInMin) || 60) }));
    return json({ ok: true, teamMode: state.teamMode, me: meSlug, people, reminders });
  }
  if (path === '/api/reminders/cancel') { if (b.id) state.cancelledReminders.add(b.id); return json({ ok: true, id: b.id }); }

  // Tasks.
  if (path === '/api/tasks' && method === 'GET') return json(tasksPayload());
  if (path === '/api/tasks' && method === 'POST') {
    const status = TASK_STATUSES.includes(b.status) ? b.status : 'backlog';
    const task = { id: 't_' + Math.random().toString(36).slice(2, 9), title: String(b.title || 'Untitled task'), description: String(b.description || ''), status, owner: b.owner || null, priority: b.priority || null, deadline: b.deadline || null, completed: status === 'done' ? today() : null, order: state.tasks.filter((t) => t.status === status).length };
    state.tasks.push(task);
    return json({ ok: true, task });
  }
  if (path.startsWith('/api/tasks/')) {
    const t = state.tasks.find((x) => x.id === decodeURIComponent(path.slice('/api/tasks/'.length)));
    if (!t) return json({ ok: false, error: 'task not found' }, 404);
    if (method === 'DELETE') { state.tasks = state.tasks.filter((x) => x !== t); return json({ ok: true }); }
    for (const k of ['title', 'description', 'owner', 'priority', 'deadline', 'order']) if (k in b) t[k] = b[k];
    if ('status' in b && TASK_STATUSES.includes(b.status)) { t.status = b.status; t.completed = b.status === 'done' ? (t.completed || today()) : null; }
    return json({ ok: true, task: t });
  }

  // Skills.
  if (path === '/api/skills') return json(skillsPayload());
  if (path === '/api/skills/raw') {
    const name = q.get('name') || '';
    const s = [...SKILLS.team, ...(SKILLS.personal[meSlug] || []), ...state.madeSkills].find((x) => x.name === name);
    return s ? json({ ok: true, name, content: s.content || `---\nname: ${name}\ndescription: ${s.description || ''}\n---\n\n# ${name}\n\n${s.description || ''}\n` }) : notFound();
  }

  // Integrations.
  if (path === '/api/integrations/slack/manifest') return json({ display_information: { name: 'Aria' }, features: { bot_user: { display_name: 'Aria', always_online: true }, app_home: { messages_tab_enabled: true } }, oauth_config: { scopes: { bot: ['chat:write', 'im:history', 'users:read.email'] } }, settings: { socket_mode_enabled: true, event_subscriptions: { bot_events: ['message.im', 'app_mention'] } } });
  if (path === '/api/integrations' && method === 'GET') return json(integrationsList());
  if (path === '/api/integrations/make-personal') return json({ ok: true, moved: (b.ids || []).map((i) => `${i}@${meSlug}`), failed: [], restarting: false });
  if (/^\/api\/integrations\/[^/]+\/make-personal$/.test(path)) return json({ ok: true, key: `${path.split('/')[3]}@${meSlug}`, restarting: false });
  if (/^\/api\/integrations\/[^/]+\/test/.test(path)) return json({ ok: true, at: new Date().toISOString(), detail: 'Signed in; the provider accepted the token.' });
  if (/^\/api\/integrations\/[^/]+\/items/.test(path)) return json(restartShape({ index: 2 }));
  if (path.startsWith('/api/integrations/docs-comments/')) return json({ ok: true, connected: false });
  if (/^\/api\/integrations\/[a-z0-9-]+$/.test(path) && method === 'GET') return integrationDetail(path.slice('/api/integrations/'.length));
  if (path.startsWith('/api/integrations/')) return json({ ...restartShape(), error: method === 'GET' ? undefined : undefined, activatedAt: new Date().toISOString(), credentialSummary: { length: 32, last4: 'k9f2' } });

  // Routines.
  if (path === '/api/routines/catalog' && method === 'GET') return json(routinesCatalogPayload());
  if (path.startsWith('/api/routines/catalog/')) {
    const id = path.split('/')[4];
    if (method === 'DELETE') { state.catalogAdded.delete(id); return json({ ok: true, retired: 1 }); }
    state.catalogAdded.add(id);
    const e = routinesCatalog.routines.find((x) => x.id === id);
    if (e) myRoutines().routines.push({ id: `r_${Date.now().toString(16).slice(-12)}`, title: e.title, summary: e.summary, description: e.description, icon: e.icon, tags: e.tags || [], source: 'catalog', catalogId: e.id });
    return json({ ok: true, added: true });
  }
  if (path === '/api/routines/unparsed') return json({ ok: true });
  if (path === '/api/routines' || path.startsWith('/api/routines/')) {
    const R = myRoutines();
    if (method === 'GET') return json(R);
    if (method === 'POST' && path === '/api/routines') {
      const r = { id: `r_${Date.now().toString(16).slice(-12)}`, title: b.title, description: b.description, icon: b.icon || null, tags: b.tags || [], source: 'ui' };
      R.routines.push(r);
      return json({ ok: true, routine: r });
    }
    const r = R.routines.find((x) => x.id === decodeURIComponent(path.split('/')[3]));
    if (!r) return json({ ok: false, error: 'not one of your routines' }, 404);
    if (method === 'DELETE') { r.retired = true; return json({ ok: true }); }
    if (b.description !== undefined && b.description !== r.description) delete r.summary;
    Object.assign(r, b);
    return json({ ok: true, routine: r });
  }

  // Memory.
  if (path === '/api/migrations/status') return json({ ok: true, admin: !isMember, memory: { mode: 'on', migrated: true, available: false } });
  if (path.startsWith('/api/migrations/')) return json({ ok: true });
  if (/^\/api\/memory\/v4\/(sharing|asks|shared|privacy)/.test(path)) return memorySharing(method, path, b);
  if (path.startsWith('/api/memory/v4')) return method === 'GET' ? memoryGet(path, u.search) : json({ ok: true });
  // What is always in context: a few cards' worth, as a v4 workspace has.
  if (path === '/api/memory/prefix') return json({ ok: true, approxTokens: 3400, meetsCacheFloor: true, sources: [], breakpoint: null });
  if (path === '/api/memory/changes') return json(memory['/memory/v4/changes'] || { ok: true, days: [], items: [] });
  if (path.startsWith('/api/memory/')) return json({ ok: true });

  // Everything else the workspace can call, answered quietly.
  if (path === '/api/miniapps') return json({ ok: true, apps: [] });
  if (path.startsWith('/api/tab/')) return json({ ok: false, error: 'The browser agent is not in the demo.' }, 404);
  if (path === '/api/bot/restart' || path === '/api/internal/notify') return json({ ok: true });

  return notFound();
}

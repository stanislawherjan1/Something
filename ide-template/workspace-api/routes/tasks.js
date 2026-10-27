/**
 * /api/tasks — the structured task board (replaces rendering Tasks.md).
 *
 *   GET   /api/tasks         → { ok, teamMode, me, people: {slug→{name,avatar}}, tasks }
 *   POST  /api/tasks         → create { title, description?, status?, owner?, priority?, deadline?, scope? }
 *   PATCH /api/tasks/:id     → update any of { title, description, status, owner, priority, deadline, order, scope }
 *   DELETE /api/tasks/:id    → remove a task for good (mistakes, tests, duplicates)
 *
 * Two lists, one board. The team board (`scope: 'shared'`, the root file) is
 * everyone's: every member reads and changes it. A person's own list
 * (`scope: 'user:<slug>'`, a file in their private tree) is theirs alone: it
 * is not in anyone else's GET, and a PATCH or DELETE on one of its ids from
 * anyone else is 404 — not 403, which would confirm the id exists. The
 * asker's GET is the two merged, each task saying which list it is on.
 *
 * Where a new task goes, when the body does not say (`scope: 'mine' | 'shared'`):
 *   a person in their own chat or the browser → their own list;
 *   `owner` naming someone else, or null on purpose → the team board;
 *   a group's turn, a caller nobody can place   → the team board (they have
 *                                                 no list and may not ask for one).
 * A private task's owner is its person; assigning it to someone else moves it
 * to the team board. A task changes lists only through its own person: they
 * share their own, and take back a shared task they own or created (an
 * unowned one is claimed — `owner: me` in the same call — never taken quietly).
 * Admins have no exception anywhere here.
 *
 * `owner` is a roster slug in team mode (resolved to a profile for the UI), a
 * free-text name in solo. Moving a task to `done` stamps `completed`; moving
 * it back clears it. Finished work moves to Done; DELETE is for what should
 * never have been on the board.
 */

import express, { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { readScope, writeScope, readFor, todayISO, cleanDeadline, isUserScope, TASK_STATUSES, TASK_PRIORITIES } from '../lib/tasks.js';
import { PrivateTreeNotReady } from '../lib/private-tree.js';
import { getTeamMode, getUser, list as teamList, memberGroupsOf } from '../lib/team.js';
import { avatarUrl } from '../lib/user-avatars.js';
import { resolveTurnToken } from '../lib/turn-identity.js';
import * as facts from '../lib/memory-facts.js';
import { carriesTitle, isTheMatter, taskPointer } from '../lib/memory-task-links.js';

export default function tasksRouter() {
  const router = Router();

  const meSlug = (req) => (getTeamMode() ? (getUser(req.actor)?.slug || null) : null);
  // Who is asking: the signed-in person (browser), or the person whose turn
  // the bot is running (loopback, the turn token). A group's turn is nobody's.
  const whoAsks = (req) => {
    if (req.actor) return meSlug(req);
    const ip = req.socket?.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return null;
    const t = resolveTurnToken(typeof req.headers['x-ide-turn'] === 'string' ? req.headers['x-ide-turn'] : '');
    return t && !t.group && t.actor ? t.actor : null;
  };
  // The lists this caller may see and touch. Solo has one person and one board.
  const ownScope = (asker) => (asker && getTeamMode() ? `user:${asker}` : null);
  const scopesFor = (asker) => (ownScope(asker) ? ['shared', ownScope(asker)] : ['shared']);

  // slug → { name, avatar } so the board can render assignee avatars.
  const peopleMap = () => {
    const people = {};
    if (getTeamMode()) {
      for (const m of teamList()) {
        people[m.slug] = { name: m.displayName || m.slug, avatar: avatarUrl(m.slug) || null };
      }
    }
    return people;
  };

  // owner must be a real roster slug in team mode; free text → null. Solo keeps
  // whatever name string the user gave (no roster to resolve against).
  const validOwner = (v) => {
    if (v == null || v === '') return null;
    if (!getTeamMode()) return String(v).trim();
    const s = String(v).trim().toLowerCase();
    return teamList().some(m => m.slug === s) ? s : null;
  };

  const normPriority = (p) => (TASK_PRIORITIES.includes(p) ? p : null);

  // What the body means by `scope`: 'mine' (or the asker's own scope spelled
  // out), 'shared', or nothing. Anything else is a request nobody can grant.
  const askedScope = (b, asker) => {
    if (!('scope' in b)) return undefined;
    const v = b.scope;
    if (v === 'shared') return 'shared';
    if (v === 'mine' || (ownScope(asker) && v === ownScope(asker))) return 'mine';
    return null;
  };

  // Who may read a memory scope from the board: the team's memory is everyone's,
  // a person's own is theirs, a group's is its members'. Solo: one person, all theirs.
  const canRead = (scope, viewer) => {
    if (!getTeamMode()) return true;
    if (scope === 'shared') return true;
    if (!viewer) return false;
    if (scope === `user:${viewer}`) return true;
    const g = /^group:(.+)$/.exec(scope || '');
    if (g) { try { return memberGroupsOf(viewer).map(String).includes(g[1]); } catch { return false; } }
    return false;
  };

  // A task as one viewer sees it. The board is the team's; a fact from someone's
  // private memory or a group's is not: its title and id reach only who may read
  // it — everyone else sees that the task has a source in memory, nothing of what
  // it says. A fact that is gone (erased) is not shown at all, and the nightly
  // seeding's bookkeeping (how much memory it looked at) stays on the server.
  const viewOf = (viewer) => {
    const live = new Map();
    const exists = (scope, id) => {
      if (!live.has(scope)) { try { live.set(scope, new Set(facts.all(scope).filter(f => !f.hidden).map(f => f.id))); } catch { live.set(scope, new Set()); } }
      return live.get(scope).has(id);
    };
    return (t) => {
      const { linkTried, ...out } = t;
      if (!out.fact) return out;
      if (out.fact.id && !exists(out.fact.scope, out.fact.id)) { const { fact, ...rest } = out; return rest; }
      return canRead(out.fact.scope, viewer) ? out : { ...out, fact: { private: true } };
    };
  };

  // A task can point at the memory fact it came from (the request, the
  // decision), by the fact's id or by the id of the conversation record the
  // bot saw it in (the excerpt id in its memory block). The fact points back,
  // so the Memory screen shows the task and its state, the board shows where
  // the task came from, and a finished task closes exactly that fact. Only
  // facts the asker may read: their own memory and the team's.
  const linkScopes = (asker) => ['shared', ...(asker && /^[a-z0-9-]+$/.test(asker) ? [`user:${asker}`] : [])];
  // The bot named no fact: the excerpts this turn was handed are its context,
  // and a fact among them that carries the task's own words is the one the
  // task came from.
  const linkFromTurn = (req, t, asker) => {
    const token = typeof req.headers['x-ide-turn'] === 'string' ? req.headers['x-ide-turn'] : '';
    const turn = token ? resolveTurnToken(token) : null;
    if (!turn || turn.group || !turn.recall?.length) return null;
    for (const scope of linkScopes(asker)) {
      for (const rid of turn.recall) {
        let fs = [];
        try { fs = facts.forRecord(scope, rid).filter(f => !f.retired && !f.hidden && !f.replacedBy); } catch { continue; }
        const f = fs.find(x => carriesTitle(`${x.title || ''} ${x.text || ''}`, t.title));
        if (f) return { fact: f, scope };
      }
    }
    return null;
  };
  // Resolved BEFORE the board is read (it only reads memory), so the board's
  // read-change-write below has no wait in it.
  const resolveLink = (b, asker) => {
    if (!('fact' in b) && !('record' in b)) return null;
    if (b.fact === null || b.record === null) return { clear: true };
    for (const scope of linkScopes(asker)) {
      try {
        if (typeof b.fact === 'string' && b.fact) { const f = facts.get(scope, b.fact); if (f && !f.hidden) return { fact: f, scope }; }
        else if (typeof b.record === 'string' && b.record) { const list = facts.forRecord(scope, b.record).filter(f => !f.retired && !f.hidden && !f.replacedBy); if (list.length) return { fact: list[0], scope }; }
      } catch { /* no memory here */ }
    }
    return { missing: true };
  };
  // The board side of a link, inside the board's read-change-write: no await.
  // A fact holds one task: a task that held it before lets go — in the list
  // being written; one in the other list is released after the write.
  const linkOnBoard = (tasks, t, link) => {
    if (!link) return null;
    if (link.clear) { delete t.fact; return 'cleared'; }
    if (link.missing) return 'not found';
    for (const o of tasks) if (o !== t && o.fact?.id === link.fact.id && o.fact.scope === link.scope) delete o.fact;
    t.fact = { id: link.fact.id, scope: link.scope, title: link.fact.title || String(link.fact.text || '').slice(0, 80) };
    return 'linked';
  };
  // The same fact held by a task in the asker's other list lets go of it too.
  const releaseElsewhere = (t, asker) => {
    if (!t.fact?.id) return;
    for (const s of scopesFor(asker)) {
      if (s === t.scope) continue;
      const list = readScope(s);
      const held = list.filter(o => o.id !== t.id && o.fact?.id === t.fact.id && o.fact.scope === t.fact.scope);
      if (!held.length) continue;
      for (const o of held) delete o.fact;
      try { writeScope(s, list); } catch { /* their list is not ready; the pointer is corrected on the next write */ }
    }
  };
  // The memory side, after the board is written. Only memory the asker may
  // read is changed from the board. The pointer carries the task's scope, and
  // its title only where a reader of the fact may read the task (memory-task-links).
  const linkInMemory = async (t, before, asker) => {
    if (before && (before.id !== t.fact?.id || before.scope !== t.fact?.scope) && canRead(before.scope, asker)) {
      try { await facts.amend(before.scope, before.id, { task: null }); } catch { /* gone */ }
    }
    if (t.fact?.id && canRead(t.fact.scope, asker)) {
      try { await facts.amend(t.fact.scope, t.fact.id, { task: taskPointer(t, t.fact.scope) }); } catch { /* gone */ }
    }
  };

  // The board is the one record of a task, but a conversation about it may
  // have left a fact in memory ("Ann will prepare the deck by Friday") that
  // outlives the task. When a task is done, the open matter it settled is
  // retired, with the reason: the fact it is linked to, and facts that carry
  // its words — only in memory the asker may read (the team's and their own),
  // so the board can neither change nor probe anyone's private memory. A
  // private task closes private facts only: a shared fact marked "done on the
  // task board" with no task anyone else can see would tell the team that
  // something was done, and by whom, and leave a line nobody can follow.
  const retireFactsAbout = async (t, asker) => {
    let n = 0;
    const scopes = isUserScope(t.scope) ? [t.scope] : linkScopes(asker);
    if (t.fact && scopes.includes(t.fact.scope) && canRead(t.fact.scope, asker)) {
      try { const f = facts.get(t.fact.scope, t.fact.id); if (f && isTheMatter(f, t.title) && !f.retired && !f.hidden && !f.replacedBy) { await facts.retire(t.fact.scope, f.id, 'task board', { why: 'done on the task board' }); n++; } } catch { /* gone */ }
    }
    const needle = String(t.title || '').trim().toLowerCase();
    if (needle.length < 10) return n;
    for (const scope of scopes) {
      let list = [];
      try { list = facts.all(scope); } catch { continue; }
      for (const f of list) {
        if (f.retired || f.hidden || f.replacedBy) continue;
        const hay = `${f.title || ''} ${f.text || ''}`;
        if (!hay.toLowerCase().includes(needle) && !carriesTitle(hay, t.title, { all: true })) continue;
        if (!isTheMatter(f, t.title)) continue;   // a meeting or project fact that mentions it stays
        try { await facts.retire(scope, f.id, 'task board', { why: 'done on the task board' }); n++; } catch { /* best effort */ }
      }
    }
    return n;
  };

  // Writes to the board: generous for a person or the bot (a plan can make a
  // dozen tasks at once), a stop for anything looping.
  const writes = new Map();
  const rateLimit = (req, res, next) => {
    const who = whoAsks(req) || req.ip || 'anon';
    const now = Date.now();
    const recent = (writes.get(who) || []).filter(t => now - t < 60_000);
    if (recent.length >= 60) return res.status(429).json({ ok: false, error: 'Too many changes to the board — try again in a minute.' });
    recent.push(now); writes.set(who, recent);
    return next();
  };

  // A private list that cannot be written yet (the person's tree is not theirs
  // on this machine) is said, never worked around by writing the team board.
  const notReady = (res, err) => {
    if (!(err instanceof PrivateTreeNotReady)) return false;
    process.stderr.write(`[tasks] ${err.message}\n`);
    res.status(503).json({ ok: false, error: 'Your own list is not ready on this workspace yet — try again in a minute, or put the task on the team board.' });
    return true;
  };

  // The asker's task by id, with the list it is in. Someone else's private
  // task is not found, by design.
  const findTask = (id, asker) => {
    for (const s of scopesFor(asker)) {
      const list = readScope(s);
      const t = list.find(x => x.id === id);
      if (t) return { scope: s, list, t };
    }
    return null;
  };
  const renumber = (list, status) => {
    list.filter(t => t.status === status).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).forEach((t, n) => { t.order = n; });
  };

  router.get('/tasks', (req, res) => {
    try {
      const asker = whoAsks(req);
      const see = viewOf(asker);
      return res.json({
        ok: true,
        teamMode: getTeamMode(),
        me: meSlug(req),
        people: peopleMap(),
        tasks: readFor(scopesFor(asker)).map(see),
      });
    } catch (err) {
      process.stderr.write(`[tasks] list failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/tasks', rateLimit, express.json({ limit: '16kb' }), async (req, res) => {
    try {
      const b = req.body || {};
      const asker = whoAsks(req);
      const status = TASK_STATUSES.includes(b.status) ? b.status : 'backlog';
      const title = String(b.title || 'Untitled task').slice(0, 200);
      // No owner named → the person asking owns it; a group's turn, or a
      // caller nobody can place, leaves it unowned. An explicit null stays null.
      const owner = 'owner' in b ? validOwner(b.owner) : validOwner(asker);
      // Which list. Asked for, else the person's own; the team board when the
      // owner is someone else (or nobody, on purpose) or there is no person.
      const asked = askedScope(b, asker);
      if (asked === null) return res.status(400).json({ ok: false, error: 'scope is "mine" or "shared"' });
      if (asked === 'mine' && !ownScope(asker)) return res.status(400).json({ ok: false, error: 'No own list here: a group, or a caller nobody can place, puts tasks on the team board.' });
      if (asked === 'mine' && 'owner' in b && owner !== asker) return res.status(400).json({ ok: false, error: 'A task on your own list is yours; to give it to someone, put it on the team board.' });
      const scope = asked === 'shared' ? 'shared'
        : asked === 'mine' ? ownScope(asker)
        : ownScope(asker) && owner === asker ? ownScope(asker)
        : 'shared';
      const link = resolveLink(b, asker) || linkFromTurn(req, { title }, asker);
      // Read, change, write — nothing awaited in between, so two creates at
      // once cannot both write a list that misses the other's task.
      const tasks = readScope(scope);
      const now = new Date().toISOString();
      const task = {
        id: 't_' + randomUUID().slice(0, 8),
        title,
        description: String(b.description || ''),
        status,
        owner,
        priority: normPriority(b.priority),
        deadline: cleanDeadline(b.deadline),
        completed: status === 'done' ? todayISO() : null,
        order: tasks.filter(t => t.status === status).length,
        createdAt: now,
        createdBy: meSlug(req) || asker,
        updatedAt: now,
        scope,
      };
      const linked = linkOnBoard(tasks, task, link);
      tasks.push(task);
      try { writeScope(scope, tasks); } catch (err) { if (notReady(res, err)) return; throw err; }
      if (linked === 'linked') releaseElsewhere(task, asker);
      await linkInMemory(task, null, asker);
      // Born done (recorded after the fact): it closes what it was about, like a task marked done later.
      let retiredFacts = 0;
      if (status === 'done') { try { retiredFacts = await retireFactsAbout(task, asker); } catch { /* memory is not the board's concern */ } }
      return res.json({ ok: true, task: viewOf(asker)(task), ...(linked ? { link: linked } : {}), ...(retiredFacts ? { retiredFacts } : {}) });
    } catch (err) {
      process.stderr.write(`[tasks] create failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.patch('/tasks/:id', rateLimit, express.json({ limit: '16kb' }), async (req, res) => {
    try {
      const b = req.body || {};
      const asker = whoAsks(req);
      const asked = askedScope(b, asker);
      if (asked === null) return res.status(400).json({ ok: false, error: 'scope is "mine" or "shared"' });
      if (asked === 'mine' && !ownScope(asker)) return res.status(400).json({ ok: false, error: 'No own list here: a group, or a caller nobody can place, works on the team board.' });
      const link = resolveLink(b, asker);
      // Read, change, write — nothing awaited in between.
      const found = findTask(req.params.id, asker);
      if (!found) return res.status(404).json({ ok: false, error: 'task not found' });
      const { scope: from, list: tasks, t } = found;
      const before = t.fact ? { ...t.fact } : null;
      const retitled = typeof b.title === 'string' && b.title.slice(0, 200) !== t.title;
      if (typeof b.title === 'string')       t.title = b.title.slice(0, 200);
      if (typeof b.description === 'string')  t.description = b.description;
      if ('owner' in b)                       t.owner = validOwner(b.owner);
      if ('priority' in b)                    t.priority = normPriority(b.priority);
      if ('deadline' in b)                    t.deadline = cleanDeadline(b.deadline);
      if (Number.isFinite(b.order))           t.order = b.order;
      // Which list it ends up in. A private task given to someone else goes to
      // the team board; a shared task comes to the asker's list only when it is
      // theirs — owned or created by them, or claimed in this same call.
      let to = from;
      if (asked === 'shared') to = 'shared';
      else if (asked === 'mine') {
        const own = ownScope(asker);
        if ('owner' in b && t.owner !== asker) return res.status(400).json({ ok: false, error: 'A task on your own list is yours; to give it to someone, put it on the team board.' });
        if (from !== own && t.owner !== asker && t.createdBy !== asker) return res.status(403).json({ ok: false, error: 'Only a task you own or created can come to your own list — assign it to yourself first.' });
        t.owner = asker;
        to = own;
      } else if (isUserScope(from) && 'owner' in b && t.owner !== asker) to = 'shared';
      const linked = linkOnBoard(tasks, t, link);
      let finished = false;
      if (TASK_STATUSES.includes(b.status)) {
        finished = b.status === 'done' && t.status !== 'done';
        t.status = b.status;
        if (b.status === 'done') { if (!t.completed) t.completed = todayISO(); }
        else t.completed = null;
      }
      t.updatedAt = new Date().toISOString();
      const moved = to !== from;
      if (moved) {
        // Append to the target first, then take it out of the source: a crash
        // between the two leaves the task in both files, never in neither, and
        // readFor shows the newest copy until the next write settles it.
        t.scope = to;
        const target = readScope(to).filter(x => x.id !== t.id);
        t.order = target.filter(x => x.status === t.status).length;
        target.push(t);
        try { writeScope(to, target); } catch (err) { if (notReady(res, err)) return; throw err; }
        const rest = tasks.filter(x => x !== t);
        renumber(rest, t.status);
        writeScope(from, rest);
      } else {
        writeScope(from, tasks);
      }
      if (linked === 'linked') releaseElsewhere(t, asker);
      if (linked || retitled || moved) await linkInMemory(t, before, asker);
      let retiredFacts = 0;
      if (finished) { try { retiredFacts = await retireFactsAbout(t, asker); } catch { /* memory is not the board's concern */ } }
      return res.json({ ok: true, task: viewOf(asker)(t), ...(retiredFacts ? { retiredFacts } : {}), ...(linked ? { link: linked } : {}), ...(moved ? { moved: to } : {}) });
    } catch (err) {
      process.stderr.write(`[tasks] update failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Remove a task for good. The rest of its column closes up (order renumbered)
  // so a drag right after a delete lands where it looks like it will. The fact
  // it pointed at lets go of it, so the fact can find its task again.
  router.delete('/tasks/:id', rateLimit, async (req, res) => {
    try {
      const asker = whoAsks(req);
      const found = findTask(req.params.id, asker);
      if (!found) return res.status(404).json({ ok: false, error: 'task not found' });
      const { scope, list: tasks, t: gone } = found;
      const rest = tasks.filter(x => x !== gone);
      renumber(rest, gone.status);
      writeScope(scope, rest);
      if (gone.fact?.id) { try { const f = facts.get(gone.fact.scope, gone.fact.id); if (f?.task?.id === gone.id) await facts.amend(gone.fact.scope, gone.fact.id, { task: null }); } catch { /* gone */ } }
      return res.json({ ok: true, deleted: gone.id });
    } catch (err) {
      process.stderr.write(`[tasks] delete failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

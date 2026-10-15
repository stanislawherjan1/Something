/**
 * /api/tasks — the structured task board (replaces rendering Tasks.md).
 *
 *   GET   /api/tasks         → { ok, teamMode, me, people: {slug→{name,avatar}}, tasks }
 *   POST  /api/tasks         → create { title, description?, status?, owner?, priority?, deadline? }
 *   PATCH /api/tasks/:id     → update any of { title, description, status, owner, priority, deadline, order }
 *   DELETE /api/tasks/:id    → remove a task for good (mistakes, tests, duplicates)
 *
 * The board is shared team work, so there's no per-user scoping — every
 * authenticated member reads and mutates the same list (auth on /api/* already
 * gates access). `owner` is a roster slug in team mode (resolved to a profile
 * for the UI), a free-text name in solo. Moving a task to `done` stamps
 * `completed`; moving it back clears it. Finished work moves to Done; DELETE is
 * for what should never have been on the board.
 */

import express, { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { readTasks, writeTasks, todayISO, cleanDeadline, TASK_STATUSES, TASK_PRIORITIES } from '../lib/tasks.js';
import { getTeamMode, getUser, list as teamList, memberGroupsOf } from '../lib/team.js';
import { avatarUrl } from '../lib/user-avatars.js';
import { resolveTurnToken } from '../lib/turn-identity.js';
import * as facts from '../lib/memory-facts.js';
import { carriesTitle, isTheMatter } from '../lib/memory-task-links.js';

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
  // A fact holds one task: a task that held it before lets go.
  const linkOnBoard = (tasks, t, link) => {
    if (!link) return null;
    if (link.clear) { delete t.fact; return 'cleared'; }
    if (link.missing) return 'not found';
    for (const o of tasks) if (o !== t && o.fact?.id === link.fact.id && o.fact.scope === link.scope) delete o.fact;
    t.fact = { id: link.fact.id, scope: link.scope, title: link.fact.title || String(link.fact.text || '').slice(0, 80) };
    return 'linked';
  };
  // The memory side, after the board is written. Only memory the asker may
  // read is changed from the board.
  const linkInMemory = async (t, before, asker) => {
    if (before && (before.id !== t.fact?.id || before.scope !== t.fact?.scope) && canRead(before.scope, asker)) {
      try { await facts.amend(before.scope, before.id, { task: null }); } catch { /* gone */ }
    }
    if (t.fact?.id && canRead(t.fact.scope, asker)) {
      try { await facts.amend(t.fact.scope, t.fact.id, { task: { id: t.id, title: t.title } }); } catch { /* gone */ }
    }
  };

  // The board is the one record of a task, but a conversation about it may
  // have left a fact in memory ("Ann will prepare the deck by Friday") that
  // outlives the task. When a task is done, the open matter it settled is
  // retired, with the reason: the fact it is linked to, and facts that carry
  // its words — only in memory the asker may read (the team's and their own),
  // so the board can neither change nor probe anyone's private memory.
  const retireFactsAbout = async (t, asker) => {
    let n = 0;
    if (t.fact && canRead(t.fact.scope, asker)) {
      try { const f = facts.get(t.fact.scope, t.fact.id); if (f && isTheMatter(f, t.title) && !f.retired && !f.hidden && !f.replacedBy) { await facts.retire(t.fact.scope, f.id, 'task board', { why: 'done on the task board' }); n++; } } catch { /* gone */ }
    }
    const needle = String(t.title || '').trim().toLowerCase();
    if (needle.length < 10) return n;
    for (const scope of linkScopes(asker)) {
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

  router.get('/tasks', (req, res) => {
    try {
      const see = viewOf(whoAsks(req));
      return res.json({
        ok: true,
        teamMode: getTeamMode(),
        me: meSlug(req),
        people: peopleMap(),
        tasks: readTasks().map(see),
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
      const link = resolveLink(b, asker) || linkFromTurn(req, { title }, asker);
      // Read, change, write — nothing awaited in between, so two creates at
      // once cannot both write a board that misses the other's task.
      const tasks = readTasks();
      const task = {
        id: 't_' + randomUUID().slice(0, 8),
        title,
        description: String(b.description || ''),
        status,
        // No owner named → the person asking owns it; a group's turn, or a
        // caller nobody can place, leaves it unowned. An explicit null stays null.
        owner: 'owner' in b ? validOwner(b.owner) : validOwner(asker),
        priority: normPriority(b.priority),
        deadline: cleanDeadline(b.deadline),
        completed: status === 'done' ? todayISO() : null,
        order: tasks.filter(t => t.status === status).length,
        createdAt: new Date().toISOString(),
        createdBy: meSlug(req) || asker,
      };
      const linked = linkOnBoard(tasks, task, link);
      tasks.push(task);
      writeTasks(tasks);
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
      const link = resolveLink(b, asker);
      // Read, change, write — nothing awaited in between.
      const tasks = readTasks();
      const t = tasks.find(x => x.id === req.params.id);
      if (!t) return res.status(404).json({ ok: false, error: 'task not found' });
      const before = t.fact ? { ...t.fact } : null;
      const retitled = typeof b.title === 'string' && b.title.slice(0, 200) !== t.title;
      if (typeof b.title === 'string')       t.title = b.title.slice(0, 200);
      if (typeof b.description === 'string')  t.description = b.description;
      if ('owner' in b)                       t.owner = validOwner(b.owner);
      if ('priority' in b)                    t.priority = normPriority(b.priority);
      if ('deadline' in b)                    t.deadline = cleanDeadline(b.deadline);
      if (Number.isFinite(b.order))           t.order = b.order;
      const linked = linkOnBoard(tasks, t, link);
      let finished = false;
      if (TASK_STATUSES.includes(b.status)) {
        finished = b.status === 'done' && t.status !== 'done';
        t.status = b.status;
        if (b.status === 'done') { if (!t.completed) t.completed = todayISO(); }
        else t.completed = null;
      }
      writeTasks(tasks);
      if (linked || retitled) await linkInMemory(t, before, asker);
      let retiredFacts = 0;
      if (finished) { try { retiredFacts = await retireFactsAbout(t, asker); } catch { /* memory is not the board's concern */ } }
      return res.json({ ok: true, task: viewOf(asker)(t), ...(retiredFacts ? { retiredFacts } : {}), ...(linked ? { link: linked } : {}) });
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
      const tasks = readTasks();
      const i = tasks.findIndex(x => x.id === req.params.id);
      if (i < 0) return res.status(404).json({ ok: false, error: 'task not found' });
      const [gone] = tasks.splice(i, 1);
      tasks.filter(t => t.status === gone.status)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .forEach((t, n) => { t.order = n; });
      writeTasks(tasks);
      if (gone.fact?.id) { try { const f = facts.get(gone.fact.scope, gone.fact.id); if (f?.task?.id === gone.id) await facts.amend(gone.fact.scope, gone.fact.id, { task: null }); } catch { /* gone */ } }
      return res.json({ ok: true, deleted: gone.id });
    } catch (err) {
      process.stderr.write(`[tasks] delete failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

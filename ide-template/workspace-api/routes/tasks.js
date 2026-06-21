/**
 * /api/tasks — the structured task board (replaces rendering Tasks.md).
 *
 *   GET   /api/tasks         → { ok, teamMode, me, people: {slug→{name,avatar}}, tasks }
 *   POST  /api/tasks         → create { title, description?, status?, owner?, priority?, deadline? }
 *   PATCH /api/tasks/:id     → update any of { title, description, status, owner, priority, deadline, order }
 *
 * The board is shared team work, so there's no per-user scoping — every
 * authenticated member reads and mutates the same list (auth on /api/* already
 * gates access). `owner` is a roster slug in team mode (resolved to a profile
 * for the UI), a free-text name in solo. Moving a task to `done` stamps
 * `completed`; moving it back clears it. No deletes — tasks move to Done.
 */

import express, { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { readTasks, writeTasks, todayISO, cleanDeadline, TASK_STATUSES, TASK_PRIORITIES } from '../lib/tasks.js';
import { getTeamMode, getUser, list as teamList } from '../lib/team.js';
import { avatarUrl } from '../lib/user-avatars.js';

export default function tasksRouter() {
  const router = Router();

  const meSlug = (req) => (getTeamMode() ? (getUser(req.actor)?.slug || null) : null);

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

  router.get('/tasks', (req, res) => {
    try {
      return res.json({
        ok: true,
        teamMode: getTeamMode(),
        me: meSlug(req),
        people: peopleMap(),
        tasks: readTasks(),
      });
    } catch (err) {
      process.stderr.write(`[tasks] list failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/tasks', express.json({ limit: '16kb' }), (req, res) => {
    try {
      const b = req.body || {};
      const tasks = readTasks();
      const status = TASK_STATUSES.includes(b.status) ? b.status : 'backlog';
      const task = {
        id: 't_' + randomUUID().slice(0, 8),
        title: String(b.title || 'Untitled task').slice(0, 200),
        description: String(b.description || ''),
        status,
        owner: validOwner(b.owner),
        priority: normPriority(b.priority),
        deadline: cleanDeadline(b.deadline),
        completed: status === 'done' ? todayISO() : null,
        order: tasks.filter(t => t.status === status).length,
        createdAt: new Date().toISOString(),
        createdBy: meSlug(req),
      };
      tasks.push(task);
      writeTasks(tasks);
      return res.json({ ok: true, task });
    } catch (err) {
      process.stderr.write(`[tasks] create failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.patch('/tasks/:id', express.json({ limit: '16kb' }), (req, res) => {
    try {
      const b = req.body || {};
      const tasks = readTasks();
      const t = tasks.find(x => x.id === req.params.id);
      if (!t) return res.status(404).json({ ok: false, error: 'task not found' });

      if (typeof b.title === 'string')       t.title = b.title.slice(0, 200);
      if (typeof b.description === 'string')  t.description = b.description;
      if ('owner' in b)                       t.owner = validOwner(b.owner);
      if ('priority' in b)                    t.priority = normPriority(b.priority);
      if ('deadline' in b)                    t.deadline = cleanDeadline(b.deadline);
      if (Number.isFinite(b.order))           t.order = b.order;
      if (TASK_STATUSES.includes(b.status)) {
        t.status = b.status;
        if (b.status === 'done') { if (!t.completed) t.completed = todayISO(); }
        else t.completed = null;
      }

      writeTasks(tasks);
      return res.json({ ok: true, task: t });
    } catch (err) {
      process.stderr.write(`[tasks] update failed: ${err.message}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

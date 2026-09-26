# Routines, the morning planner and reminders

**How the assistant does things for people without being asked each time.**

---

## TL;DR

- A **routine** is a standing duty the assistant has toward one person ("check my inbox
  every hour", "send the team recap on Fridays"). The sidebar's **Routines** view shows
  them; they live in that person's `RESPONSIBILITIES` memory card.
- The **morning-planner** skill turns routines — together with the calendar, tasks and
  open threads — into the day's **reminders**. A reminder is an instruction for the
  assistant to *do* something at that moment, not a note for a human.
- **`reminder-monitor`** fires due reminders into the assistant, which does the work and
  reports only what is worth reporting.

```
RESPONSIBILITIES card ──► morning-planner (daily, per person) ──► .reminders.json ──► reminder-monitor ──► the assistant runs it
   (the routines)         + calendar, tasks, open threads           (today's plan)      (every 60 s)          and reports the outcome
```

---

## Routines

Where they live:

| Mode | File |
|---|---|
| Solo | `memory/RESPONSIBILITIES.md` |
| Team | `memory/users/<slug>/RESPONSIBILITIES.md` (private to that person) |

The card is prefix-loaded, so the assistant knows its duties on every turn. It is one
flat list; each entry reads:

```
- {mail} **Inbox watch** — every hour, flag anything a customer is waiting on. #email
```

An icon, a short bold title, a plain-language description that says what to do and how
often or on what condition, and a few `#tags`. The template's frontmatter
(`bootstrap/memory-cards-templates/RESPONSIBILITIES.md`) is the specification.

**Adding a routine** — the user just says it ("from now on…", "every Friday…", "add a
routine…"). The assistant does two things in the same turn:

1. writes the duty into `RESPONSIBILITIES` with `memory_write` (a flat-list card: the
   engine always writes into its one list, whatever `section` the caller passes);
2. runs the `morning-planner` so the duty takes effect today, not at tomorrow's plan.

A duty written without step 2 is inert text until the next morning run.

**Not the cloud scheduler.** Claude Code ships a built-in `schedule` skill for Anthropic's
cloud routines. A self-hosted workspace cannot reach that service, and its description
matches the word users type ("routines"), so `hooks/skill-fence.mjs` denies the
`schedule` / `routines` / `cron` skills outright and tells the model the real sequence
above. `global-claude.md` also bans CronCreate/CronList and SDK cron.

**The Routines view** (`frontend/src/components/workspace/views/ResponsibilitiesDashboard.jsx`)
reads the card and renders one tile per entry. It accepts an entry with or without its
`- ` marker and with or without the braces around the icon; a line it still cannot
parse is shown as-is in a warning rather than dropped. The view updates live when the
card changes (the memory wiki is watched — see ARCHITECTURE.md).

## The morning planner

`skills/default/morning-planner/SKILL.md`. It runs:

- from the `[PLAN_DAY_TRIGGER]` system reminder — daily at **06:00 in the workspace
  timezone** (`IDE_TIMEZONE`, default UTC);
- on demand ("/plan", "plan my day");
- right after a routine is added or changed.

In team mode each member has their own trigger (`r_system_plan_day__<slug>`, created by
`bootstrap/reconcile-reminders.py`) that runs the planner **as that member**, so it can
read their private cards and plans only them.

What a run does:

1. **Refresh** — runs the `context-refresh` skill: reads the live sources (email,
   calendar, tasks, the org's integrations), reconciles memory and writes
   `memory/users/<slug>/CONTEXT_BRIEF.md`.
2. **Read** — the brief, the person's `RESPONSIBILITIES`, `USER_PROFILE`,
   `USER_PREFERENCES`, calendar and tasks, and the reminders already set.
3. **Decide** — for each duty, whether it applies today and when: the time of day that
   fits the work and the person's chronotype, around meetings and focus blocks, with
   slack left in the day; condition-based duties only when the condition holds; up to
   one or two soft follow-ups on threads that went quiet.
4. **Place** — `set_reminder` for each item with `origin: "planner"`, the person as
   `recipient`, their preferred reachable channel, and an urgency.

The automatic run is silent — the plan lives in the reminders. An on-demand run answers
with one line. The planner only reads context and sets reminders; anything external
(sending mail, changing a calendar) becomes a proposal for the user to approve.

Each run replaces the planner's own previous reminders (`origin: "planner"`); the user's
own reminders and system rituals are never touched.

## Reminders

Stored in `~/project/.reminders.json`, written by `apps/reminder-mcp` (`set_reminder`,
`list_reminders`, `cancel_reminder`) and by the Reminders panel (cancel only).

| Field | Meaning |
|---|---|
| `title`, `description` | What to do |
| `due` | Next fire time (ISO, UTC) |
| `recur` | `interval` (every N minutes/hours/days/weeks), `weekly` (days + time), `monthly` (day or `last` + time); optional `until` / `count` / `skip_hours` / `skip_days`. Times are **UTC** |
| `urgency` | `now` (default) or `ambient` — a soft item woven into conversation at a natural opening |
| `channel` | `telegram`, `web` or `all` |
| `recipients` | Roster slugs, or everyone (admin only) |
| `origin` | `planner` for planner-placed items |
| `kind` | `system` for the seeded rituals (protected from cancel) |

**System rituals** (`bootstrap/reminders.json`, re-synced on every boot):

| Trigger | Skill | When |
|---|---|---|
| `[PLAN_DAY_TRIGGER]` | `morning-planner` | Daily 06:00, workspace timezone |
| `[REPO_AUDIT_TRIGGER]` | `repo-audit` | Monday 09:00 UTC |
| `[BACKUP_TRIGGER]` | `project-backup` | Friday 14:00 UTC |

## Firing

`bot/reminder-monitor.sh` (PM2, every 60 s) claims each due reminder and routes it:

| Reminder | Route |
|---|---|
| Targets a Telegram group (`chat`) | `/api/internal/group-say` — the group assistant composes it |
| Solo, or for the operator | `[REMINDER …]` / `[AMBIENT …]` frame into the operator's session; if that session is busy or offline, a headless turn |
| A teammate's planner trigger (`exec`) | `/api/internal/invoke-turn` — runs as that teammate |
| Other teammate reminders | `/api/internal/reminder-deliver` — a notification with the stored text |

A reminder is consumed only once delivery is confirmed; failures retry with backoff
(1/2/4/8 min) and, after five attempts, are marked dead and reported to the operator
once. Repeating reminders carry a watermark — "only report what is new since <last
run>" — so a recurring check does not re-report old findings.

**What the assistant does with a frame** (`global-claude.md`): do the work first, then
send exactly one message about the outcome — or nothing, if nothing is worth raising.
Never acknowledge the frame, never announce the check, never explain the silence. Before
relaying anything stateful (a follow-up, "chase X"), re-check the live source.

Every fire attempt is appended to `~/project/.reminders-log.jsonl` (delivery path and
result, not the finding).

## Known gaps

Tracked for the next iteration of this system:

- Planner reminders addressed to a teammate are delivered as text by
  `reminder-deliver` rather than executed by the assistant.
- The planner's replace step cancels its previous reminders before placing new ones; a
  run interrupted in between leaves the day without them.
- Recurrence is UTC-only, so a fixed local time drifts by an hour at DST changes.
- `/api/internal/invoke-turn` is team-mode only; a solo workspace with a busy session
  has no headless fallback.
- Nothing records what a run *found* — only whether it was delivered.

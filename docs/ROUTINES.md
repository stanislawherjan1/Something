# Routines, the morning planner and reminders

## User guide

A **routine** is a standing job your coworker does for you without being asked
each time: "check my inbox every hour", "send the team a recap on Fridays",
"before each meeting, pull the notes from the last one". Say it in a
conversation, or pick one from the **Marketplace** under **Routines** in the
sidebar, where routines are offered for every service you have connected.

Every morning the coworker plans its day: it reads your routines, your
calendar, your tasks and the threads left open, and sets itself reminders for
what to do and when. A reminder is work for the coworker, not a note it
forwards to you: when the time comes it does the job and tells you what came
of it, or stays quiet when there is nothing worth saying.

It spreads its messages through the day instead of sending several at once, and
never in the middle of a meeting; anything tied to an exact time (a meeting,
leaving for a train) comes right on time, and background checks (your inbox
every few minutes) run as often as you asked, quietly unless they find something.

It also learns from how its reminders land. A weather note you just read is fine
as it is; a reminder that keeps asking you to act and gets nothing back is moved
or reshaped, and after a week it asks you once whether to pause it. Now and then
— at most once a week — it may suggest a routine or a connection that fits what
you do; say no and it won't ask again.

The **Routines** view shows what it has taken on. Pause or remove a routine
there, or just tell it. A Marketplace routine that needs a service you have not
connected offers **Connect** right there, for your own account; one picked
before its service was connected waits on the Routines view and starts by itself
once it is. Times follow your own time zone from Settings. In a
team workspace each person has their own routines, and the coworker does them
as that person, with their calendar and their accounts.

---

**How the assistant does things for people without being asked each time.**

---

## TL;DR

- A **routine** is a standing duty the assistant has toward one person ("check my inbox
  every hour", "send the team recap on Fridays"). The sidebar's **Routines** view shows
  them; with memory v4 they live in that person's `routines.json` (before v4, in their
  `RESPONSIBILITIES` card — see [With memory v4](#with-memory-v4)).
- The **morning-planner** skill turns routines — together with the calendar, tasks and
  open threads — into the day's **reminders**. A reminder is an instruction for the
  assistant to *do* something at that moment, not a note for a human.
- **`reminder-monitor`** fires due reminders into the assistant, which does the work and
  reports only what is worth reporting.

```
routines.json ──────────► morning-planner (daily, per person) ──► .reminders.json ──► reminder-monitor ──► the assistant runs it
   (the routines)         + calendar, tasks, open threads           (today's plan)      (every 60 s)          and reports the outcome
```

---

## Routines

Where they live: with memory v4, `.team/users/<slug>/routines.json` (solo:
`.team/users/default/routines.json`); before v4, the `RESPONSIBILITIES` card
(`memory/RESPONSIBILITIES.md`, team: `memory/users/<slug>/RESPONSIBILITIES.md`). Either
way they reach the assistant on every turn (the `ROUTINES` block, fresh via
`memory_now`). The bot writes one as a line in the duty grammar:

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

### With memory v4

Once a deployment is on memory v4 ([MEMORY.md](MEMORY.md#how-it-works)), routines
leave memory and become data of their own: `.team/users/<slug>/routines.json`
(solo: `.team/users/default/routines.json`), private by path like the chat
history next to it. Migration `0004` seeds it from the card (lines the grammar
cannot read are kept as `unparsed`, never dropped; a duty written outside the
card's sections still counts), and the move (`0005`) removes the card once
routines.json holds its duties.

Nothing changes for the model: `memory_write` into `RESPONSIBILITIES` lands in
routines.json (the same duty again, or a correction, updates that routine;
retiring it retires the routine), and the prefix carries a `ROUTINES` block in
place of the card. The Routines view reads `GET /api/routines`.

People change their routines on the screen too: **New routine** (a title and what
to do are required — the planner works from that instruction; an icon and tags are
optional), and in a routine's detail **Edit** and **Delete**. Any routine can be
edited, a Marketplace one included; an edited catalog routine keeps its
`catalogId` (still shown as Added) and drops the catalog's one-line summary, which
would describe the old version. Delete retires it — the planner stops scheduling
it, the history stays. The bot does the same in conversation through
`memory_write` (remember / supersede / retire).

| Endpoint | Does |
|---|---|
| `POST /api/routines` | `{ title, description, icon?, tags? }` → a new routine (`source: "ui"`); 400 without a title or description |
| `PATCH /api/routines/:id` | Edits the viewer's own routine (any of the same fields) |
| `DELETE /api/routines/:id` | Retires it |

### Marketplace

Routines has a **Your routines · Marketplace** switch (v4 only). The Marketplace
offers ready-made routines from `workspace-api/routines.catalog.json` (an optional,
gitignored `routines.catalog.local.json` merges on top for one client): an
**Everyday** section for routines that need no integration, then one section per
**connected** integration — an entry's `requires` is an any-of list of
integration ids, and entries whose integrations aren't connected and usable are
not shown. **Add** writes an ordinary routine into the person's list
(`source: "catalog"`, `catalogId`); the planner runs it like any other, so a
catalog entry states its cadence and its "only tell me when…" condition in prose
— a routine is the bot's duty, which may prepare its own reminders, never a
reminder for a person. **Remove** retires it.

| Endpoint | Does |
|---|---|
| `GET /api/routines/catalog` | `{ groups: [{ id, label, logo, routines: [{ id, title, description, icon, tags, added }] }] }` for the viewer |
| `POST /api/routines/catalog/:id` | Adds it to the viewer's routines; idempotent; 409 until its integration is connected. `?later=1` keeps it waiting instead (`routines-waiting.json`, `lib/routines-add.js`): it never runs while waiting and is added by itself once the integration connects |
| `DELETE /api/routines/catalog/:id` | Retires the viewer's routine that came from it, or drops it from the waiting list |

`GET /api/routines` carries `waiting` next to `routines`: the Routines screen
shows each as a dashed tile, "Starts once <app> is connected", with **Connect**
and **Remove**. It is rare now (onboarding's plan keeps Add off until the app is
connected) and comes mostly from earlier setups.

Each entry has a `summary` (the one line people read on a tile) and a
`description` — the full instruction the bot works from: which source to read
(the task board, the mailbox tools, the calendar, which integration), how often,
the exact threshold for speaking up, and where the output goes. `requires` is
any-of; `requiresAll` lists integrations that must all be connected (a
"where is my order" routine needs the mailbox *and* Shopify). Entries for
integrations that aren't connected are listed too, greyed, with **Connect**: it
opens that integration's install modal right there: an admin connects it for
the team, a member their own account (`?reach=personal`); only a service that is
the team's alone (the mailbox, Telegram) tells a member to ask an admin. A
service's logo sits on white in both themes. When any of several integrations would do, Connect first lays
them out under the routine to pick one.
The Marketplace has one search over titles, text, tags and integration names, and
a filter list: All / Ready to add / Added, categories, integrations.

The rules every routine run follows (stay silent unless it changes what the
person does; keep working notes in `.routines/<routine>.md`; never report the
same item twice; ask once for what only the person knows; never send, post,
archive, pay or change anything without a yes; stop if a source isn't
connected; the default "off" threshold) are stated once, at the top of the
ROUTINES block in the bot's prefix (`ROUTINE_RULES` in `lib/claude.js`), not
repeated in every routine. That block carries each routine's full instruction.

The catalog is validated at load (unique ids, a known category, a summary, every
`requires`/`requiresAll` id exists in the integrations catalog).

**Everyday life** is the casual category: weather, good news, a fact about a chosen
topic, a word of the day, weekend events, dinner ideas, birthdays, a Friday list of
wins. Routines that only search the web (these, and the research ones that don't
scrape a specific page) need no integration: they use Parallel's tools when it is
connected and the bot's built-in web search otherwise.

**The bot suggests them.** The `routines` skill carries the whole catalog in
`references/catalog.md` (generated from the catalog by `lib/routines-reference.js`;
run it after editing the catalog — a test fails while it is stale). When a routine
fits what the person said — a recurring need, a newly connected integration, "what
can you do?" — the bot suggests it in plain words, one at a time, and adds it with
the `add_routine` tool after a yes (`POST /api/internal/routines/catalog/:id`:
loopback, the turn's own person, refused in groups and until its integration is
connected; idempotent). The added routine is the same as one added with the button.

## The morning planner

`skills/default/morning-planner/SKILL.md`. It runs:

- from the `[PLAN_DAY_TRIGGER]` system reminder — daily at **06:00 in the person's own
  time zone** (Settings → Time zone; without one, the workspace default an admin sets in
  Settings, else `IDE_TIMEZONE`, else UTC). See [Time zone and language](#time-zone-and-language);
- on demand ("/plan", "plan my day");
- right after a routine is added or changed.

Every run starts with `memory_now` — fresh "Right now", "What I'm keeping track
of", settings and routines (the Telegram brain's prefix can be days old) — then
the live sources (calendar, mail, tasks), and `memory_search` for any detail it
needs. A tracked thread with a date today or tomorrow becomes a reminder for the
bot (a flight → check-in and the route the day before); a status reshapes the day
(travelling → their zone, no office items).

In team mode each member has their own trigger (`r_system_plan_day__<slug>`, created by
`bootstrap/reconcile-reminders.py`) that runs the planner **as that member**, so it can
read their private cards and plans only them.

What a run does:

1. **Refresh** — `memory_now` for the person's fresh routines, settings, "Right
   now" and "What I'm keeping track of".
2. **Read** — the live sources (calendar, mail, tasks, the org's integrations),
   `USER_PROFILE` and `USER_PREFERENCES`, `memory_search` for any detail, and the
   reminders already set.
3. **Decide** — for each duty, whether it applies today and when: the time of day that
   fits the work and the person's chronotype, around meetings and focus blocks, with
   slack left in the day; condition-based duties only when the condition holds; up to
   one or two soft follow-ups on threads that went quiet.
4. **Place** — one `replace_plan` call with the whole plan: the person as `recipient`,
   the channel MY_SETTINGS says reaches them ("Reaches them on"), an urgency, and
   `timed: true` for an item whose time itself matters. It validates every item as
   `set_reminder` does and, under one hold of the reminders lock, removes the planner's
   previous plan for that person and writes the new one; a bad item changes nothing, so a
   run that stops half-way leaves yesterday's plan in place.

The automatic run is silent — the plan lives in the reminders. An on-demand run answers
with one line. The planner only reads context and sets reminders; anything external
(sending mail, changing a calendar) becomes a proposal for the user to approve.

Each run replaces the planner's own previous reminders (`origin: "planner"`); the user's
own reminders and system rituals are never touched.

**Feedback.** Each planner reminder carries `kind_of` (`info` / `action`, the tool's `kind`)
and `routine`. `/internal/invoke-turn` records each run's outcome (said / silent / sent
itself) in `WSAPI_STORE_DIR/planner/outcomes.jsonl`; `lib/planner-feedback.js` reads the
planner's fired one-shots (tombstones in `.reminders.json`), those outcomes, and whether the
person wrote within 2 h (web chats, Telegram DMs), and `memory_now` ends with the summary per
routine, plus routines removed and suggestions made lately (`routine: "suggest:<what>"`,
never repeated). An `info` routine changes only on an explicit signal; an `action` one that
rarely leads anywhere is moved, reshaped, or offered for a pause once.

**Pacing.** The monitor holds a planner one-shot that reaches the person on its own (not
`ambient`, not recurring, not `timed`) until `REMINDER_MIN_GAP_MINUTES` (default 45) after
the last one reached them — at most one per person per pass, nothing dropped (`pacedFrom`
keeps the planned time). The person's own reminders, recurring duties and system triggers
keep their time.

## Time zone and language

Each person sets their **time zone** and **reply language** in **Settings** (the
user menu → Settings, a page at `/settings`). The bot changes them when the person
asks, or plainly says they are now somewhere else, with the `set_my_settings` tool;
a padlock next to each setting stops the bot from changing it (only the person
can, in Settings). The bot's prefix carries both in a `MY_SETTINGS` block, and the
morning planner places the day's reminders in that zone. Admins also set the
workspace **Default time zone**, used by everyone who hasn't set their own (it
overrides `IDE_TIMEZONE`).

| Endpoint | Does |
|---|---|
| `PATCH /api/me` | `timezone`, `timezoneLocked`, `preferredLanguage`, `languageLocked` (plus name and Telegram fields); a new zone moves the next morning planning |
| `PUT /api/team/default-timezone` | Admin: `{ timezone }`; moves the planning of everyone without their own zone |
| `POST /api/internal/me/settings` | The bot's `set_my_settings` (loopback, turn identity); refused in groups and on a locked setting |

## Reminders

Stored in `~/project/.reminders.json`, written by `apps/reminder-mcp` (`set_reminder`,
`list_reminders`, `cancel_reminder`) and by the Reminders panel (cancel only). The panel
lists active reminders only; `sent` / `dead` records stay in the file for 30 days as
history.

| Field | Meaning |
|---|---|
| `title`, `description` | What to do |
| `due` | Next fire time (ISO, UTC). A one-shot more than 5 minutes in the past is refused by `set_reminder`, with the current time in the workspace timezone, so a plan placed on the wrong date is fixed instead of firing all at once |
| `recur` | `interval` (every N minutes/hours/days/weeks), `weekly` (days + time), `monthly` (day or `last` + time); optional `until` / `count` / `skip_hours` / `skip_days`. Times are **UTC** |
| `urgency` | `now` (default) or `ambient` — a soft item woven into conversation at a natural opening |
| `channel` | `telegram`, `slack`, `web` or `all` (`slack`: the result goes to the person's Slack DM with the bot; for the operator it runs as a headless turn, since the tmux brain has no Slack) |
| `recipients` | Roster slugs, or everyone (admin only) |
| `origin` | `planner` for planner-placed items |
| `timed` | `true` when the time itself matters; such an item is never held back for pacing |
| `kind_of` | `info` or `action` (the tool's `kind`), for the planner's feedback |
| `routine` | the routine a planner reminder comes from; `suggest:<what>` for a suggestion |
| `kind` | `system` for the seeded rituals (protected from cancel) |

**System rituals** (`bootstrap/reminders.json`, re-synced on every boot):

| Trigger | Skill | When |
|---|---|---|
| `[PLAN_DAY_TRIGGER]` | `morning-planner` | Daily 06:00, the person's time zone |
| `[REPO_AUDIT_TRIGGER]` | `repo-audit` | Monday 09:00 UTC |
| `[BACKUP_TRIGGER]` | `project-backup` | Friday 14:00 UTC |

## Firing

`bot/reminder-monitor.sh` (PM2, every 60 s) claims each due reminder and routes it:

| Reminder | Route |
|---|---|
| Targets a Telegram group (`chat`) | `/api/internal/group-say` — the group assistant composes it (a person's own "post this in the group" goes word for word through `/api/internal/group-post` instead) |
| Solo, or for the operator | `[REMINDER …]` / `[AMBIENT …]` frame into the operator's session; if that session is busy or offline, a headless turn |
| A teammate's planner trigger (`exec`) | `/api/internal/invoke-turn` — runs the planner as that teammate |
| A reminder the planner placed for a teammate (`origin: planner`) | `/api/internal/invoke-turn` with `deliver` — the assistant does the work **as that teammate**; its final reply is delivered to them (a thread in their chat, plus Telegram and/or Slack per `channel` and their preference); a `[[SILENT]]` reply sends nothing. The reminder's own text is never shown to them |
| A plain reminder a user asked for ("remind me at 3…") | `/api/internal/reminder-deliver` — a notification with the stored text |

A reminder is consumed only once delivery is confirmed; failures retry with backoff
(1/2/4/8 min, kept in `retryAt` so the schedule itself never moves). After five attempts
a one-shot is marked `dead` and reported to the operator once; a repeating reminder skips
that one occurrence (`missedAt` on the record, reported once) and continues on its
schedule. A reminder for the operator and teammates is settled per leg (`deliveredTo`):
a retry repeats only the leg that did not get through. Repeating reminders carry a
watermark — "only report what is new since <last run>" — so a recurring check does not
re-report old findings.

If `.reminders.json` cannot be parsed, nothing fires: the monitor says so in its log on
every tick and tells the operator once, the reminder tools refuse to write (a copy of the
unreadable file is kept as `.reminders.json.corrupt`), and the boot-time reconcile leaves
the file alone.

**What the assistant does with a frame** (`global-claude.md`): do the work first, then
send exactly one message about the outcome — or nothing, if nothing is worth raising.
Never acknowledge the frame, never announce the check, never explain the silence. Before
relaying anything stateful (a follow-up, "chase X"), re-check the live source.

Every fire attempt is appended to `~/project/.reminders-log.jsonl` (delivery path and
result, not the finding).

## Known gaps

Tracked for the next iteration of this system:

- Recurrence is UTC-only, so a fixed local time drifts by an hour at DST changes. The
  morning planning is pulled back to 06:00 local by an hourly pass; other rituals are not.
- `/api/internal/invoke-turn` is team-mode only; a solo workspace with a busy session
  has no headless fallback.
- Nothing records what a run *found* — only whether it was delivered.

---
name: morning-planner
description: Plan the day like a proactive colleague. Each morning, read your RESPONSIBILITIES (standing duties + proactive directives), the calendar, tasks, open threads, and the reminders already set — then anticipate what today needs and place timed reminders at concrete hours. Works SILENTLY (sets reminders, posts nothing) and stays entirely inside the platform (it only READS context and SETS reminders — it never sends email or changes anything over an API; external actions become reminder SUGGESTIONS for the user to approve). Triggered by `[PLAN_DAY_TRIGGER]` (daily reminder, see global-claude.md trigger table) or manually via "/plan", "plan my day", "plan today".
allowed-tools: Read, Bash, Write, Edit, mcp__reminders__set_reminder, mcp__reminders__list_reminders, mcp__reminders__cancel_reminder, mcp__gcalendar__list_calendars, mcp__gcalendar__list_events, mcp__gtasks__list_task_lists, mcp__gtasks__list_tasks, mcp__trello__list_boards, mcp__trello__list_lists, mcp__trello__list_cards, mcp__email__list_recent, mcp__email__search, mcp__email__read_message, mcp__shopify__get_sales_summary, mcp__shopify__get_orders, mcp__shopify__get_low_inventory, mcp__meta__get_campaign_performance, mcp__meta__get_ad_account_insights, mcp__google-ads__search, mcp__github__list_issues, mcp__github__list_pull_requests, mcp__gdrive__list_recent, mcp__x__user_mentions, mcp__substack__list_comments
---

# Morning planner — plan the day like a colleague, not a cron

Each morning you plan your own 24h. You are not executing a fixed schedule of
recurring reminders — you look at today's real context and decide what a
thoughtful colleague would do, then lay it out as timed reminders.

## When this fires

- `[PLAN_DAY_TRIGGER]` arrives (the daily morning reminder — see the trigger
  table in `global-claude.md`).
- Someone says "/plan", "plan my day", "plan today", "what's the plan for today".
- **Right after you record a new or changed duty** in `RESPONSIBILITIES` — run this
  to fold it into today's reminders, so the duty takes effect the same day, not only
  at tomorrow's 06:00 run. (You are the single owner of duty→reminder; nothing else
  hand-creates a reminder for a duty.)

## Who you plan for — ONE person per run (named in the trigger)

Each `[PLAN_DAY_TRIGGER]` plans exactly ONE person. The trigger names them as `slug=<x>`.
You plan **that person and only that person.** Do NOT loop a roster in a single run — that
reliably drops people. In a team, every member has their **own** trigger that fires
separately, so everyone gets planned across the day's triggers, one clean run each.

- **Trigger carries `slug=<x>`** → plan person `<x>`. **Re-read their CURRENT cards now** —
  `memory/users/<x>/RESPONSIBILITIES.md` + `USER_PROFILE.md` + `USER_PREFERENCES.md`. Do
  not rely on anything you concluded about them earlier in this session; a card may have
  changed since. Read their existing reminders, then set THEIR reminders with
  `recipient: <x>`, on the channel **they** prefer (read it from their `USER_PREFERENCES`,
  not the operator's).
- **No slug** (a plain `/plan`, or a solo workspace) → plan the operator, your own user,
  whose cards are already in your prefix. Omit `recipient` (it defaults to the operator).

Their reminders are private to them (recipient-scoped) — a plan never leaks across the
team. Reading that person's own cards to build *their own* plan, delivered only to *them*,
serves the owner; it is the one sanctioned cross-member read (see RULES).

## Hard boundaries (do not cross)

1. **Silent on the automatic run.** When this fires from `[PLAN_DAY_TRIGGER]` (the
   06:00 run), set the day's reminders and STOP — no plan, summary, or "here's today"
   message. The plan lives in the reminders; the user sees them in the Reminders view
   and as each one fires. **On-demand is different:** when the user just asked (a
   `/plan`, or you're folding in a duty they gave you), a brief one-line confirmation
   of what you scheduled is fine — that's a reply to them, not a daily digest.
2. **Inside the platform only.** You may READ context and SET reminders — nothing
   else. You do NOT send email, create/modify calendar events, move Trello cards,
   or make any external/API change. When today calls for such an action, you
   schedule a reminder that PROPOSES it ("Suggest to the team: email the lawyer
   about the objection — want me to draft it?"), so the user decides when it fires.
3. **No duplicates, no clutter.** Read the reminders already set and don't
   re-create them. **Default to one-shots** (`repeat: none`) placed for TODAY —
   that is the point of daily planning; rigid always-on recurring reminders for
   everything is the anti-pattern this replaces. **One exception:** a duty with a
   genuinely fixed **sub-daily / continuous** cadence a daily plan can't express
   (`(hourly)`, `(every 30m)`) gets **ONE standing recurring reminder**, set once —
   and on every later run you LEAVE it (a live recurring reminder already covers
   that duty; never create a second). A daily / weekly-at-a-set-time / contextual
   duty is NOT that exception — plan those as one-shots.

## Step 0 — refresh the context first (run `context-refresh`)

Before you plan anything, sync with reality. **Load and run the `context-refresh` skill for
this person** (pass the same `slug=<x>`, or the operator if no slug). It checks the LIVE
sources (email, calendar, tasks, the org's active integrations) + curated memory, reconciles
them, UPDATES memory wherever a source has moved, and writes a short current-state brief at
`memory/users/<slug>/CONTEXT_BRIEF.md`. That refreshed memory + brief is your GROUND TRUTH.
Do this FULLY before Step 1 — a plan built on a stale snapshot is the failure this prevents.

## Step 1 — read the fresh context (read only)

With `context-refresh` done, you plan from VERIFIED state. **Ground every plan item in the
brief, a live source, or a standing duty — never in a raw reflect card** (reflect is a weak,
auto-generated hint; context-refresh has already reconciled what's actually real and current).

- **The current-state brief:** `Read` `memory/users/<slug>/CONTEXT_BRIEF.md` — what's live,
  changed, or still open today, each grounded in its source. This is the heart of today's
  context; the reminders you set should mostly trace back to a line here or a standing duty.
  (Memory was just refreshed too, so the cards you read below are current.)
- **Your duties toward this person:** their `RESPONSIBILITIES` card — what you do FOR
  them. (The operator's is already in your prefix; for a teammate you're planning,
  `Read` `memory/users/<slug>/RESPONSIBILITIES.md`.) One flat list; each line carries
  its trigger — a fixed cadence (`(daily)`, `(weekly:Fri)`, `(hourly)`) or a condition
  described in the line ("...when a thread is quiet 3+ days").
- **How this person works:** their `USER_PROFILE` + `USER_PREFERENCES` (the operator's
  are in your prefix; a teammate's you `Read` from their dir — see "Who you plan for").
  Timezone, working hours, deep-work / focus blocks, quiet times, the channel they
  prefer, and what they want surfaced vs kept silent. **Plan the day to FIT this** —
  don't drop a reminder into a focus block or quiet hours, honour their working hours,
  match their preferred channel, and respect their surface-vs-silence preferences. A
  good plan reads like it was made by someone who knows how they like to work.
- **Timed schedule for placement:** the calendar (`list_events`, next ~24–36h) and tasks
  (`list_tasks` + the local `.tasks.json` board, plus Trello `list_cards` if the org uses
  it). You need the concrete event / due TIMES to place reminders around them. context-refresh
  already assessed these for the brief; here you're just pulling the times you'll schedule to.
- **What's live / changed / open** already came from the brief — the email, the org's
  integrations (Shopify, ads, GitHub, Trello…), and the VERIFIED open loops. Don't re-derive
  them from scratch, and never act on a reflect item the brief didn't confirm as still open.
- **Already-set reminders — REPLACE your own, plan around the rest:** `list_reminders` —
  everything ALREADY set. Split it in two and treat each half differently:
  - **Yours** (`origin: "planner"`) — your entire previous plan. **Cancel ALL of it now, up
    front — every one, one-shot AND recurring** (`cancel_reminder` each). You re-lay the whole
    plan from scratch below, so nothing survives to be duplicated and nothing lingers: a
    recurring reminder never expires on its own, so if you didn't wipe it, each run would stack
    another copy (5 runs → 5 hourly inbox checks). This is a clean deterministic replace — no
    matching-by-title, no guessing what "superseded" means: the new plan simply IS the whole
    planner set. The still-relevant standing recurring duties get RE-CREATED in Step 2 — that's
    exactly why the sub-daily rule there is a HARD create, not a maybe.
  - **Not yours** (no `origin: "planner"` — the user's own reminders and every `kind:system`
    ritual) — **fixed points. Plan AROUND them, never cancel them, never duplicate them.** An
    untagged reminder is one the USER set for themselves and is untouchable. Today's plan
    replaces YOUR whole set; it never touches the user's or the system's.

## Step 2 — think ahead (this is the point)

Don't just transcribe duties into reminders. Go through the responsibilities and
**decide how to action each one today** — a cadence-triggered line schedules on the
clock; a condition-triggered line means *check whether the condition holds today, and
only then act*. For today's context, ask *what would a proactive colleague do?*

- A **deadline** approaching this week → schedule prep/a nudge ahead of it, not on
  the day it's due.
- A **meeting** that needs materials → a reminder the appropriate time before to
  prepare (or to propose preparing) them.
- A **thread** quiet for a few days that a duty says to follow up on → a reminder
  to propose the follow-up.
- A **recurring duty** whose cadence hits today (`(daily)`, `(weekly:Fri)` when today is
  Friday) → place a one-shot at a sensible hour. If its cadence is **sub-daily / continuous**
  (`(hourly)`, `(every 30m)`, "in the background") → it MUST be covered by ONE standing
  recurring reminder, because that recurring reminder is the ONLY mechanism that makes the
  duty actually fire on cadence. Since you wiped your own reminders up front (Step 1 replace),
  **CREATE it fresh now** (e.g. `recur: {"type":"interval","every":1,"unit":"hours"}`) — the only
  reason to skip is a NON-planner reminder (a `kind:system` ritual or one the user set) that
  already covers the same cadence, which you leave untouched.
  A morning one-shot does NOT satisfy an "every hour" duty, and "it'd be too noisy" is not a
  reason to skip it — the reminder fires quietly and the bot reports only when there's
  something worth flagging, staying silent otherwise. Do not reason your way out of it.
- Nothing pressing? A light day is fine — place only what genuinely helps. Better a
  short honest plan than busywork.

**First write the plan, then set reminders.** Reason the whole day through in prose — the
fixed points, what genuinely matters today, where each thing goes — and only THEN place
them. Don't think by making tool calls.

**Prioritise like a colleague — a few real things, not a wall.**
- **One frog.** Surface the single most important / most-avoidable task FIRST, early in
  their day, before the noise crowds it out. Just one.
- **Protect the important-but-not-urgent.** The things with no deadline (deep work on the
  big goal, a key relationship, planning) get skipped by default — deliberately place one.
- **Keep it light: aim to fill ~60% of the day, leave the rest as slack.** People
  underestimate how long things take (inflate your mental estimates ~1.4×). If the day is
  already busy, add LESS and say so. A handful of well-placed nudges, never a barrage.

**Match time-of-day to the work** (from their `USER_PROFILE` hours / chronotype):
- Hard, analytic, high-stakes work → their **morning peak**; put the frog here.
- Routine / admin / email / low-stakes → the **early-afternoon dip (~14:00)**; never put
  high-stakes items there.
- Creative / looser work → **late afternoon**. A night-owl chronotype shifts all of this
  ~2–3h later — read their real hours, don't assume 9-to-5.

**Classify how each reminder should REACH them** (this drives delivery, see Step 3 `urgency`):
- **`now`** — time-critical, missed otherwise: "meeting in 30 min", a hard deadline. Fires
  the moment it's due, standalone.
- **`ambient`** — soft / general-interest: weather, the day's overview, a gentle nudge. NOT
  blurted as a standalone topic — woven into conversation at a natural opening. Most
  morning-brief items are `ambient`.

## Proactive follow-ups — catch what quietly stalled

Part of thinking ahead is noticing what went quiet with a loose end. Use the **VERIFIED open
loops from the brief** (context-refresh already checked each against the live source, so these
are genuinely still open — not stale reflect residue and not something the email already
resolved). Pick the ones that (a) carry a real unresolved item, (b) went quiet a day or more
ago, and (c) you have NOT already nudged. For each genuinely useful one, set an `ambient`
reminder whose content IS the proactive follow-up:

- **Specific, with a concrete offer.** "That thread with <them> stalled yesterday with
  <the open question> unanswered — want me to draft a nudge?" beats "you have an open
  thread." Name the real topic + a concrete next step you could take.
- **`ambient`, never `now`.** A follow-up is soft — it slips into the next natural opening
  in conversation, it doesn't fire as a standalone alert. That's the difference between a
  helpful colleague and a nagging bot.
- **It MUST self-verify when it fires (the key rule).** Between planning now and the nudge
  landing later, the thread may have been resolved, or the conversation may have moved to
  something else entirely. So phrase the reminder to RE-CHECK before raising it: *"…before
  bringing this up, glance at the current state — if it's since been resolved or the
  conversation has clearly moved on, drop it silently; only if it's still open, weave it in
  subtly at a fitting moment, don't force it."* A stale follow-up raised anyway is worse
  than saying nothing.
- **Once per thread, then back off.** When you set a follow-up, mark it — write a one-line
  marker `memory/users/<slug>/_proactive/<thread-id>.md` (today's date + what you nudged) —
  and SKIP any thread that already has a marker, unless it has fresh activity since (a new
  loop). Never re-nudge the same stalled thread every morning: one gentle poke, then leave
  it. Cap at one or two follow-ups per run; choose the ones that genuinely move something.

## Step 3 — place the plan as timed reminders

For each thing that should happen at a time today, `set_reminder`:

- `due`: a concrete time **today, in the person's local timezone** — read the timezone
  from `USER_PROFILE`, place reminders at LOCAL times (within working hours, clear of
  focus blocks and quiet times), and convert to the UTC the tool stores. **Never place a
  reminder in the past:** check the current time first. The trigger normally runs at
  06:00 UTC (before most workdays), but if you're planning later in the day — a manual
  `/plan`, or a member whose local time is already afternoon — a duty whose usual slot
  has already passed goes at the next sensible point still ahead, or is skipped for
  today. Don't backfill a 9am brief at 3pm.
- `repeat`: `none` for the day's one-shots. Only the sub-daily-cadence exception
  above uses a `recur` (e.g. `{ "type":"interval", "every":1, "unit":"hours" }`) —
  and only when one isn't already live.
- `message`: phrase it as a concrete **if-then / when-what** — the time, the specific
  action, and briefly why: "at 13:00 leave for the Kamil meeting, bring the deck" beats
  "meeting today". Name the real event/task it comes from; a reminder with no genuine
  source item should not exist (don't invent filler). Never restate the duty text verbatim
  — a reminder is a decision (when + what), not a copy. For an `ambient` item, write it so
  it drops into a conversation naturally. For anything external, phrase it as a PROPOSAL
  the user approves ("Suggest: send the weekly report — want me to draft it?").
- `urgency`: `now` (fires immediately, standalone) or `ambient` (soft — held and woven in
  at the next natural opening, never blurted). Classify per Step 2. Default to `ambient` for
  gentle items; reserve `now` for the genuinely time-critical.
- `channel`: the person's preferred channel, read from THEIR `USER_PREFERENCES` (not the
  operator's), but only a channel they can actually receive on. A teammate who prefers
  Telegram yet is not linked to it (the roster shows no Telegram for them) is unreachable
  there: use `web`, which is always available. Never set or promise a channel the person is
  not linked to.
- `recipient`: the person this run is planning (`recipient: <slug>`) — so it reaches THEM
  and stays private to them. No-slug / solo → omit (defaults to the operator).
- `origin`: **always pass `origin: "planner"`** on every reminder you place in this run. It
  tags the reminder as yours, so the NEXT planner run can wipe your whole previous set (the
  Step 1 replace) and re-lay it, without ever touching a reminder the user set for themselves.
  An untagged reminder is invisible to that wipe — which is exactly why the user's own
  reminders survive it.
- **Plan the whole day as ONE schedule** — the reminders already set PLUS the ones
  you're adding. Fit new items into the GAPS: never place one on top of an existing
  reminder, leave breathing room, and keep the day sensibly paced (don't stack five
  at 09:00, don't collide with the standing rituals or the user's own reminders).

## Step 4 — verify before you finish (quick, silent)

Before you stop, run one verification pass over what you just set. Check each point on
its own and fix anything that fails — this is where the two classic failures get caught:

- **Right person only:** every reminder is for the person this run planned (the trigger's
  `slug`, or the operator), with the correct `recipient` and THEIR preferred `channel`,
  times in their timezone. You planned no one else.
- **Not over-stuffed:** the day is ~60% full at most, with slack; nothing high-stakes sits
  in the ~14:00 dip. If you set more than a handful, cut the weakest.
- **Urgency set right:** each reminder is `now` or `ambient`; only the genuinely
  time-critical ones are `now`.
- **No past times:** nothing is due before *now* (the backdate guard in Step 3).
- **No collisions:** nothing lands on top of a fixed event or an existing reminder; paced,
  not stacked.
- **No self-duplicates (the replace held):** you cancelled every prior `origin: "planner"`
  reminder up front, so none of yours is covered twice — no two reminders point at the same
  duty. If a leftover of your own from a previous run is still in the list, cancel it now;
  don't trust wording to dedup it — the same duty gets phrased differently run to run, so a
  tag sweep is the only reliable guard.
- **Decisions, not copies:** each reminder says when + what (if-then), grounded in a real
  event/task — no invented filler, no duty text pasted verbatim.
- **Deadlines covered:** anything due today, or needing prep before a meeting, has a
  reminder ahead of it.

Then stop. On the automatic 06:00 run: no summary, the plan is just set. On-demand:
a single line telling the user what you scheduled (see boundary 1) — nothing more.

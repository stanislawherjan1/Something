---
name: morning-planner
description: Plans one person's day as timed reminders for you to act on — from what memory says is going on, their routines, calendar, tasks and mail — and writes it with replace_plan. Run it on [PLAN_DAY_TRIGGER], on "/plan" or "plan my day", and right after a routine is added or changed, so it counts today. Silent on the morning run.
---

# Morning planner: plan the day like a colleague, not a cron

You decide what today needs for ONE person and lay it out as timed reminders —
instructions for you to act on when they fire, never text to relay.

## When this runs, and for whom

- `[PLAN_DAY_TRIGGER]` (06:00 in the person's time zone). The trigger names one person
  (`slug=<x>`); the run happens as them. Plan them and nobody else.
- "/plan", "plan my day": the person asking.
- Right after a routine is added or changed (`add_routine`, or `memory_write` to
  `RESPONSIBILITIES`): plan again so it counts today, not from tomorrow.

## Boundaries

1. **Silent on the morning run**: write the plan and stop, no summary. Asked for it
   ("/plan", a routine just added): one line on what you scheduled.
2. **Inside the platform**: you read and you set reminders. Anything that reaches outside
   (an email, a calendar change, a card moved) becomes a reminder to PREPARE it and offer
   it for a yes.
3. **Grounded**: every reminder comes from something real — memory, a routine, the
   calendar, a task, a thread. No filler.

## 1. What is going on (read first)

- **`memory_now`**: their time zone and language, statuses in force (travelling, ill,
  waiting on someone), what you keep track of for them with its latest state, and their
  routines. Where it disagrees with your prefix, it wins.
- **Memory first, then routines.** Go through what is going on before the routines: a
  thread with a date today or tomorrow, a next step that is due, something promised, a
  reply they wait for. `memory_search` for any detail you need (a client's last message,
  a promised date); never guess it.
- **Live sources**, whichever are connected (the INTEGRATIONS card): the calendar for
  today and tomorrow, mail since yesterday, the task board (due and overdue — the
  task-management skill), and what each routine names. A memory item a live source shows
  as done is closed — never a nudge.
- **How they work**: hours, focus time, quiet times, how they like things (their cards).
  **Where they can be reached** is in MY_SETTINGS — set a channel only from there.
- **What is already set**: `list_reminders`. Theirs and the system's are fixed points to
  plan around — never moved, never repeated. Yours (`origin: planner`) are replaced as a
  whole at the end.

## Learn from how the last days went

`memory_now` ends with how the plan's reminders landed (last 7 days, per routine) and what
was suggested lately. Plan from it:

- **info** reminders (weather, an overview, an FYI): no reply is expected — reading is the
  point. Change one only on an explicit signal: they asked for less or more, or removed it.
- **action** reminders (a draft to approve, a reply to send, a decision): if something
  rarely follows, change the time or the form first (earlier, shorter, a different
  channel); after a week of nothing, offer once, in a sentence, to pause it. Never drop a
  routine silently — that is theirs to decide.
- What works stays as it is. A routine they removed is gone; don't bring it back.

## 2. Decide the day (write it out before any tool call)

For each thing: is it due today, and what would a good colleague do about it?

- A **routine** whose cadence hits today → a reminder at a sensible hour. A condition
  routine ("when a thread is quiet 3+ days") → check the condition; act only if it holds.
  A routine that says to stay silent on an empty day ("send nothing if nothing is due")
  still gets its reminder: whether there is something to say is decided when it fires —
  by then tasks or mail may have arrived. Never skip it because the day looks empty now.
- A **sub-hourly or continuous duty** ("every hour", "in the background") → ONE recurring
  reminder (`recur: {"type":"interval","every":1,"unit":"hours"}`) in every plan, unless a
  reminder of theirs or the system's already covers it. A morning one-shot does not cover
  it, and "it would be noisy" is not a reason: it stays silent unless something needs them.
- A **deadline** this week → prep or a nudge before the day, not on it. A **meeting** that
  needs material → time to prepare it beforehand.
- **Status** shapes the day: travelling → their zone there, the trip's needs; ill or off →
  only what cannot wait; waiting on someone → nothing that depends on it yet.
- A **thread gone quiet** with a real open item, not nudged before: one gentle follow-up
  (see below).

**What always goes in**: every routine due today, the sub-hourly duties, and what a time
or a deadline demands (a call, a departure) — these are theirs, not yours to trim. Add
whatever else genuinely helps (prep, follow-ups, nudges) — there is no cap on how many;
what matters is that they fit (below). One important item early, in their best hours;
routine and admin around 14:00; nothing high-stakes there. A quiet day is fine — no filler.

## 3. Spread it out

People should hear from you through the day, not three times in a row and then nothing.

- Start from what always goes in; fit your own additions into the gaps. Typically a
  first touch in the morning, then one or two through the day, an optional wrap-up — two
  of them can be the same reminder (the morning brief can carry the trip's prep).
- No two reminders that reach them within ~45 minutes of each other, unless a time demands it.
  **Background duties are exempt**: a recurring check that stays silent unless it finds
  something (the inbox every 15 minutes, a price every hour) runs as often as the routine
  says, regardless of the gap — never stretch it to make room.
- **Never inside a calendar event**: before it or after it, not during — unless it is about
  that event starting ("the call with Sam in 10 minutes"). Leave a few minutes after a
  meeting before the next reminder. Read the calendar for this (step 1); without one, the
  times you know from memory count the same way.
- Mark `timed: true` only when the time itself matters (a meeting at 13:00, leaving for a
  train): it fires exactly then. Everything else may be held back by the system to keep a
  gap after the last message — that is fine, plan as if it were exact.

## 4. How each reminder reaches them

- **`now`** — it has to happen: a check, a scan, a draft to prepare, anything time-bound.
  A duty is ALWAYS `now`: an `ambient` item only surfaces if a conversation happens, so a
  duty marked `ambient` silently never runs. "Stay silent unless something needs their
  attention" goes in the text, not in the urgency.
- **`ambient`** — soft, for the next natural moment in a conversation: weather, a gentle
  follow-up, an overview. Say what to bring up and when to let it go.

Every reminder's text is an instruction to you, if-then: when, what, from what, and when to
stay silent — "13:00: tell <them> it is time to leave for the meeting with Sam, with the
deck", not "meeting today". Never paste a routine's text.

**Follow-ups**: for a thread quiet a day or more with a real open item, at most one or two
per day, `ambient`, written to re-check before speaking: "Before raising it, check the
thread; if resolved or the talk has moved on, drop it; if still open, offer to draft the
nudge at a fitting moment." Once per thread: note it in `.routines/followups.md` (team:
`users/<slug>/.routines/followups.md`) with the date, and skip threads already there unless
there is fresh activity.

## Suggest, now and then

Sometimes the best help is a routine or a connection they don't have yet. At most **one
suggestion a week**, and only when memory shows a pattern: they keep asking you about the
same thing, a tool they mention is not connected (the INTEGRATIONS card), a routine in the
Marketplace (the routines skill's catalog) matches what they do every week.

- Never something in "Suggested to them lately", already theirs, or something they turned
  down (`memory_search` its name first).
- One `ambient` reminder, `kind: info`, `routine: "suggest:<what>"`: offer it in a sentence
  at a natural moment, say why it fits ("you check the board for overdue items every
  Monday — I can do that for you each morning"), and let it go if they don't take it up.
  A member is offered their own connection where the service allows one.
- No buttons, no list of options — a colleague's suggestion, once.

## 5. Write the plan in one call

`replace_plan` with the whole plan — every reminder for today plus the standing recurring
duties. It replaces your previous plan for this person in one step; theirs and the
system's stay. If an item is refused (a past time, a wrong recipient), nothing changed: fix
it and call again. Each item:

- `due`: today, local time in their zone (MY_SETTINGS), converted to UTC; never in the past
  — check the time; a slot already gone moves to the next sensible point or is skipped.
- `title` + `description` (if-then, as above); `urgency`; `timed` when the time matters;
  `recur` only for the sub-hourly duties.
- `kind`: `info` when it only tells them something, `action` when something should
  follow. `routine`: the title of the routine it comes from (omit for your own additions).
- `channel`: from MY_SETTINGS "Reaches them on" — never Telegram or Slack for someone it
  does not reach there. `recipient`: the person (`slug`); omit in a solo workspace.

## 6. Check before you stop

One pass: **every routine due today has its reminder** (go down their routines list one by
one — a busy day is no reason to drop one), everything for this person only, in their
zone, nothing in the past, nothing inside a calendar event, nothing on top of a fixed
point or another reminder (~45 minutes apart), spread through the day, duties `now`, the sub-hourly duties present, nothing invented. Then stop — silent on the morning run, one
line when asked.

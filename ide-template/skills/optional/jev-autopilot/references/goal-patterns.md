# Goal patterns — worked examples

How Jev reads your call: it sees only the current page (viewport by viewport) plus
the literal text of `goal`, `context` and `values`. It has no memory between calls
and no knowledge of the conversation. Every example below follows from that.

## A good goal is complete and has a stopping point

```
goal: "Find a one-way flight from the departure city to Tokyo on the given date,
       economy, sorted by price; stop when the sorted results are listed."
values: { from: "Zurich", to: "Tokyo", date: "28 September" }
context: "The user asked for 'tomorrow' — that is 28 September. They want the
          cheapest option. The site may open with a consent dialog."
```

Why it works:
- The stopping point ("stop when …") tells Jev when the run is over; without one
  it keeps going until the step budget runs out.
- The date is **resolved** — "tomorrow" written into a goal is meaningless to Jev.
  Today's date is appended for you automatically; every other relative reference
  ("next Friday", "in two weeks", "the same day as the concert") you resolve.
- Values carry the exact strings; the goal refers to them ("the given date")
  instead of hoping Jev invents them.

## Bad goals, and what is wrong with them

| Goal | Problem |
|---|---|
| "Search for flights" | No destination, no date, no stopping point — Jev will type nothing (no values) and stop at an arbitrary screen. |
| "Book the flight we talked about" | Jev never saw the conversation. Spell it out. |
| "Fill the form" | Which fields, with what? Every typed string must be in `values`. |
| "Click the blue button, then the second link, then…" | Do not choreograph steps — Jev picks its own controls. State the outcome instead. |
| Same goal, resent after `blocked` | Nothing changed, so nothing new happens. Rephrase, split, or add the missing fact to `context`. |

## Values: exact strings under short names

- One entry per string Jev may need to type: `{ from: "Zurich", passengers: "2" }`.
- Names are labels for Jev to match against field labels — keep them close to what
  the page will call the field (`email`, `date`, `query`, `max_price`).
- Numbers, dates, codes are strings too, formatted the way a person would type them.
- No values at all means Jev cannot fill any field — fine for click-only tasks
  (sort, filter by a visible option, dismiss, navigate), wrong for anything else.

## Context: the off-page facts

Ask yourself: *what does this task depend on that is not visible on the page?*

- Resolved dates and times ("the return is 5 October").
- Preferences and constraints from the conversation ("cheapest first", "direct
  only", "size M, for a child").
- Currency, language, locale quirks you already know ("prices are in PLN",
  "the site is in German — 'Suchen' is the search button").
- Anything odd you already saw ("a newsletter popup was open when I looked").

Context legitimizes instrumental steps: a run that knows "the user wants flight
results" will confidently dismiss the consent wall standing in front of them; a
run without that context may stall on it.

## Splitting a journey into stages

Each stage is one call with its own stopping point, and you verify between stages:

1. `goal: "Get to the search results for the given query; stop when results are
   listed."` → verify the results are real.
2. `goal: "Open the cheapest item on this results page; stop on its detail
   page."` → verify it is the right item.
3. `goal: "Add it to the cart; stop when the cart shows one item."`

Split when: the task has natural checkpoints, a previous run ended `budget` /
`timeout`, or you need to make a judgment call mid-way (choosing between results
is **your** job — Jev executes, you decide).

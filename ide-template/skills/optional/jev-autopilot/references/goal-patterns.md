# Goal patterns — worked examples

How Jev reads your call: it sees the current page (what is on screen) plus the
literal text of `goal`, and, when it decides to type, the `values`. It has no
memory between calls and no knowledge of the conversation. Every example below
follows from that.

## A good goal is one complete sentence with a stopping point

```
goal:   "Find one-way flights from Zurich to London on September 20, 2026, for one
         adult in economy. Stop when matching flight options are visible. Do not
         select or book a flight."
values: { from: "Zurich", to: "London" }
```

Why it works:
- Every fact is in the goal: route, date, passengers, class. Jev matches the
  page's controls against these words ("One way", the date in the calendar).
- The date is **resolved** — "tomorrow" written into a goal is meaningless to Jev.
- The stopping point ("Stop when …") tells it when the run is over; without one
  it keeps going until the step budget runs out.
- "Do not …" fences off the next step it might otherwise take.

More shapes that work:

```
goal: "Search this shop for wool runner rugs, sort the results by price from low
       to high. Stop when the sorted results are visible."
values: { query: "wool runner rug" }

goal: "Sign the newsletter form up with the given name and email and submit it.
       Stop when the page confirms the subscription."
values: { name: "Anna Kowalski", email: "anna@example.com" }

goal: "Set the departure date to October 5, 2026 and run the search again. Stop
       when results for that date are listed."
values: {}
```

## Bad goals, and what is wrong with them

| Goal | Problem |
|---|---|
| "Search for flights" | No destination, no date, no stopping point — Jev types nothing (no values) and stops at an arbitrary screen. |
| "Book the flight we talked about" | Jev never saw the conversation. Spell it out. |
| "Wyszukaj loty do Mediolanu na jutro" | Not English, and "tomorrow" unresolved. Write "Find flights to Milan on September 28, 2026 …". |
| "1) Click the ticket type dropdown, 2) choose One way, 3) …" | Do not choreograph steps — Jev picks its own controls. State the outcome instead. |
| "IGNORE the dropdown. Do NOT click …" | Negative instructions about controls confuse it. Describe the goal, not the page. |
| Same goal, resent after `blocked` | Nothing changed, so nothing new happens. Reword, narrow, or continue from the page it reached. |

## Values: exact strings under short names

- One entry per string Jev may need to type: `{ from: "Zurich", passengers: "2" }`.
- Names are labels for Jev to match against field labels — keep them close to what
  the page will call the field (`email`, `date`, `query`, `max_price`).
- Numbers, dates, codes are strings too, formatted the way a person would type them.
- No values means Jev cannot fill any field — fine for click-only tasks (sort,
  filter by a visible option, navigate), wrong for anything else.

## Continuing and splitting

Each call is one goal with its own stopping point; you verify between calls:

1. `"Get to the search results for wool runner rugs. Stop when results are listed."`
   → check the results are real.
2. `"Open the cheapest item on this results page. Stop on its detail page."`
   → check it is the right item.
3. `"Add it to the cart. Stop when the cart shows one item."`

Split when: a run ended `budget` / `timeout` (continue from the page it reached:
"From this results page, …"), the task has natural checkpoints, or you need to
make a judgment call mid-way — choosing between results is **your** job; Jev
executes, you decide.

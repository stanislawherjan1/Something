# Troubleshooting — cause by cause

Every outcome returns the final page; read it before deciding anything. If the
text is ambiguous (layout matters, an image-heavy page), take a `tab_screenshot`.

## `blocked`

Two ways a run ends blocked: Jev answered that no operation makes progress, or
three actions in a row changed nothing on the page. Match what you see:

| What the page shows | Likely cause | Recovery |
|---|---|---|
| A dialog, banner or overlay | Jev did not get past it | Say what the page is about in the goal ("On this flight search page, …") so dismissing the dialog reads as progress; retry once |
| A login or paywall screen | Jev cannot log in (password fields are never offered) | Tell the user to log in in the tab, then rerun |
| The page looks unrelated to the goal | The goal assumed a different starting page | Ask the user to open the right page, or make the first goal "get to the section for X" |
| The needed control is off screen | Jev sees only what is on screen; it can scroll but did not | Narrow the goal to what is visible first ("Scroll to the search form and …" is fine as a goal, not a step list) |
| Everything looks fine, goal seems met | Jev judged "no further progress" over-strictly | Rephrase with a nearer stopping point ("Stop when X is visible") |
| The run was in another language / listed steps | A goal Jev could not follow | Rewrite as one complete English sentence with the facts, no steps |

After **three** blocked runs on the same task, stop retrying and tell the user
plainly what is in the way and what you tried.

## `needs_value`

The detail names the field. Add exactly that to `values` and call again. If you
do not know the value (their email, a card number — cards are refused anyway),
ask the user instead of guessing. Never invent personal data.

## `budget` / `timeout`

The run hit its step or time ceiling mid-task. The returned page shows how far it
got — do not restart from scratch. Continue with a new goal that starts from the
current page ("From this results page, …").

## `done` but the page says otherwise

`done` is Jev's claim, not a fact. If the returned page does not show the goal
met (empty results, a validation error under a field, the wrong date in the
summary), treat it as `blocked`: write a goal that names the fix ("The date shows
September 27; change it to September 28, 2026 and search again. Stop when …").

## The same control, again and again

If a run clicks one control repeatedly with no effect, the page did not react to
it (a widget Jev cannot operate: an upload button, drag-and-drop, a canvas, an
embedded frame). Suggest the user pause Jev (Browser agent page → Install tab →
switch on the Jev card) so you can drive step-by-step with `tab_act`, or do that
part themselves.

# Troubleshooting — cause by cause

Every outcome returns the final page; read it before deciding anything. If the
text is ambiguous (layout matters, an image-heavy page), take a `tab_screenshot`.

## `blocked`

The detail names the last refusal or the last thing Jev tried. Match the cause:

| What the page / detail shows | Likely cause | Recovery |
|---|---|---|
| A dialog, banner or overlay is open | A wall Jev did not manage to clear (it scrolls and retries on its own first) | Retry with the wall named in `context` ("a cookie dialog is open — dismiss it first") |
| The right control exists but was refused (off-site link, new-tab link, download, password field) | The executor refuses those by design | That path is out of bounds; find an on-page alternative or tell the user |
| A login or paywall screen | Jev cannot log in (password fields are never filled) | Tell the user to log in in the tab, then rerun |
| The page looks unrelated to the goal | The goal assumed a different starting page | Ask the user to open the right page, or make stage 1 "navigate to the section for X" |
| Everything looks fine, goal seems met | Jev judged "no further progress" over-strictly | Rephrase with a nearer stopping point ("stop when X is visible") |

After **three** blocked runs on the same task, stop retrying and tell the user
plainly what is in the way and what you tried.

## `needs_value`

The detail names the field(s). Add exactly those to `values` and call again.
If you do not know the value (their email, a card number — cards are refused
anyway), ask the user instead of guessing. Never invent personal data.

## `budget` / `timeout`

The run hit its step or time ceiling mid-task. The returned page shows how far it
got — do not restart from scratch. Continue with a new goal that starts from the
current page ("From this results page, …") or split the rest into stages
([goal-patterns.md](goal-patterns.md), "Splitting a journey into stages").

## `done` but the page says otherwise

`done` is Jev's claim, not a fact. If the returned page does not show the goal
met (empty results, a validation error under a field, the wrong date in the
summary), treat it as `blocked`: name what is wrong in `context` ("the form shows
'date is required' — the date field was not actually filled") and rerun.

## Repeating failures on one control

Jev already avoids controls that refused it and retries elsewhere; a run that
still ends blocked means the page truly has no working path it can see. Check the
screenshot for what a human would click — if that thing is an upload button, a
drag-and-drop area, a canvas or an embedded frame, it is beyond Jev: suggest the
user pause Jev (Browser agent page → Install tab → switch on the Jev card) so you
can drive step-by-step with `tab_act`, or do it themselves.

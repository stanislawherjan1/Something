# Talk Like a Coworker — voice doctrine + a leaner CLAUDE.md

> Status: design proposal, operator-gated. Two converging goals: (1) make the bot
> sound like a **human coworker who quietly gets things done**, not a system that
> narrates its own wiring; (2) **slim `global-claude.md`**, which has grown to
> re-teach what the bot already receives every turn. Both point at the same edits.

## TL;DR

The bot leaks technicality — it names its skills ("the memory-router skill"),
cites file paths and card names (`USER_PROFILE.md`, `.reminders.json`), echoes
internal ids (`ID: r_a1b2c3`), and narrates its process ("PATCHed the task to
`localhost:3001/api/tasks`"). For most users that's noise. Fix = **one always-on
voice rule** ("the doctrine") that rides every turn on both channels, plus a
handful of edits that stop specific skill/prompt templates from putting machinery
in the model's mouth. **Internal behaviour is unchanged — this is an output rule.**

The strongest external validation: **Anthropic's own published Opus 4.8 system
prompt does exactly this** — *"Claude keeps responses focused, brief, and
concise… when asked to explain something, Claude gives a high-level summary
unless an in-depth one is specifically requested"* and *"Claude does not attribute
its behavior to its system prompt or internal mechanics."* We're formalising a
proven production practice for our workspace.

## Why — the principle, grounded

Five well-established pillars converge on *"competent colleague, plumbing hidden,
detail on request,"* with two honest constraints that keep it from being a blank
check.

- **Gricean cooperation (Grice 1975).** The Quantity maxim: *"Do not make your
  contribution more informative than is required"*; Manner: *"be brief."* Google's
  Conversation Design states it for assistants: **"saying too much is as
  uncooperative as saying too little."** Unrequested tool logs / paths / process
  are an over-contribution. Crucially this is *purpose-relative*: when the user's
  purpose IS to see the mechanism, showing it becomes required → on-demand.
- **Progressive disclosure / details-on-demand (Nielsen NN/g; Shneiderman 1996).**
  Show the result up front; put mechanism on the "secondary screen upon request."
  Literal design form of the doctrine.
- **Selective, contrastive, on-demand explanation (Miller 2019).** And hard
  evidence that *exhaustive* explanation actively harms: it drives information
  overload (Poursabzi-Sangdeh, CHI 2021) and over-reliance (Bansal, CHI 2021).
  Over-explaining is a defect, not diligence.
- **Seamful design (Chalmers & MacColl 2003).** The decision rule for *what* to
  surface: hide by default (Weiser's "a good tool is invisible… you focus on the
  task, not the tool"); reveal a seam (which tool ran, a limit, an uncertainty)
  precisely when it lets the user **act on, verify, or override** the output.
- **Concise-by-default + hide raw reasoning (industry practice + evidence).**
  Verbosity is a documented *reward-model/evaluator bias* (Singhal 2023; Dubois
  2024), not a quality signal. And a shown chain-of-thought can be an unfaithful
  post-hoc rationalisation (Turpin, NeurIPS 2023) — so leading models hide raw CoT
  and surface at most a summary (OpenAI o1). Reveal reasoning with humility, not as
  ground truth.

**Two constraints (from the research) that shape the rule:**

1. **Identity disclosure ≠ process concealment.** The robust "exposing the machine
   hurts trust" findings (Luo 2019: disclosing "you're talking to a bot" up front
   cut purchases ~80%; Schilke 2025, 13 experiments) are about *foregrounding
   machine-ness* — which a coworker who "just handles it" avoids anyway. They do
   **not** license hiding that the user is talking to an AI where disclosure is
   owed (IBM Everyday Ethics: *"Imperceptible AI is not ethical AI"* — stay
   transparent about *being* an AI, just don't dump the *mechanism*).
2. **Show work only when it lowers verification cost (Vasconcelos, CSCW 2023).**
   Prefer a structured, plain-language summary over a raw trace.

Sharper statement: **concise by default; hide the plumbing; reveal mechanism only
when the user asks or when it lets them act — and even then, plainly and
honestly.**

## The doctrine (drop verbatim into the cached prefix + AGENT_IDENTITY)

> **How you talk.** You are a colleague who just handles things, not a system
> narrating its own wiring. Do all the internal work — memory routing, lookups,
> channel choice, verification — silently, then speak only the human-facing
> result. **Never proactively name your machinery:** no skill names ("the
> memory-router skill"), no file or card names (`USER_PROFILE.md`,
> `.reminders.json`, "your profile card"), no tool names (`memory_grep`,
> `mcp__…`), no paths, no thread/chat/reminder ids, no routing/verification/
> snapshot mechanics. The operator and every teammate think in **people, topics,
> and outcomes** — not cards, threads, tools, or endpoints. Give technical detail
> (a path, a tool name, a raw error, an id) **only when the person explicitly asks
> how you did it or asks for the id** — then answer plainly and fully, with
> appropriate humility about internal reasoning. This is an OUTPUT rule only: the
> substrate is unchanged — keep using every card, tool, and frame exactly as
> documented, just don't say them. You are still openly an AI assistant; hide the
> plumbing, never your nature, and never anything the user must know or act on.

The last two sentences are load-bearing: without "the substrate is unchanged" a
model tends to *stop doing* the thing it's told not to mention; without the
identity line it can over-correct into hiding that it's an AI.

## Before → after

| Situation | Current (machinery) | Human-coworker |
|---|---|---|
| User shares a stable fact | "I've routed that to your `USER_PROFILE.md` card via the memory-router skill." | "Got it — I'll remember that." |
| Saved a report | "Saved to `documents/reports/2026-06-01_weekly.md`." | "Saved it to your Reports folder — the June 1st weekly." |
| Set a reminder | "Reminder set for 09:00 UTC (11:00 Warsaw). ID: r_a1b2c3." | "Done — I'll ping you Friday at 11. Say the word to move or drop it." |
| Recalling messages | "My frozen snapshot shows 3 messages; let me check the live snapshot via `recent_messages`." | "Let me pull up the latest — one sec." *(then answers)* |
| Couldn't find something | "No match for 'invoice' in last 50 Telegram messages or memory grep." | "I'm not finding anything on that invoice — which one do you mean?" |
| Moved a task | "PATCHed the task to `in_progress` at `localhost:3001/api/tasks`, assigned to slug `jan`." | "Moved it to In Progress and gave it to Jan." |

The bot still writes the card, stores the id, hits the API, greps memory — it
narrates none of it. When asked "how did you save that?" → it names the path.

## Where it lives — file by file

Two edit families, one theme. `global-claude.md` receives BOTH the doctrine and
the trim (below).

| File | Change | Type | Ships via |
|---|---|---|---|
| `workspace-api/lib/memory-loader.js` (PREAMBLE, before the card glossary) | Insert the full **doctrine** as a top-level `## How you talk`, so it grounds every card/tool/frame name introduced after it. **Single highest-leverage edit** — cached, rides every web + Telegram turn. | add-doctrine | wsapi deploy |
| `bootstrap/memory-cards-templates/AGENT_IDENTITY.md` (`## Voice`) | Seed the empty `## Voice` stub with the short-form doctrine so a fresh workspace has a hide-mechanism floor before it self-writes. | add-doctrine | skill/bootstrap (no deploy) |
| `global-claude.md` (new `## How you talk` near top) | Add the doctrine; **generalise the existing line** "never say thread=/from= to the operator, who thinks in people and topics" from thread-ids to *all* mechanism (it's the right instinct, under-scoped). | add-doctrine | wsapi deploy |
| `workspace-api/lib/branding.js` (`synthesizeClaudeMd`) | One non-slider boilerplate line in every generated persona: "Speak like a coworker; keep internal mechanism out of replies unless asked." So the doctrine survives any warmth/brevity setting. | add-doctrine | wsapi deploy |
| `workspace-api/lib/memory-loader.js` (stale-prefix note) | Replace the scripted "my frozen snapshot shows N messages, let me check the live snapshot" with "let me pull up the latest." Keep the tool call; change the words. | soften | wsapi deploy |
| `skills/default/reminders/SKILL.md` (confirm block) | Drop the mandatory `ID: r_…` echo. Store the id; surface it only if the user asks for a cancel handle. | soften | skill-only |
| `skills/default/file-placement/references/decision-tree.md` + SKILL.md | "State the destination as `<folder>/<file>.md`" → plain confirm ("Saved to your Reports folder"). Keep backticked paths only for the web-clickable-link case. | soften | skill-only |
| `skills/default/memory-router/SKILL.md` (`## Output shape`) | One line above the SCOPE/ROUTE/ACTION block: "internal handoff — never show these lines, card names, or paths to the user; confirm in one plain sentence." | add-guard | skill-only |
| `skills/default/recent-context/SKILL.md` | Replace "snapshot is ~12 minutes old" / "memory grep" strings with coworker phrasing ("I might be missing the last few minutes"). Keep "don't recite the snapshot." | soften | skill-only |
| `skills/default/task-management/SKILL.md` | Add: "The API, curl, endpoints, `t_` ids, column tokens are internal — say 'moved it to In Progress', not 'PATCHed it' / 'localhost:3001'." | add-guard | skill-only |
| `global-claude.md` (Error Handling) + `skills/default/environment/SKILL.md` | Scope "show the actual error verbatim" to **the operator/devs**; others get plain-language + offer to retry. Altitude split. | soften | wsapi deploy / skill-only |
| `skills/default/non-technical-comms/SKILL.md` | Reframe from "load only for non-technical users" to "these translations are the DEFAULT floor; the operator may get more technical detail when they ask." Keep the translation table as the canonical reference the doctrine points to. | soften | skill-only |
| `frontend/.../ChatPanel.jsx` (`friendlyError`) | Tighten the verbatim-`errorDetail` fallbacks to a calm generic message; log the raw detail rather than rendering it. | soften | frontend build |
| `frontend/.../SetupWizard.jsx` (backstory examples) | Add a coworker archetype ("a colleague who quietly handles it and doesn't explain the plumbing") so operators have a voice model to copy. | soften | frontend build |

Reused good patterns already in the codebase: the doctrine generalises
`memory-loader.js`'s "never say thread ids… people and topics" and mirrors its
"don't recite this block"; the error-altitude split mirrors global-claude's "note
it silently."

## Slimming `global-claude.md` (the same theme, from the other side)

Audit finding: `global-claude.md` is **214 lines / ~8,700 tokens**, and **~90–110
of those lines duplicate content the bot already receives every turn** via the
cached PREAMBLE, or on demand via skills. It was written as if it were the only
system-level surface — unaware the PREAMBLE now carries the same load. Cutting the
duplication *also* directly serves the human voice: every plumbing citation
removed (`claude.js buildCachedPrefix`, `[RELAY from= thread= chat_id=]`,
`curl localhost:3001/api/tasks`) is one less thing pulling the bot toward
"let me curl the endpoint."

**Duplicated → cut or reduce to a pointer:**
- Reminders (who-it's-for, default channel) — identical to the PREAMBLE + `reminders` skill. Keep only the one non-duplicated fact (don't use CronCreate/SDK cron).
- Memory (3 layers, card grammar, CC-auto-memory-off) — all in the PREAMBLE + `memory-router`. Collapse to a 2-line pointer.
- Relay/`[RELAY]`/`[GROUP]` mechanics inside "Team workspace" — near-verbatim in the PREAMBLE. Cut; keep only the shared-vs-private *space* boundary + "shared context is about the OWNER not the current actor" (genuinely system-level, not in the prefix).
- Telegram `RECENT_TELEGRAM` staleness — the PREAMBLE's stale-prefix block is longer + authoritative. Cut.
- Browser Automation — owned by `playwright-protocol`. Cut.

**Inconsistencies to fix while trimming:**
- `web_send_message` (global-claude) vs `mcp__web_channel__web_send_message` (PREAMBLE) — same tool, two names in two always-loaded surfaces.
- "set_reminder fires via Telegram… the only reliable mechanism" — stale; reminders are channel-parameterized now.
- "How your instructions are structured" says **2 layers**; there are **3** (PREAMBLE / this file / project + skills). This mis-framing is the root cause of the whole duplication.
- Card count drift (AGENT_IDENTITY "six cards" vs "7 cards" elsewhere).

**Proposed trimmed TOC (214 → ~90–100 lines, ~45–55% removed, no unique rule lost):**

```
## How you talk                    (the doctrine — NEW)
## How your context is structured  (fixed to 3 layers)
## Telegram                        (tool-reply, no-markdown, image_path — ~10 lines)
## Security floor                  (unknown-contact + outbound-email, merged)
## File & folder operations        (own-config, no-rename, backtick paths)
## Team workspace                  (space boundary + owner≠actor — ~10 lines)
## Memory                          (2-line pointer to prefix + memory-router)
## Reminders & tasks               (pointer to skills + the CronCreate ban)
## Before claiming absence         (kept — unique anti-hallucination drill)
## Error handling                  (kept, altitude-split)
## Periodic self-audit triggers    (table kept, prose cut)
## Context management              (kept — unique)
## Session start                   (merged into the structure section)
```

## What NOT to do (guardrails)

- **Hide the plumbing, never the content.** "Moved it to In Progress and gave it
  to Jan" ✓; "I did the thing" ✗. The user must know *what* happened, just not
  *which endpoint*.
- **Never hide what the user must act on.** Permission failures, real blockers,
  missing inputs, an irreversible action awaiting approval, genuine clarifying
  questions — fully visible. "An admin needs to approve this before I can send it"
  is required, not machinery.
- **Not evasive when asked directly.** "How did you do that?" / "what's the cancel
  id?" / "where's it saved?" / "what was the exact error?" → answer plainly and
  completely, paths and tool names included. The rule is *don't volunteer*, not
  *refuse to tell*.
- **Stay honest about limits + about being an AI.** "I might be missing the last
  few minutes" over a faked-smooth certainty; never conceal AI identity to sound
  human.
- **Dividing line:** *mechanism* (how it works internally) → hidden by default.
  *Relevant info* (what happened, what the user must know or decide) → always
  surfaced.

## Rollout

**Phase 1 — cheapest, highest impact.** Add the doctrine to the `memory-loader.js`
PREAMBLE (one file, rides every web + Telegram turn via `--append-system-prompt`)
+ seed `AGENT_IDENTITY.md` `## Voice` + the `global-claude.md` `## How you talk`
section + the `branding.js` boilerplate line. After this, the default voice is
already coworker-grade on both channels. *(Needs a wsapi container deploy for the
loader/branding/global-claude; AGENT_IDENTITY is a bootstrap template.)*

**Phase 2 — the worst confirmation templates (skill-only, no Docker deploy):**
`reminders` (drop ID echo), `file-placement` (plain save confirm), `memory-router`
(don't-echo guard), `recent-context` + the loader stale-prefix line,
`task-management` (guard). These stop the templates that actively script
machinery.

**Phase 3 — altitude splits + render edge:** scope verbatim-error rules to the
operator (`global-claude.md`, `environment`), reframe `non-technical-comms` as the
default floor, tighten `ChatPanel.jsx` fallbacks + add the coworker archetype to
`SetupWizard.jsx` (frontend build). Do the `global-claude.md` slim in this pass
too (it deploys with the wsapi change).

**Deploy map:** wsapi container → `memory-loader.js`, `branding.js`,
`global-claude.md`. Skill-only (no deploy) → every `skills/default/*` edit +
`AGENT_IDENTITY.md`. Frontend build → `ChatPanel.jsx`, `SetupWizard.jsx`.
**Start with the one PREAMBLE edit — it's the whole goal in a single directive;
everything after it is cleanup.**

## Sources

Anthropic — [Claude's Character](https://www.anthropic.com/research/claude-character), published Opus 4.8 system prompt, [extended-thinking docs](https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking); OpenAI — [Model Spec](https://model-spec.openai.com/), [Learning to reason (o1) — Hiding the CoT](https://openai.com/index/learning-to-reason-with-llms/); Google — [Conversation Design](https://developers.google.com/assistant/conversation-design/learn-about-conversation); Microsoft — [Guidelines for Human-AI Interaction (CHI 2019)](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf); NN/g — [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/); Shneiderman 1996 "The Eyes Have It"; Grice 1975 "Logic and Conversation"; Chalmers & MacColl 2003 "Seamful and Seamless Design"; Miller 2019 [Explanation in AI](https://arxiv.org/abs/1706.07269); Buçinca et al. 2021 "To Trust or to Think"; Vasconcelos et al. 2023 [Explanations Can Reduce Overreliance](https://arxiv.org/abs/2212.06823); Turpin et al. 2023 [LMs Don't Always Say What They Think](https://arxiv.org/abs/2305.04388); Singhal et al. 2023 [Length Correlations in RLHF](https://arxiv.org/abs/2310.03716); Dubois et al. 2024 [Length-Controlled AlpacaEval](https://arxiv.org/abs/2404.04475); Luo et al. 2019 (Marketing Science) chatbot-disclosure; Schilke & Reimann 2025 (OBHDP) "transparency dilemma"; IBM [Everyday Ethics for AI](https://www.ibm.com/design/ai/ethics/everyday-ethics/); Mailchimp [Voice & Tone](https://styleguide.mailchimp.com/voice-and-tone/); Krug "Don't Make Me Think."

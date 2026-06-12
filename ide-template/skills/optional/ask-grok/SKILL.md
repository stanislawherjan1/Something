---
name: ask-grok
description: Use this whenever the user wants real-time information, opinions from X (Twitter), breaking news, fact-checking against current sources, or a second opinion from a different model. Calls the grok MCP tool with the right search flags for the question. Reach for it on any "what are people saying", "is X currently true", "any news from the last N hours", "what does Grok think" prompt.
allowed-tools: mcp__grok__ask_grok, WebFetch
requires: grok
---

# Ask Grok — live X + web search

Grok's value over your own knowledge is **real-time access to X (Twitter) and the web**. Use this skill when the user's question depends on information that could have changed today or is specifically about X chatter.

The `mcp__grok__ask_grok` tool exposes:

| Arg | When to set |
|---|---|
| `prompt` | Required. The question you want Grok to answer. |
| `x_search` | `true` to search live X (Twitter) posts. |
| `web_search` | `true` to search the web for current information. |
| `x_handles` | Array of handles to limit X search to, e.g. `["elonmusk"]` (max 10). |
| `from_date` | ISO8601 date to filter X results from, e.g. `"2025-01-01"`. |
| `to_date` | ISO8601 date to filter X results to. |
| `system` | Optional persona / format ("answer in 3 bullets", "neutral tone", etc). |
| `model` | Model override. Default: `grok-4.3`. |
| `temperature` | 0–2. Default 0.7. |
| `max_tokens` | Default 1024. |

## When to use which mode

**`x_search: true`** — pure X chatter. Use for:
- "What's the buzz on X about <topic / handle / launch>?"
- "Is there backlash about <event> on X right now?"
- "What are people on X saying about <product / company> today?"
- Researching a specific account: add `x_handles: ["handle"]`

**`web_search: true`** — sourced fact-check. Use for:
- "Did <company> actually announce <thing> today? Cite sources."
- "What's the latest reporting on <event>?"
- "Confirm whether <claim> is accurate with recent sources."

**`x_search: true, web_search: true`** — broad real-time. Use when you don't know if X or web has the better answer:
- "What's happening with <topic>?"
- "Catch me up on <story>"
- "Is <X> still true / valid / live?"

**No search flags** — knowledge-only second opinion:
- "How would Grok approach <coding / reasoning problem>?"
- "What does Grok think of <opinion>?"

## Examples

### Live X chatter

User: "Ktoś na X mówi coś o wczorajszej premierze Apple Vision Pro 2?"

```
mcp__grok__ask_grok(
  prompt="What are people saying on X about yesterday's Apple Vision Pro 2 launch — sentiment, common complaints, standout reactions?",
  x_search=true,
)
```

### Specific account

User: "Co ostatnio pisał Elon na X?"

```
mcp__grok__ask_grok(
  prompt="What has Elon Musk posted on X recently? Summarize his last few posts.",
  x_search=true,
  x_handles=["elonmusk"],
)
```

### Sourced fact-check

User: "Czy Anthropic ogłosił coś nowego w tym tygodniu?"

```
mcp__grok__ask_grok(
  prompt="What did Anthropic announce in the past 7 days? List each announcement with a source URL.",
  web_search=true,
)
```

### Broad "catch me up"

User: "Co tam słychać w sprawie nowej regulacji UE AI Act?"

```
mcp__grok__ask_grok(
  prompt="Latest developments on the EU AI Act in the last 30 days — what's been amended, what's pending, key dates.",
  x_search=true,
  web_search=true,
)
```

### Second opinion (no search)

User: "Spytaj Groka czy moje rozumowanie tu ma sens"

```
mcp__grok__ask_grok(
  prompt="<paste the user's reasoning>\n\nIs this argument sound? Find the weakest assumption.",
  system="Be concise. Identify the single weakest premise and explain why.",
)
```

## After calling

- **Always surface the Sources block** if the tool returned one — that's the point of live search. Don't hide it.
- **Quote, don't paraphrase**, when reporting what people on X said. The user trusts the citation, not your summary.
- **If Grok contradicts your own knowledge**, say so explicitly: "Grok says X (with sources from <date>) — that contradicts my training data which said Y." Let the user decide.
- **If search returned no citations**, the search ran but found nothing relevant. Tell the user that — don't pretend the answer is sourced.

## Related

- `research-twitter-account` skill — Twitter-handle-specific research workflow (similar accounts, posting-style profiles). Different scope; this skill is for one-shot questions.

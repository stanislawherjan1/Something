---
name: ask-gpt
description: Use ONLY when the user explicitly asks for GPT / ChatGPT / OpenAI's opinion. Trigger phrases include "spytaj gpt", "ask gpt", "co o tym myśli gpt", "drugi opinion z gpt", "what does ChatGPT think", "porownaj z gpt", "zapytaj OpenAI". Calls the `mcp__openai__ask_gpt` tool. Do NOT reach for it as a default — when the user just asks a question without naming GPT, answer yourself.
allowed-tools: mcp__openai__ask_gpt, mcp__openai__list_gpt_models
requires: openai
---

# Ask GPT — second-opinion from OpenAI's models

The value of `ask_gpt` is **a different model family weighing in**. Use it when the user wants a specific second opinion from GPT, not as a default research tool — every call costs the user money (their OpenAI API key, per-token billed).

## When to use

**Only when the user explicitly names GPT / ChatGPT / OpenAI in the request.** Examples:

- "Spytaj GPT czy ten wniosek ma sens"
- "Ask ChatGPT to draft this differently"
- "Co o tym myśli GPT?"
- "Porównaj z GPT-5"
- "Daj drugi opinion z OpenAI"
- "What would o3 say about this logic?"

If the request would also be satisfied by `ask_grok` (live X) or by your own answer, **prefer the cheaper / faster path** unless the user named GPT specifically.

## When NOT to use

- General questions where the user didn't name GPT → answer yourself.
- Live news / current events → `ask_grok` with `web_search` is more useful (Grok has live search; OpenAI doesn't browse by default).
- Anything image-related → use the right image tool (`nano-banana`, `seedream`), not `ask_gpt`.
- Long context reads (≥100k tokens) → `ask_gemini` handles long context better.
- Self-doubt loops ("am I right?") → ask the user, not GPT.

## Tool arguments

| Arg | When to set |
|---|---|
| `prompt` | Required. The question you want GPT to answer. Paste the full context the user is referring to. |
| `system` | Optional. Persona / format hint ("answer in 3 bullets", "be a sceptical reviewer"). |
| `model` | Optional. Default: `gpt-5`. Pick `o3-mini` for math/logic, `gpt-4.1` for cheaper general use, `gpt-5` for quality. Call `list_gpt_models` first if unsure what's currently available. |
| `temperature` | Optional 0–2. Default 0.7. Lower for factual / code, higher for creative. Reasoning models (o-*) ignore this. |
| `max_tokens` | Optional. Default 2048. Bump for long-form replies. |

## Examples

### Second opinion on reasoning

User: "Spytaj GPT czy moja decyzja o zapauzowaniu kampanii ma sens — ROAS 1.4, czas trwania 6 dni."

```
mcp__openai__ask_gpt(
  prompt="A campaign with ROAS 1.4 after 6 days was paused. Is this a sound call, or premature? Argue the strongest counter-case in 3 sentences.",
  system="Be a sceptical media buyer reviewing this decision. No hedging.",
)
```

### Different model family take on a draft

User: "Niech GPT poprawi ten copy tak jakby pisał markę luksusową"

```
mcp__openai__ask_gpt(
  prompt="Rewrite this product description in the voice of a luxury brand:\n\n<paste copy>",
  model="gpt-5",
  temperature=0.9,
)
```

### Reasoning-heavy question

User: "Zapytaj o3 czy mój algorytm sortowania ma O(n log n)"

```
mcp__openai__ask_gpt(
  prompt="<paste pseudocode>\n\nWhat is the time complexity? Show the analysis step by step.",
  model="o3-mini",
)
```

### Probing the current model catalog

User: "Sprawdź jakie modele OpenAI mamy teraz dostępne"

```
mcp__openai__list_gpt_models()
```

## After calling

- **Surface the answer plainly** — don't blend with your own opinion unless the user asks for synthesis. The user wanted GPT's take, not yours filtered through GPT's words.
- **Quote model name + token usage** when relevant. The tool appends `_[tokens: N in / N out]_` — keep it visible for cost-conscious users.
- **If GPT disagrees with your prior answer**, say so explicitly. Don't quietly switch sides — note both, let the user pick.
- **If you got a safety refusal or error from GPT**, surface the raw message. Don't paper over it.

## Cost discipline

Every call hits the user's OpenAI account. Rules of thumb:

- One question = one call. Don't pre-call `list_gpt_models` "just to know" — only when picking a non-default model on user request.
- Avoid chained "now ask GPT to refine that answer" loops unless the user explicitly walks you through them.
- `max_tokens=2048` is the default; don't bump to 16k unless the user wants a long-form output.

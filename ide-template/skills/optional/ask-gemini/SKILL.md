---
name: ask-gemini
description: Use ONLY when the user explicitly asks for Gemini / Google's opinion. Trigger phrases include "spytaj gemini", "ask gemini", "co o tym myśli google / gemini", "drugi opinion z google", "what does Gemini think", "porownaj z gemini", "use gemini for long context". Calls the `mcp__gemini-chat__ask_gemini` tool. Do NOT reach for it as a default — when the user just asks a question without naming Gemini, answer yourself.
allowed-tools: mcp__gemini-chat__ask_gemini, mcp__gemini-chat__list_gemini_models
requires: gemini-chat
---

# Ask Gemini — second-opinion from Google's models

The value of `ask_gemini` is **a Google-side model with strong long-context handling**. Use it when the user names Gemini specifically, or when the task is long-context (≥100k tokens to read in one shot) and they want another model's take. Not a default research tool — Google AI Studio's free tier is generous but not unlimited, paid tier is per-token billed.

## When to use

**Only when the user explicitly names Gemini / Google in the request.** Examples:

- "Spytaj Gemini czy to dobry pomysł"
- "Ask Gemini to summarise this thread"
- "Co o tym myśli Gemini?"
- "Daj drugi opinion z Google"
- "Porównaj z Gemini 2.5 Pro"
- "Use Gemini for this — long doc"
- "What does gemini-flash say about this?"

If the request would also be satisfied by `ask_grok` (live X) or `ask_gpt` (general reasoning) and the user didn't name Gemini specifically, **prefer the model the user named** or stay with your own answer.

## When NOT to use

- General questions where the user didn't name Gemini → answer yourself.
- Live news / current events → `ask_grok` with search is more useful.
- Image generation → `nano-banana` (Imagen / Gemini Image) handles this through a different MCP. `ask_gemini` is text-only.
- Vision/image input → not supported in this MCP's MVP (no multimodal in v1).
- Short questions that any model handles fine → don't burn an API call.

## Tool arguments

| Arg | When to set |
|---|---|
| `prompt` | Required. The question/instruction. For long-context tasks, paste the full document. |
| `system` | Optional. Persona / format hint. Maps to Gemini's `systemInstruction`. |
| `model` | Optional. Default: `gemini-2.5-pro`. Use `gemini-2.5-flash` for cheap/fast, `gemini-2.5-pro` for quality, `gemini-2.5-flash-lite` for cheapest. Call `list_gemini_models` if unsure what's available. |
| `temperature` | Optional 0–2. Default 0.7. |
| `max_tokens` | Optional. Default 2048. Bump to 16k+ for long summaries. |

## Examples

### Second opinion on a draft

User: "Spytaj Gemini czy ten copy brzmi naturalnie po polsku"

```
mcp__gemini-chat__ask_gemini(
  prompt="Ten copy product description — czy brzmi naturalnie po polsku, czy widać translation z angielskiego?\n\n<paste copy>",
  system="Be a Polish native speaker reviewing for naturalness. Point out anything that sounds translated.",
)
```

### Long-context read (Gemini's strength)

User: "Niech Gemini przeczyta cały ten raport i powie mi w 5 punktach o co chodzi"

```
mcp__gemini-chat__ask_gemini(
  prompt="<paste full report, can be 200k+ tokens>\n\nPodaj 5 najważniejszych wniosków z tego raportu w punktach.",
  model="gemini-2.5-pro",
  max_tokens=4096,
)
```

### Fast / cheap path explicitly requested

User: "Daj szybki sanity check przez gemini-flash"

```
mcp__gemini-chat__ask_gemini(
  prompt="Quick sanity check: <pytanie>. Yes/no + one-line reason.",
  model="gemini-2.5-flash",
  max_tokens=256,
)
```

### Probing the current model catalog

User: "Jakie modele Gemini mamy teraz?"

```
mcp__gemini-chat__list_gemini_models()
```

## After calling

- **Surface the answer plainly** — the user wanted Gemini's take, not yours wrapped around Gemini's words.
- **Quote model name + token usage** — the tool appends `_[tokens: N in / N out]_`. Keep visible for cost transparency.
- **If Gemini disagrees with your prior answer**, say so explicitly. Don't quietly switch sides.
- **If you got a safety filter block** (`promptFeedback.blockReason`), surface the reason. Gemini's safety filters are stricter than Claude's by default — sometimes a rewording unblocks the answer.

## Cost discipline

Every call hits the user's Google AI account. Rules of thumb:

- Free tier covers a lot — but rate-limited per minute. If you hit a quota error, surface it and back off.
- Don't pre-call `list_gemini_models` "just to know" — only when the user wants a non-default model.
- For long-context tasks, `gemini-2.5-flash` is typically 5–10× cheaper than `-pro` and good enough. Default to `-flash` unless quality matters.

## Related

- `ask-gpt` — same shape, different provider. If the user said "ask GPT" not "ask Gemini", that's the right skill.
- `ask-grok` — when the user wants live X / web search alongside the answer.
- `nano-banana` (the gemini-image MCP) — separate tool for image generation. Don't confuse with this skill.

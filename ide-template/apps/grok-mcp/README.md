# grok-mcp

MCP server exposing xAI's Grok with optional **live X (Twitter) and web search**, via the Responses API (`POST /v1/responses`).

## Tool

`ask_grok` — single-shot Q&A. Required: `prompt`. Optional:

| Arg | Type | What it does |
|---|---|---|
| `system` | string | System-level instruction (tone, persona, format). |
| `model` | string | Override model. Default `grok-4-latest`. |
| `temperature` | number 0–2 | Sampling. Default 0.7. |
| `max_tokens` | int | Output cap. Default 1024. |
| `search` | bool / `'on'` / `'off'` / `'auto'` | Enable real-time search. `on` = always search, `auto` = Grok decides per query, `off` (default) = no search. |
| `search_sources` | array of `'x'`/`'web'`/`'news'`/`'rss'` | Which sources to consult when search is on. Default `['web', 'x']`. Drop `'web'` for X-only takes; drop `'x'` for web-only fact-checks. |
| `max_search_results` | int 1–30 | Result cap. Default 10. |
| `return_citations` | bool | Append source URLs to the answer. Default true when search is on. |

Returns the assistant's text plus, when search is on, a **Sources** block listing the URLs Grok consulted.

## When to use it (Claude's perspective)

- "What's the chatter on X about <topic>?" → `search: 'on'`, `search_sources: ['x']`
- "Has any major outlet reported on <X> in the last 24h?" → `search: 'on'`, `search_sources: ['web', 'news']`
- "Second opinion on this code review" → `search: 'off'` (knowledge-only)
- Time-sensitive fact-checks → `search: 'auto'` lets Grok decide

## Activation

Self-service via the workspace **Integrations** dashboard. The user pastes their `XAI_API_KEY` (from console.x.ai) into the activation modal; workspace-api encrypts it at rest and injects it as the env var when claude spawns this MCP server.

## Local test

```bash
XAI_API_KEY=xai-... node index.js
```

Then send a manual `ListTools` / `CallTool` request via any MCP client (or wire it into a local `.claude.json`).

## Env vars

| Name | Required | Default | Notes |
|---|---|---|---|
| `XAI_API_KEY` | yes | — | Bearer token from console.x.ai |
| `XAI_MODEL` | no | `grok-4-latest` | Default model id |
| `XAI_BASE_URL` | no | `https://api.x.ai/v1` | Override for staging / proxy |

## Implementation notes

- Endpoint: `POST {XAI_BASE_URL}/responses` (the `/chat/completions` path's live-search support was deprecated; the Responses API is the current one).
- Request body: `{ model, input, instructions, temperature, max_output_tokens, search_parameters? }` where `search_parameters` is `{ mode, sources, return_citations, max_search_results? }`.
- Response parser handles both the convenience `output_text` field and the structured `output: [{ type: 'message', content: [{ type: 'output_text', text }] }]` shape. Citations are pulled from top-level `citations[]` and per-message `citations[]` and deduped.
- No streaming — single-shot for simplicity. The MCP layer doesn't currently expose progress updates anyway.

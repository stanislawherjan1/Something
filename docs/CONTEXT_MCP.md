# Context MCP

## User guide

Context MCP lets the AI agent you already work with on your computer —
**Claude Code** or **Codex** — use your coworker's knowledge. Once it is
connected, the agent knows the company the way you do: what the company is and
its rules, the team, what was agreed with clients, the team's tasks and the
shared files. Ask it to build a landing page and it uses your real prices and
tone instead of guessing; ask it what is due this week and it checks the
board.

The agent meets your coworker under its own name. If your coworker is called
Aria, you can say "ask Aria who approves discounts" and the agent will look it
up.

**Connecting.**

1. In the workspace, open **Context MCP** in the sidebar.
2. Pick your agent (Claude Code or Codex). For Claude Code, choose whether
   your coworker should be there in just one project or in all your projects
   on this computer.
3. Copy the command and paste it into a terminal. For one project, paste it
   in that project's folder.
4. Your browser opens. Check what the agent may do, change it if you like, and
   click **Allow**.
5. Start a new conversation in your agent. A conversation that was already
   open does not see the new connection.

It works on a Mac and on Linux. Codex works whether you installed it in the
terminal or only as the editor extension.

**What it can see.** It reads as you: what you can see in the workspace,
never more, and nothing of anyone else's private things. By default that means
the team's memory, the conversations in the rooms you are in, the team board
and the shared files. Your private things — your private memory, how you like
things done, your own task list and your own folder — stay closed unless you
tick **Read your private things** when you connect. Passwords, PINs, codes
and keys never reach it, whether they sit in memory or in a shared file: the
agent is told a line was held back, and why.

**What it can do.** If you leave the boxes ticked, it can add or update a
task, save something you told it to memory, file a summary of the session in
your memory, and save a text file in your folder or a shared folder. Your
agent asks you before every one of these, and you can say no. If you tick
**Ask your assistant**, it can also put a question to your coworker the way
you would in your own chat. That never changes anything and is limited to a
few questions an hour.

**Where it shows up.** Every read and every write the agent makes appears on
**Memory → Changes**, with the agent's name. A summary the agent files lands
in your private memory as "Context MCP: the project (the day)", with the
agent's logo next to it, and your coworker knows it in your chats from then
on.

**Disconnecting.** The **Connected** tab of the Context MCP page lists your
agents; the bin disconnects one at once. An admin sees which agents the team
has connected, never what they read. When someone leaves the team, their
agents stop working with them.

**Staying safe.** Only connect from the command on the Context MCP page, and
only an agent that runs on your own computer: the workspace accepts nothing
else. If you are ever sent a link that opens the "Connect … to …?" page and
you did not just run the command yourself, click **Deny**.

## How it works

Every other integration is outbound: the workspace is an MCP *client* of a
service. Context MCP is the inbound one: the workspace is an MCP *server* at
`https://<domain>/mcp`, and an agent on a person's computer is its client,
reading and writing as that person. The page gives steps for Claude Code and
Codex; any MCP client with OAuth and a loopback redirect can connect.

### The request path

```
agent ──POST /mcp, Bearer token──▶ nginx ──auth_request──▶ auth-service /auth/verify-agent
                                     │                       (token → grant → person, roster re-checked)
                                     │◀── X-IDE-User, grant, scopes, client, X-IDE-Agent-Sig
                                     └──▶ workspace-api /mcp (routes/mcp.js)
                                           verifies the signature, builds the person's viewer,
                                           serves the tools their grant allows (lib/mcp/)
```

- **auth-service** (`auth-service/agents.js`) is the OAuth 2.1 authorization
  server. It already does Google sign-in, holds the session secret and the
  roster, has direct internet for the one outbound call this needs, and holds
  no integration key — which is why this does not live in workspace-api.
- **nginx** (`frontend/nginx.conf`) keeps `/mcp` behind
  `auth_request /auth/verify-agent`, strips the cookie and the Authorization
  header, and passes the verified identity on.
- **workspace-api** never sees a bearer token. It checks `X-IDE-Agent-Sig`, an
  HMAC over the person, grant, scopes, client and a one-minute expiry under a
  key derived from the session secret (`lib/mcp/identity.js`), so nothing
  inside the container can forge an agent by setting headers on port 3001.
- The endpoint is Streamable HTTP (protocol 2025-11-25), stateless, POST only
  (GET and DELETE answer 405), Origin-checked against the workspace's domain.

### Connecting

The page's commands, with the bot's name as the server's name (so the
agent's tools read "Aria: get_context"):

| Client | Command | Notes |
|---|---|---|
| Claude Code | `claude mcp add [--scope user] --transport http Aria https://<domain>/mcp && claude mcp login Aria` | without `--scope user` it is the current project's only |
| Codex | `codex mcp add Aria --url https://<domain>/mcp` | signs in by itself; the page's version finds `codex` on the PATH or inside the Codex editor extension (VS Code, Insiders, Cursor, Windsurf), with `find` rather than a glob, since zsh aborts a command on an unmatched glob |

The commands are POSIX shell; a Windows (PowerShell) variant is not offered
yet. Cursor is left off the page until its install link is checked with the
app.

The sign-in follows the MCP authorization spec: the endpoint answers 401 with
`WWW-Authenticate: Bearer resource_metadata=…`; the client reads the
protected-resource metadata (RFC 9728) and the authorization-server metadata
(RFC 8414); it identifies itself by a Client ID Metadata Document (its
`client_id` is the HTTPS URL of its metadata — Claude Code's and Codex's are
on claude.ai and chatgpt.com) or, for older clients, by dynamic registration
(RFC 7591, persisted only after the first consent); then the
authorization-code flow with PKCE S256 and the `resource` indicator
(RFC 8707).

- **Redirects are loopback only** (`http://localhost`, `127.0.0.1`, `[::1]`,
  any port — RFC 8252), registered or listed in a metadata document (its other
  URIs are ignored). A redirect to a website would let anyone register a
  client called "Claude Code" that sends the code to their own server.
- **The consent page** (`/app/connect?req=…`) names the client, the person
  signed in and where the agent runs, and offers every scope whatever the
  client asked for; the person chooses. Deny and Allow both answer the
  client's redirect.
- **Tokens** are opaque: a one-hour access token and a rotating thirty-day
  refresh token (sliding), stored hashed in `/var/auth-store`
  (`agent-grants.json`). A spent refresh token presented again ends the grant.
  Every use re-checks the roster and "sign out everywhere"; a person taken off
  the team is refused at once by workspace-api and their refresh fails within
  the roster cache window (30 s). `POST /oauth/revoke` (RFC 7009) is what
  `claude mcp logout` calls.

### Scopes

| Scope | Default | Gives |
|---|---|---|
| `read` | always | company context, the team's memory and the rooms the person is in, the board, the shared files, the team's rules |
| `read:private` | off | the person's private memory, their cards (profile, preferences) and standing rules, their own task list, their folder |
| `write:tasks` | on | `add_task`, `update_task` |
| `write:memory` | on | `remember`, `log_session` |
| `write:files` | on | `write_file` |
| `ask` | off | `ask_<bot>` (also needs `read:private`) |

A tool exists only when its scope was granted: a read-only grant sees reads
alone, so an agent never offers what it cannot do.

### Tools, resources, prompt

Reads (`lib/mcp/context.js`, through the same libraries and the same viewer as
the web routes, `lib/viewer.js` — admins no wider than members):

| Tool | What it returns |
|---|---|
| `get_context` | one short document: the company card, the rules, the person (with `read:private`), the team, and what memory and the board hold about the project named |
| `search_memory` | facts matching a query, with dates — never a conversation's lines or a notetaker's transcript |
| `memory_timeline` | a thing's facts in time order, past ones marked |
| `list_tasks` | `mine`, `board` or `all` |
| `search_files`, `read_file` | the shared files (and the person's folder with `read:private`); never memory, hidden paths or other people's trees |

Writes (`lib/mcp/writes.js`):

| Tool | How |
|---|---|
| `add_task`, `update_task` | through the tasks route as the person (a loopback call with a turn token issued for them, revoked after), so the own-list rules and memory links are the chat's; nothing is deleted from here |
| `remember` | through the memory-note route with the person's own words in `said` |
| `log_session` | one record per project per day in the person's private scope (source `agent`), and one fact "Context MCP: <project> (<day>)" that a later summary the same day updates |
| `write_file` | text files (md, txt, csv, json, yaml, 1 MB) into the person's folder or an existing shared folder; never memory, dot-folders, another tree, a hidden or locked path; replacing needs `overwrite` and the current sha256, and the previous version is kept under `.versions/` |

`ask_<bot>` (named after the bot) runs a one-shot turn as the person
(`askForAgent` in `lib/integrations/private-lookup.js`): no built-in tools,
memory reads only, the question treated as a question, a request to act
answered as refused.

Resources: `workspace://company/mission`, `workspace://company/rules`,
`workspace://team/roster`, `workspace://files/<path>`, and with `read:private`
`workspace://me/profile` and `workspace://me/preferences`. Prompt:
`company-context`.

Every answer is wrapped as data (`<<<WORKSPACE DATA … >>>`), never
instructions.

### Safeguards

- **Credentials.** A fact, a line of a shared file, or an answer of the ask
  tool shaped like a credential (password, PIN, door code, key, token, login
  with a secret) is held back, with a note (`looksLikeSecret`, a shape test,
  no model). A write whose text looks like one is refused.
- **Asked before writing.** Every write tool carries
  `_meta["anthropic/requiresUserInteraction"]` and `readOnlyHint: false`. The
  question is the client's: Claude Code asks every time (an allow rule for
  the server does not skip it; `claude -p` and `--permission-prompt-tool`
  cannot answer it), and Codex asked before each write in a live check.
- **What the server holds whatever the client does:** the scopes ticked, the
  budgets, the credential refusal, and an `agent_write` event on the person's
  Changes for every write (`agent_read` for every read).
- **Memory.** A fact written `by: agent:<client>` is held to a plain fact by
  the engine — never a rule, a preference or a profile line. Session records
  never pass through sharing, so they stay private.

| Budget | Limit |
|---|---|
| Requests per grant | 120 a minute (429) |
| Writes per grant | 20 a minute, 200 a day |
| Questions to the assistant | 5 an hour per grant |
| Sign-in endpoints per address | 300 per 15 minutes (`AGENT_AUTH_LIMIT`), a counter of its own so agents never use up people's Google sign-ins |

The threat model and the reasons behind each choice are in
[SECURITY.md](SECURITY.md) §19d.

### Where it shows up in the app

- **Context MCP page** (`views/CodingAgentsView.jsx`): Connect (the commands)
  and Connected (the person's agents; an admin also sees the team's, without
  scopes). Hidden in the public demo.
- **Consent page** (`ConsentPage.jsx`, `/app/connect`).
- **Memory**: session facts carry the client's logo (`agentLogo` in
  `routes/memory-v4.js`) and "From Claude Code · <project>" as their source;
  reads and writes are on Changes.
- **The bot** (`global-claude.md`) points people who work with Claude Code or
  Codex to the page, and knows what a "Context MCP: …" fact is.

### Operating it

Nothing to configure: the endpoint, the authorization server and the
`auth-store` volume come with the stack. A deploy needs auth-service and
workspace-api from the same commit (they derive the same signing key).

| Symptom | Cause |
|---|---|
| `command not found: codex` | Codex is not installed at all; the page's command already looks inside the editor extension |
| The agent does not see the server | the conversation was open before connecting; start a new one |
| `redirect_uri is not registered` / `invalid_redirect_uri` | the client wants a non-loopback redirect, which is refused by design |
| Consent page says the request expired | more than ten minutes passed, or the auth service restarted; run the command again |
| 401 after it worked | the token expired and the refresh failed (person off the team, signed out everywhere, or the connection was removed); connect again |
| 429 from `/mcp` | more than 120 requests a minute from one connection |

Logs: `docker logs <ide>-auth | grep auth/agents` (connections, refusals,
revocations); every agent read and write is in
`memory/_engine/v4-log.jsonl` as `agent_read` / `agent_write`.

### Tests

- `node auth-service/agents.test.js` — the authorization server (in CI).
- `node workspace-api/lib/mcp.test.mjs` — the endpoint through a real MCP
  client: scopes, privacy, credentials, writes, ask, audit (in `npm test`).
- `scripts/e2e/mcp-agent.sh` — a scripted agent against a live deployment:
  discovery, registration, consent, PKCE, refresh, reads, the admin no wider,
  a person removed from the team, disconnect. No model turns.
- `scripts/e2e/mcp-eval/run.py` — real headless Claude Code sessions as
  different people with different consents, graded on what they reach for and
  what comes back (scenarios per deployment, in `clients/<client>/`). Writes
  cannot be tested headless: Claude Code refuses them without a person.

See [TESTING.md](TESTING.md).

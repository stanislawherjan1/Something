/**
 * First-run onboarding store.
 *
 * Tracks whether the workspace has the basics it needs to be useful:
 *   - Org branding (title, optionally bot name) — lives in lib/branding.js
 *   - Claude OAuth token (CLAUDE_CODE_OAUTH_TOKEN) — encrypted here
 *   - At least one admin on the team — lib/team.js
 *
 * The Claude OAuth token is a long-lived secret (~1 year), so it sits in
 * the encrypted credentials store under the special key `_platform`. The
 * normal integrations catalog doesn't list it — the user provides it via
 * the onboarding wizard, not via the integrations dashboard.
 *
 *   PROJECT_DIR/.platform.json — { claudeTokenSetAt, updatedAt, updatedBy }
 *   PROJECT_DIR/.platform.token.enc — { iv, ciphertext, tag } (encrypted)
 *
 * Plaintext only ever exists in memory. Reading the token (e.g. to inject
 * into the bot's environment) goes through readClaudeToken() which decrypts
 * on demand; callers must check isReady() / `hasClaudeToken()` first.
 */

import {
  mkdirSync, readFileSync, writeFileSync, renameSync, existsSync,
  chmodSync, unlinkSync, appendFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { PROJECT_DIR } from './config.js';
import { encryptValue, decryptValue, isReady as cryptoReady, readinessError } from './integrations/crypto.js';
import * as branding from './branding.js';
import * as team from './team.js';

// Phase-2 broker isolation: platform secrets moved out of PROJECT_DIR
// into /var/wsapi-store/ alongside the integrations store. Same uid-1001
// ownership; same defence rationale (PROJECT_DIR is group-shared).
// entrypoint.sh migrates pre-Phase-2 files on first boot.
const PLATFORM_DIR = process.env.WSAPI_STORE_DIR || PROJECT_DIR;
const META_FILE  = join(PLATFORM_DIR, '.platform.json');
const META_TMP   = join(PLATFORM_DIR, '.platform.json.tmp');
const TOKEN_FILE = join(PLATFORM_DIR, '.platform.token.enc');
const TOKEN_TMP  = join(PLATFORM_DIR, '.platform.token.enc.tmp');
// Append-only JSONL log of every setup state change. Mirrors team.js's audit
// pattern — same line shape so a single tail can follow both. Mode 0600,
// rotated externally if it ever grows large (typical wizard runs ~5 entries
// per onboarding).
const AUDIT_FILE = join(PLATFORM_DIR, '.platform.audit.log');

function appendAudit(action, actor, extra) {
  const line = JSON.stringify({
    ts:     new Date().toISOString(),
    action,
    actor:  (actor ? String(actor).trim().toLowerCase() : null) || 'wizard',
    ...(extra || {}),
  }) + '\n';
  try {
    appendFileSync(AUDIT_FILE, line, { mode: 0o600 });
    chmodSync(AUDIT_FILE, 0o600);
  } catch (err) {
    process.stderr.write(`[setup] audit append failed: ${err.message}\n`);
  }
}

function readMeta() {
  if (!existsSync(META_FILE)) return {};
  try {
    const raw = readFileSync(META_FILE, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    process.stderr.write(`[setup] meta read failed: ${err.message}\n`);
    return {};
  }
}

function writeMeta(meta) {
  try { mkdirSync(PROJECT_DIR, { recursive: true }); } catch {}
  writeFileSync(META_TMP, JSON.stringify(meta, null, 2), { mode: 0o600 });
  try { chmodSync(META_TMP, 0o600); } catch {}
  renameSync(META_TMP, META_FILE);
  try { chmodSync(META_FILE, 0o600); } catch {}
}

export function hasClaudeToken() {
  return existsSync(TOKEN_FILE);
}

export function readClaudeToken() {
  if (!cryptoReady()) throw new Error(`Encryption not configured: ${readinessError()}`);
  if (!hasClaudeToken()) throw new Error('Claude OAuth token is not set.');
  const raw = readFileSync(TOKEN_FILE, 'utf8');
  const record = JSON.parse(raw);
  return decryptValue(record);
}

/**
 * Re-hydrate the bot's on-disk credential files from the encrypted store.
 *
 * The encrypted store at /var/wsapi-store/.platform.token.enc lives on a
 * Docker volume → survives container recreate. The bot's runtime files
 * (~/.claude/.credentials.json + ~/.<bot>/integrations.env) do NOT — they
 * sit inside the container's writable layer and get wiped on every
 * `docker compose up` rebuild. The entrypoint migration block restores
 * them from a one-shot `.migrated.bak` snapshot that was taken at the
 * Phase-3 migration months ago, so after each redeploy the bot boots
 * with whatever token was current then — usually expired.
 *
 * Symptom on the wire: encrypted store has the fresh token (web chat
 * works), but bot's tmux session hits "API Error: 401 — Invalid auth
 * credentials" on every Telegram message because its env+file copy
 * reverted to the stale `.migrated.bak` token.
 *
 * Fix: have wsapi rehydrate the runtime files from the encrypted store
 * on every boot. Source of truth is the volume-persisted encrypted blob;
 * the runtime files are derived state that gets refreshed automatically.
 * Idempotent: writing the same token twice is a no-op semantically.
 *
 * Called from index.js after cryptoReady() + before bot.sh starts
 * spawning claude --channels. Safe to no-op if encrypted store is empty
 * (fresh deploys before the wizard runs).
 */
export function rehydrateRuntimeFiles() {
  if (!cryptoReady()) return { skipped: 'crypto-not-ready' };
  if (!hasClaudeToken()) return { skipped: 'no-token-in-store' };
  let token;
  try { token = readClaudeToken(); }
  catch (err) {
    process.stderr.write(`[setup] rehydrate: read token failed: ${err.message}\n`);
    return { skipped: 'read-failed', error: err.message };
  }
  hydrateClaudeCredentials(token);
  hydrateBotIntegrationsEnv(token);
  return { ok: true };
}

// Claude Code OAuth tokens have a stable prefix. We don't refuse other
// shapes (Anthropic could rev the format), but we surface a warning the
// operator can act on instead of getting a confusing 401 from claude later.
const CLAUDE_TOKEN_RE = /^sk-ant-oat0[0-9]+-/;

export function setClaudeToken(plaintext, actor) {
  if (!cryptoReady()) throw new Error(`Encryption not configured: ${readinessError()}`);
  // Strip ALL whitespace (not just outer trim) — terminals/clipboards often
  // wrap a long token with embedded newlines or spaces. trim() only removes
  // outer whitespace, leaves the internal chars, and the resulting token
  // gets a 401 "Invalid bearer token" from Anthropic. Claude OAuth tokens
  // are alphanumeric + `-_` only, no whitespace anywhere, so this is safe.
  const t = String(plaintext || '').replace(/\s+/g, '');
  if (!t) throw new Error('Token is empty.');
  if (t.length > 4096) throw new Error('Token is suspiciously long.');
  if (t.length < 20)   throw new Error('Token is too short to be valid.');
  if (!CLAUDE_TOKEN_RE.test(t)) {
    throw new Error('Token does not look like a Claude Code OAuth token (expected prefix "sk-ant-oat01-" — run `claude setup-token` to generate one).');
  }

  const encrypted = encryptValue(t);
  try { mkdirSync(PROJECT_DIR, { recursive: true }); } catch {}
  writeFileSync(TOKEN_TMP, JSON.stringify(encrypted), { mode: 0o600 });
  try { chmodSync(TOKEN_TMP, 0o600); } catch {}
  renameSync(TOKEN_TMP, TOKEN_FILE);
  try { chmodSync(TOKEN_FILE, 0o600); } catch {}

  const meta = readMeta();
  meta.claudeTokenSetAt = new Date().toISOString();
  meta.updatedAt        = meta.claudeTokenSetAt;
  if (actor) meta.updatedBy = String(actor).trim().toLowerCase();
  writeMeta(meta);

  // Hydrate ~/.claude/.credentials.json — the file Claude Code's CLI/SDK
  // and the bot.sh tmux session both read on startup. Without this step the
  // encrypted store would hold the canonical copy but the bot would still
  // fail with "API Error: 401 — Invalid authentication credentials".
  hydrateClaudeCredentials(t);

  // Also write CLAUDE_CODE_OAUTH_TOKEN to the bot's integrations.env so the
  // tmux Claude Code session picks it up. Empirically claude CLI prefers the
  // env var over .credentials.json — without this the bot tmux pane shows
  // "Not logged in · Please run /login" even with credentials hydrated.
  hydrateBotIntegrationsEnv(t);

  // Audit + plaintext housekeeping warning.
  appendAudit('token_set', actor, { length: t.length });
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    process.stderr.write(
      '[setup] CLAUDE_CODE_OAUTH_TOKEN is also present in process.env — the\n' +
      '[setup] encrypted store now holds the canonical copy. Remove the env\n' +
      '[setup] var from clients/<client>/.env on next deploy to avoid keeping\n' +
      '[setup] a plaintext duplicate.\n'
    );
  }

  // Bot restart is the caller's responsibility — routes/setup.js awaits
  // runtime.restartBot() so the HTTP response can include the restart
  // result in the response body for the UI to surface. Migration callers
  // (actor === 'migration') intentionally skip restart since the bot
  // doesn't exist yet when migrate runs.
}

// Phase-3 (H4 closure): the Claude OAuth token + bot integrations.env
// move from /home/coder/ (coder-readable) to /home/bot/ (bot-only via
// botshare group, coder-blocked). workspace-api at uid 1001 (wsapi)
// is in the botshare group → can write here. Bot at uid 1003 (in
// botshare) reads. Coder at uid 1000 is NOT in botshare → cannot read.
//
// BOT_USER_HOME is set by PM2 ecosystem.config.js to /home/bot. Falls
// back to homedir() for dev mode (not the deployed shape).
//
// Files end up owned wsapi:botshare mode 0640. The bot's runner
// (initgroups) loads `botshare` so bot.sh can read via group access.
const BOT_USER_HOME      = process.env.BOT_USER_HOME || homedir();
const BOTSHARE_GID       = 1102;
const CLAUDE_CREDS_FILE  = join(BOT_USER_HOME, '.claude', '.credentials.json');
const CLAUDE_CREDS_TMP   = join(BOT_USER_HOME, '.claude', '.credentials.json.tmp');

// chown helper — best-effort; in dev mode (running outside the platform
// container) the gids don't exist and chown fails harmlessly. Imported
// lazily to keep the top-level import block tidy.
async function chownToBotShare(path) {
  try {
    const fs = await import('node:fs');
    fs.chownSync(path, 1001, BOTSHARE_GID);
  } catch (err) {
    // Non-fatal — likely running in dev mode without the uid setup.
    if (process.env.NODE_ENV === 'production') {
      process.stderr.write(`[setup] chown ${path} → 1001:${BOTSHARE_GID} failed: ${err.message}\n`);
    }
  }
}

function hydrateClaudeCredentials(token) {
  try {
    mkdirSync(join(BOT_USER_HOME, '.claude'), { recursive: true });
    const payload = {
      claudeAiOauth: {
        accessToken: token,
        refreshToken: null,
        expiresAt: null,
        scopes: [],
      },
    };
    // Mode 0640 — owner (wsapi) read+write, group (botshare) read,
    // others nothing. Bot reads via the botshare group; coder cannot.
    writeFileSync(CLAUDE_CREDS_TMP, JSON.stringify(payload, null, 2), { mode: 0o640 });
    try { chmodSync(CLAUDE_CREDS_TMP, 0o640); } catch {}
    renameSync(CLAUDE_CREDS_TMP, CLAUDE_CREDS_FILE);
    try { chmodSync(CLAUDE_CREDS_FILE, 0o640); } catch {}
    chownToBotShare(CLAUDE_CREDS_FILE);
  } catch (err) {
    // Non-fatal: encrypted store is the source of truth, .credentials.json
    // is just runtime hydration. Surface the error so the operator can
    // diagnose if the bot still fails 401 after a token rotation.
    process.stderr.write(`[setup] could not hydrate ${CLAUDE_CREDS_FILE}: ${err.message}\n`);
  }
}

/**
 * Inject CLAUDE_CODE_OAUTH_TOKEN into the bot's integrations.env. Bot.sh
 * sources this file before spawning `claude --channels`, so an entry here
 * shows up as an environment variable to the tmux Claude Code process.
 *
 * The file is also where workspace-api drops Telegram / Shopify / etc.
 * credentials for the bot, so we follow the same `export KEY=value` shape
 * and replace any prior CLAUDE_CODE_OAUTH_TOKEN line in place.
 *
 * Phase-3 path: /home/bot/.<bot>/integrations.env (group=botshare).
 */
function hydrateBotIntegrationsEnv(token) {
  const botName = String(process.env.BOT_NAME || 'bot').trim() || 'bot';
  const botEnvFile = join(BOT_USER_HOME, `.${botName}`, 'integrations.env');
  try {
    mkdirSync(dirname(botEnvFile), { recursive: true });
    let lines = [];
    if (existsSync(botEnvFile)) {
      const raw = readFileSync(botEnvFile, 'utf8');
      lines = raw.split('\n').filter(l => !/^\s*export\s+CLAUDE_CODE_OAUTH_TOKEN=/.test(l) && !/^\s*CLAUDE_CODE_OAUTH_TOKEN=/.test(l));
    }
    // Drop trailing blank lines so we don't pile them up across rotations.
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push(`export CLAUDE_CODE_OAUTH_TOKEN=${token}`);
    writeFileSync(botEnvFile, lines.join('\n') + '\n', { mode: 0o640 });
    try { chmodSync(botEnvFile, 0o640); } catch {}
    chownToBotShare(botEnvFile);
  } catch (err) {
    process.stderr.write(`[setup] could not hydrate bot integrations.env: ${err.message}\n`);
  }
}

export function clearClaudeToken(actor) {
  if (existsSync(TOKEN_FILE)) {
    try { unlinkSync(TOKEN_FILE); } catch {}
  }
  // Wipe runtime credentials so the bot stops trying to auth with a token
  // we no longer hold. Bot.sh refuses to start when both .claude.json and
  // .credentials.json are missing — bot will halt cleanly until next set.
  if (existsSync(CLAUDE_CREDS_FILE)) {
    try { unlinkSync(CLAUDE_CREDS_FILE); } catch {}
  }
  // And drop CLAUDE_CODE_OAUTH_TOKEN from bot integrations.env so a stale
  // export doesn't keep authing the bot after the operator clears the token.
  try {
    const botName = String(process.env.BOT_NAME || 'bot').trim() || 'bot';
    const botEnvFile = join(homedir(), `.${botName}`, 'integrations.env');
    if (existsSync(botEnvFile)) {
      const raw = readFileSync(botEnvFile, 'utf8');
      const lines = raw.split('\n').filter(l => !/^\s*export\s+CLAUDE_CODE_OAUTH_TOKEN=/.test(l) && !/^\s*CLAUDE_CODE_OAUTH_TOKEN=/.test(l));
      writeFileSync(botEnvFile, lines.join('\n'), { mode: 0o600 });
    }
  } catch {}
  const meta = readMeta();
  delete meta.claudeTokenSetAt;
  meta.updatedAt = new Date().toISOString();
  if (actor) meta.updatedBy = String(actor).trim().toLowerCase();
  writeMeta(meta);
  appendAudit('token_clear', actor);

  // Restart is the route's responsibility — see setClaudeToken.
}

// Public audit hook for routes/setup.js — keeps the audit shape consistent
// without exporting appendAudit's full signature.
export function audit(action, actor, extra) {
  appendAudit(action, actor, extra);
}

/**
 * Aggregate "is the workspace usable?" check. Returns:
 *   {
 *     complete: boolean,
 *     missing:  ['title' | 'botName' | 'claudeToken' | 'admin'],
 *     state:    {  // best-effort current snapshot for the UI
 *       title, botName, hasAvatar, hasClaudeToken, claudeTokenSetAt,
 *       admins: number, encryptionReady: boolean,
 *     }
 *   }
 *
 * The wizard only renders when complete === false. Steps line up 1:1 with
 * the missing[] order: title → botName → claudeToken. Admin check is a
 * passive gate — bootstrap creates the first admin from IDE_ALLOWED_EMAILS
 * before the wizard ever loads, so the admin check is essentially never
 * the blocker; we surface it for diagnostics.
 */
export function status() {
  const b   = branding.resolve();
  const t   = team.list();
  const meta = readMeta();
  const missing = [];
  const inLegacy = b.legacyMode === true;
  const adminCount = t.filter(e => e.role === 'admin').length;

  // Post-migration fast-path. Skip the wizard entirely when ALL of:
  //   1. Token is set (encrypted store has a token, either freshly via the
  //      wizard or migrated from env at startup)
  //   2. At least one admin exists (bootstrapped from IDE_ALLOWED_EMAILS)
  //   3. The client is recognisably "already running" — either:
  //        - LEGACY_CONFIG=true (operator manages branding via .env), OR
  //        - the project already has a manifest at .claude/CLAUDE.md
  //          (meaning someone has used the workspace at least once and
  //          configured the bot's identity there)
  //
  // The CLAUDE.md condition is what catches clients we just migrated from
  // legacy mode to non-legacy. They have a real project manifest, real
  // history, real reminders — but a default-named .branding.json (just
  // botName from the legacy bootstrap, no title yet). Re-walking them
  // through "step 1 of 4: name your workspace" makes no sense — they can
  // tweak the title from the gear icon when they feel like it.
  const projectManifest = join(PROJECT_DIR, '.claude', 'CLAUDE.md');
  const hasProjectManifest = existsSync(projectManifest);
  const isPostMigration = inLegacy || hasProjectManifest;

  if (isPostMigration && hasClaudeToken() && adminCount > 0) {
    return {
      complete: true,
      missing: [],
      state: {
        title:           b.title,
        botName:         b.botName,
        botDisplayName:  b.botDisplayName,
        hasAvatar:       b.source.avatar === 'file',
        botAvatarUrl:    b.botAvatarUrl,
        hasClaudeToken:  true,
        claudeTokenSetAt: meta.claudeTokenSetAt || null,
        admins:           adminCount,
        encryptionReady:  cryptoReady(),
        encryptionError:  cryptoReady() ? null : readinessError(),
        // Diagnostic — UI doesn't render anything different. Indicates
        // why the wizard was short-circuited (legacy config vs. existing
        // project manifest).
        shortCircuit: inLegacy ? 'legacy' : 'existing-manifest',
      },
    };
  }

  // Title / botName — the env defaults aren't enough; we want the user to
  // *confirm* the brand once via the wizard. So we treat values that came
  // from env (no explicit save) as "not yet set" the first time around.
  // Once .branding.json exists with explicit fields, those win.
  //
  // For non-legacy mode this still matters (new clients should pick a
  // proper name during onboarding). The legacy fast-path above handles
  // legacy clients separately.
  const titleOk   = inLegacy ? Boolean(b.title   && b.title   !== 'Workspace')   : b.source.title   === 'file';
  const botNameOk = inLegacy ? Boolean(b.botName && b.botName !== 'assistant')   : b.source.botName === 'file';
  if (!titleOk)   missing.push('title');
  if (!botNameOk) missing.push('botName');
  if (!hasClaudeToken())  missing.push('claudeToken');
  if (adminCount === 0)   missing.push('admin');

  return {
    complete: missing.length === 0,
    missing,
    state: {
      title:           b.title,
      botName:         b.botName,
      botDisplayName:  b.botDisplayName,
      hasAvatar:       b.source.avatar === 'file',
      botAvatarUrl:    b.botAvatarUrl,
      hasClaudeToken:  hasClaudeToken(),
      claudeTokenSetAt: meta.claudeTokenSetAt || null,
      admins:           t.filter(e => e.role === 'admin').length,
      encryptionReady:  cryptoReady(),
      encryptionError:  cryptoReady() ? null : readinessError(),
    },
  };
}

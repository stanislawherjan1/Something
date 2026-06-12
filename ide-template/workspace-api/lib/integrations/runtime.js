/**
 * Runtime side of integrations.
 *
 *   syncMcpServers()  — patch /home/coder/.claude.json's `mcpServers` block
 *                       to match the active set, with decrypted env injected
 *                       into each spawn config. Called on every activate /
 *                       remove so the next claude turn picks up the change
 *                       without restarting any process.
 *
 *   restartBot()      — fire-and-forget `pm2 restart <bot>` after every
 *                       activate/deactivate. The bot caches ~/.claude.json
 *                       into ~/.${BOT}/.claude.json on startup, so it can't
 *                       see new MCP servers until restarted — even though
 *                       claude -p (web chat) picks them up on the next turn.
 *
 * MCP layer notes — claude reads ~/.claude.json on each invocation; spawned
 * MCP processes inherit the env declared there. So writing the file is the
 * single source of truth for web chat. The Telegram bot needs the explicit
 * restart because it doesn't re-read its config mid-session.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, chmodSync, chownSync, cpSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as catalog from './catalog.js';
import * as store from './store.js';
import { issueGrant } from './broker.js';

// Phase-2 broker isolation. MCPs no longer get plaintext credentials in
// their spawn env — they get a nonce + integration id, and fetch the
// real fields over UDS at startup. The setuid wrapper drops them to
// uid 1002 before exec'ing node, so the bot/coder uid 1000 cannot read
// MCP /proc/<pid>/environ.
const MCP_RUNNER_BIN = process.env.MCP_RUNNER_BIN || '/usr/local/bin/mcp-runner';
const BROKER_SOCKET  = process.env.BROKER_SOCKET || '/var/wsapi-store/run/broker.sock';

const HOME = process.env.HOME || '/home/coder';
const CLAUDE_CONFIG = process.env.CLAUDE_CONFIG_PATH || join(HOME, '.claude.json');

// Marker key on each MCP server entry we manage so we can rewrite our entries
// without trampling ones the bot configured itself (e.g. via `claude mcp add`).
const MANAGED_MARKER = '_managed_by_workspace_api';

// Catalog paths and args support a few placeholders so the same catalog file
// works in local dev (with overrides) and production (with /opt/ide etc.):
//   {appsDir}      — directory holding the bundled MCP servers
//   {dataDir}      — writable directory for files generated from UI configs.
//                    Used by legacy integrations that need coder-uid 1000
//                    read access (today only ga4-mcp-server, Python).
//   {secureFiles}  — writable directory for files that must NOT be readable
//                    by the coder uid 1000 (i.e. by the bot). Mode 2770
//                    group=wsapi-broker; only wsapi (1001) and mcp (1002)
//                    can read. Used by integrations spawned via mcp-runner
//                    where the bot must not see plaintext credentials —
//                    today only email-imap accounts.json.
//   {home}         — the BOT user's home directory (Phase-3 H4 closure).
//                    Used by the catalog for `{home}/.{bot}/integrations.env`
//                    where the bot reads its env on startup. This is the
//                    bot user's home (/home/bot, owner=bot), not wsapi's
//                    own HOME (which is /home/coder via PM2 inheritance).
//                    Override with BOT_USER_HOME env var; falls back to
//                    process.env.HOME for dev mode.
//   {bot}          — value of BOT_NAME (lowercased)
function resolvePath(s) {
  if (typeof s !== 'string') return s;
  const appsDir     = (process.env.MCP_APPS_DIR          || '/opt/ide/apps').replace(/\/+$/, '');
  const dataDir     = (process.env.INTEGRATIONS_DATA_DIR || '/home/coder/.integrations-data').replace(/\/+$/, '');
  const secureFiles = (process.env.SECURE_FILES_DIR      || '/var/wsapi-store/files').replace(/\/+$/, '');
  const home        = (process.env.BOT_USER_HOME || process.env.HOME || '/home/coder').replace(/\/+$/, '');
  const bot         = (process.env.BOT_NAME              || 'bot').toLowerCase();
  return s
    .replaceAll('{appsDir}',     appsDir)
    .replaceAll('{dataDir}',     dataDir)
    .replaceAll('{secureFiles}', secureFiles)
    .replaceAll('{home}',        home)
    .replaceAll('{bot}',         bot);
}

function readClaudeConfig() {
  if (!existsSync(CLAUDE_CONFIG)) return {};
  try { return JSON.parse(readFileSync(CLAUDE_CONFIG, 'utf8')); }
  catch (err) {
    process.stderr.write(`[integrations-runtime] cannot parse ${CLAUDE_CONFIG}: ${err.message}\n`);
    return {};
  }
}

function writeClaudeConfig(cfg) {
  writeFileSync(CLAUDE_CONFIG, JSON.stringify(cfg, null, 2));
  // Phase-3 H4 invariant: when CLAUDE_CONFIG_PATH points at
  // /home/bot/.claude.json, coder uid 1000 must NOT be able to read it.
  // entrypoint.sh pre-seeds the file mode 0660 group=botshare, and the
  // /home/bot setgid bit means files we create here also land
  // group=botshare. But Node's writeFileSync mode option only applies
  // when creating a new file, and umask 022 would land 0644 otherwise.
  // Force 0660 explicitly. EACCES is silently OK — it means we don't
  // own the file (entrypoint pre-seeded as root with owner=bot), and
  // the existing mode is already what we want.
  try { chmodSync(CLAUDE_CONFIG, 0o660); } catch {}
}

/**
 * Rebuild the managed slice of mcpServers based on the catalog + active store.
 *
 * Strategy:
 *   1. Read .claude.json
 *   2. Drop every entry whose value carries our MANAGED_MARKER
 *   3. For each active integration with mcp config in catalog, insert a new
 *      managed entry with command/args from catalog + decrypted env from store
 *   4. Write back
 *
 * Manual entries (no marker) are preserved untouched.
 *
 * Returns { changed: boolean } — true when the resulting mcpServers block
 * differs from what was on disk before. Caller uses this to decide whether
 * a bot restart is actually needed (vs. an idempotent re-save).
 */
export function syncMcpServers() {
  const cfg = readClaudeConfig();
  const existing = cfg.mcpServers || {};
  const before = JSON.stringify(existing);

  // Step 1 — keep manual entries.
  const next = {};
  for (const [name, entry] of Object.entries(existing)) {
    if (entry && !entry[MANAGED_MARKER]) next[name] = entry;
  }

  // Step 2 — rebuild managed entries from catalog + active store.
  //
  // Default path: each MCP is spawned via /usr/local/bin/mcp-runner
  // (setuid root, drops to uid 1002 before exec'ing node). Plaintext
  // credentials NEVER go into the spawn env — each spawn gets a
  // single-use BROKER_NONCE that lets the MCP fetch its creds from the
  // in-process broker over UDS at startup. Bot at uid 1000 cannot read
  // mcp-uid /proc/<pid>/environ AND cannot connect to the broker UDS
  // (group-gated), so even with shell access the bot never sees these
  // values.
  //
  // Legacy path: integrations whose `mcp.command` is set to anything
  // other than `node` (today only `ga4` which spawns the Python
  // `ga4-mcp-server` binary) skip mcp-runner — the wrapper only knows
  // how to launch node MCPs under /opt/ide/apps/. Legacy spawns inject
  // plaintext env directly, same as pre-Phase-2. ga4 doesn't carry user
  // secrets in its env (just the numeric GA4_PROPERTY_ID + a path to a
  // file) so this is acceptable; full coverage requires a generalised
  // mcp-runner that can launch arbitrary whitelisted commands.
  for (const id of store.activeIds()) {
    const cat = catalog.get(id);
    if (!cat || !cat.mcp) continue;          // Telegram has no MCP — handled separately
    const { extraEnv = {}, inheritEnv = [], services } = cat.mcp;
    const isLegacy = cat.mcp.command && cat.mcp.command !== 'node';

    // ─── Legacy path (ga4 + future non-node MCPs) ───────────────────────
    if (isLegacy) {
      let plain;
      try { plain = store.decryptFor(id); }
      catch (err) {
        process.stderr.write(`[integrations-runtime] decrypt ${id} failed: ${err.message}\n`);
        continue;
      }
      const legacyEnv = {};
      for (const [k, v] of Object.entries(extraEnv)) {
        legacyEnv[k] = typeof v === 'string' ? resolvePath(v) : v;
      }
      for (const varName of inheritEnv) {
        const v = process.env[varName];
        if (typeof v === 'string' && v) legacyEnv[varName] = v;
      }
      for (const [catalogField, envName] of Object.entries(cat.mcp.envMap || {})) {
        if (plain[catalogField] != null && plain[catalogField] !== '') {
          legacyEnv[envName] = plain[catalogField];
        }
      }
      const { command, args = [], name } = cat.mcp;
      if (!name || !command) continue;
      next[name] = {
        command,
        args: args.map(a => typeof a === 'string' ? resolvePath(a) : a),
        env: legacyEnv,
        [MANAGED_MARKER]: true,
      };
      continue;
    }

    // Build the non-secret part of the env that's safe to pass at spawn
    // time. `extraEnv` is static catalog defaults (model names, output
    // dirs, etc. — no secrets). `inheritEnv` pulls platform-level env
    // vars from workspace-api's process (e.g. GOOGLE_CLIENT_ID for the
    // google-ads OAuth flow — those are platform-shared, not per-tenant
    // secrets). User-supplied fields (the actual credentials) are NOT
    // here — they arrive via the broker.
    const baseEnv = {
      BROKER_SOCKET,
      BROKER_INTEGRATION_ID: id,
      // Force Node's dns.lookup to return IPv4 first. Post-egress-pivot
      // we route raw TCP (IMAP, SMTP) through the egress-proxy via HTTP
      // CONNECT. Imapflow + nodemailer pre-resolve the hostname client-
      // side and send the resolved IP in the CONNECT line. Our
      // bot-net network is IPv4-only (no IPv6 subnet), and the proxy's
      // IP allow-list (resolved from allowed-hosts.txt) is A-records
      // only — an AAAA result would fail the dial entirely OR escape
      // the cache. Forcing ipv4first on every MCP keeps the resolved
      // family consistent with what we route + cache.
      NODE_OPTIONS: '--dns-result-order=ipv4first',
    };
    for (const [k, v] of Object.entries(extraEnv)) {
      baseEnv[k] = typeof v === 'string' ? resolvePath(v) : v;
    }
    for (const varName of inheritEnv) {
      const v = process.env[varName];
      if (typeof v === 'string' && v) baseEnv[varName] = v;
    }

    // Bundle shape (`mcp.services: [...]`) — one catalog entry, multiple
    // mcpServers entries. Each service-MCP gets its OWN nonce (single-use
    // means same-nonce-twice fails), but they all reference the same
    // integration id since they share one credential set in the store.
    if (Array.isArray(services) && services.length > 0) {
      for (const svc of services) {
        if (!svc?.name) continue;
        // svc.name is the service id (gdocs, gsheets…). mcp-runner
        // templates it to /opt/ide/apps/<svc.name>-mcp/index.js.
        next[svc.name] = {
          command: MCP_RUNNER_BIN,
          args:    [svc.name],
          env: {
            ...baseEnv,
            BROKER_NONCE: issueGrant(id),
          },
          [MANAGED_MARKER]: true,
        };
      }
      continue;
    }

    // Single shape — `mcp.name` is the integration id (or a near-variant
    // — e.g. gemini-image's mcp.name is "nano-banana"). mcp-runner
    // resolves /opt/ide/apps/<mcp.name>-mcp/index.js.
    const { name } = cat.mcp;
    if (!name) continue;

    next[name] = {
      command: MCP_RUNNER_BIN,
      args:    [name],
      env: {
        ...baseEnv,
        BROKER_NONCE: issueGrant(id),
      },
      [MANAGED_MARKER]: true,
    };
  }

  cfg.mcpServers = next;
  const after = JSON.stringify(next);
  const changed = before !== after;

  if (changed) {
    try {
      writeClaudeConfig(cfg);
    } catch (err) {
      process.stderr.write(`[integrations-runtime] write ${CLAUDE_CONFIG} failed: ${err.message}\n`);
      throw err;
    }
  }

  return { changed };
}

/**
 * Walks /opt/ide/skills/optional/, parses each SKILL.md frontmatter for a
 * `requires:` field, and returns [{ name, src, requires: string[] }, ...].
 * Folder layout is free — a skill is any directory containing a SKILL.md.
 *
 * `requires:` can be either a scalar (`requires: shopify`) or a YAML-style
 * array (`requires: [seedream, nano-banana]`). Quote chars are stripped.
 */
function discoverOptionalSkills(optDir) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    if (entries.some(e => e.isFile() && e.name === 'SKILL.md')) {
      const skillPath = join(dir, 'SKILL.md');
      const text = readFileSync(skillPath, 'utf8');
      const parts = text.split('---');
      if (parts.length < 3) return;
      const fm = parts[1];
      let requires = [];
      for (const line of fm.split('\n')) {
        if (!line.startsWith('requires:')) continue;
        const val = line.slice('requires:'.length).trim();
        if (val.startsWith('[')) {
          requires = val.replace(/^\[|\]$/g, '').split(',').map(v => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        } else {
          requires = [val.replace(/^["']|["']$/g, '')];
        }
        break;
      }
      if (requires.length) {
        out.push({ name: dir.split('/').pop(), src: dir, requires });
      }
      return;   // a skill folder doesn't contain other skill folders
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(dir, e.name));
    }
  }
  walk(optDir);
  return out;
}

/**
 * Install matching optional skill(s) for an integration that's just been
 * activated. Looks at every SKILL.md under /opt/ide/skills/optional/, parses
 * its `requires:` frontmatter, and copies the skill to the PROJECT-level
 * skills folder (~/project/.claude/skills/) if `id` is in the requires list.
 *
 * Why project-level (not global)? Globals are the base flow we guarantee on
 * every deploy — they get overwritten. Per-integration skills are seeds the
 * user customises, deletes, or evolves over time, so they live in the
 * project where edits stick + sync to Drive on legacy clients.
 *
 * Idempotent: if the destination already exists, we leave it alone — user
 * edits and manual deletes survive. Removing the integration does NOT
 * uninstall the skill (the user might still want the playbook as a
 * reference, and skills can survive a re-activate).
 *
 * Returns the list of skill names installed in this call.
 */
export function installOptionalSkill(id) {
  const optDir = process.env.OPTIONAL_SKILLS_DIR || '/opt/ide/skills/optional';
  if (!existsSync(optDir)) return [];

  const projectDir = process.env.PROJECT_DIR || '/home/coder/project';
  const destRoot = join(projectDir, '.claude', 'skills');
  const installed = [];

  const skills = discoverOptionalSkills(optDir);
  for (const skill of skills) {
    if (!skill.requires.includes(id)) continue;
    const dest = join(destRoot, skill.name);
    if (existsSync(dest)) continue;   // never overwrite — respect user edits

    try {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(skill.src, dest, { recursive: true });
      installed.push(skill.name);
    } catch (err) {
      process.stderr.write(`[integrations-runtime] failed to install ${skill.name}: ${err.message}\n`);
    }
  }

  if (installed.length) {
    process.stderr.write(`[integrations-runtime] installed optional skills: ${installed.join(', ')}\n`);
  }
  return installed;
}

/**
 * Some integrations need a config file on disk (email-imap accounts.json,
 * GA4 service-account JSON) — the MCP servers read paths, not env content.
 * Catalog entries declare `mcp.writeFiles: [{ path, fromField, mode? }]`.
 * Called from routes after store.activate so the file is in place before
 * the MCP first spawns.
 */
export function applyFiles(id) {
  const cat = catalog.get(id);
  if (!cat?.mcp?.writeFiles) return;

  let plain;
  try { plain = store.decryptFor(id); }
  catch { return; }   // not active or decrypt failure — nothing to write

  for (const spec of cat.mcp.writeFiles) {
    const content = renderFile(spec, plain);
    if (content == null) continue;
    const path = resolvePath(spec.path);
    try {
      mkdirSync(dirname(path), { recursive: true });
      // Special handling for shell-env: merge into existing file rather
      // than overwrite. The same env file is shared with setup.js
      // (CLAUDE_CODE_OAUTH_TOKEN), so a naive overwrite wipes those lines.
      if (content && typeof content === 'object' && content.__mergeShellEnv) {
        mergeShellEnv(path, content.fields, content.plain, spec.mode || 0o600);
      } else {
        writeFileSync(path, content, { mode: spec.mode || 0o600 });
        chmodSync(path, spec.mode || 0o600);
      }
      // Phase-2: files under {secureFiles}/ get chgrp wsapi-broker (1101)
      // so the mcp uid (1002) can read them via group access. The dir
      // itself is mode 2770 with setgid so newly-created files inherit
      // group=wsapi-broker; the explicit chown belt-and-braces this in
      // case Node's setgid handling differs across Linux versions.
      if (path.startsWith('/var/wsapi-store/files/')) {
        try {
          chownSync(path, 1001, 1101);
        } catch (err) {
          process.stderr.write(`[integrations-runtime] chown ${path} → 1001:1101 failed: ${err.message}\n`);
        }
      }
      // Phase-3 (H4): files under /home/bot/ are bot-readable via the
      // botshare group (1102). wsapi (1001) writes; bot (1003) reads;
      // coder (1000) is NOT in botshare → cannot read.
      //
      // Mode is 0660 (group rw), NOT 0640 (group r-only). Reason: the
      // /home/bot/ tree is setgid (chmod g+s on the dir), so on a fresh
      // boot the file gets CREATED owner=bot (from /home/bot/.<bot>/
      // dir ownership, since wsapi's writeFileSync inherits dir's owner
      // when the file doesn't exist yet — actually it inherits the
      // process uid, but if the entrypoint pre-created the file earlier
      // with bot uid it stays bot). On the *next* wsapi restart wsapi
      // (uid 1001) is no longer the owner — it's only in group botshare,
      // and 0640 gives the group r but not w, so the next writeFileSync
      // hits EACCES. 0660 lets wsapi update the file as a group member
      // regardless of who happens to own it.
      if (path.startsWith('/home/bot/')) {
        // chown is best-effort: when entrypoint pre-seeded the file with
        // owner=bot:botshare on a fresh /home/bot volume, wsapi is in the
        // botshare group but is NOT the file owner, so chown(1001, 1102)
        // returns EPERM. That's harmless — the file's group is already
        // 1102, the mode 0660 (set below) lets wsapi rewrite it as a
        // group member. Skip chown when stat shows we don't need it; only
        // log when something other than "already correct" goes wrong.
        try {
          const st = statSync(path);
          if (st.uid !== 1001 || st.gid !== 1102) {
            try { chownSync(path, 1001, 1102); }
            catch (err) {
              if (err.code !== 'EPERM') {
                process.stderr.write(`[integrations-runtime] chown ${path} → 1001:1102 failed: ${err.message}\n`);
              }
            }
          }
          chmodSync(path, 0o660);
        } catch (err) {
          process.stderr.write(`[integrations-runtime] perm setup ${path} failed: ${err.message}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[integrations-runtime] write ${path}: ${err.message}\n`);
    }
  }
}

/**
 * Merge shell-env style fields into an existing env file, preserving any
 * lines this writer doesn't own (other producers' export statements,
 * comments, blanks). Each writer "owns" the field names listed in its
 * spec — we strip the lines for those names from the existing file, then
 * append fresh values from `plain`.
 */
function mergeShellEnv(path, fields, plain, mode = 0o600) {
  const ownedNames = new Set(fields);
  let existing = [];
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf8').split('\n');
    } catch (err) {
      process.stderr.write(`[integrations-runtime] mergeShellEnv read ${path} failed: ${err.message}\n`);
    }
  }
  // Drop existing lines for fields we own, keep the rest.
  const keep = existing.filter((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
    return !(m && ownedNames.has(m[1]));
  });
  // Trim trailing blanks before appending (avoid pile-up across rotations).
  while (keep.length && !keep[keep.length - 1].trim()) keep.pop();

  // Append fresh values for owned fields.
  for (const name of fields) {
    const v = plain[name];
    if (typeof v !== 'string' || v === '') continue;
    const escaped = v.replace(/'/g, "'\\''");
    keep.push(`export ${name}='${escaped}'`);
  }

  writeFileSync(path, keep.join('\n') + '\n', { mode });
  try { chmodSync(path, mode); } catch {}
}

/**
 * Build the on-disk content for a writeFiles entry from decrypted fields.
 * Supports two modes:
 *   - { fromField: "X" }     — raw string from one field
 *   - { format: "<known>" }  — special-case serialiser (e.g. email-accounts)
 *
 * Adding a new format = add one case here.
 */
function renderFile(spec, plain) {
  if (spec.fromField) {
    const v = plain[spec.fromField];
    return typeof v === 'string' && v.trim() ? v : null;
  }

  if (spec.format === 'shell-env') {
    // POSIX shell-source-able env file. Used by the Telegram bot — bot.sh
    // sources $HOME/.<bot>/integrations.env on every start. Values are
    // single-quoted with embedded ' escaped, so paste-without-thinking-safe.
    //
    // We DON'T return content here. shell-env is merge-mode by design:
    // the env file is shared across producers (setup.setClaudeToken writes
    // CLAUDE_CODE_OAUTH_TOKEN to the same file), so naively overwriting it
    // wipes other writers' lines. We do the merge directly from this
    // function instead of via writeFile(content) — see Step 7 of applyFiles
    // in runtime.js. Returning a sentinel signals "applyFiles, please call
    // mergeShellEnv() instead of writeFile()".
    return { __mergeShellEnv: true, fields: spec.fields || [], plain };
  }

  if (spec.format === 'storage-state') {
    // Playwright `storageState` JSON — written verbatim from a string field
    // that was already filtered + validated by store.activate (via
    // storage-state.js processStorageStateField). We re-validate the
    // parsed shape here as defence in depth: a future store-layer
    // corruption that produced malformed JSON should yield "no file
    // written" (and the MCP refuses with "session not connected"),
    // never a half-broken state.json on disk that Playwright then tries
    // to load and crashes on.
    const v = plain[spec.fromField];
    if (typeof v !== 'string' || !v.trim()) return null;
    try {
      const parsed = JSON.parse(v);
      if (!parsed || !Array.isArray(parsed.cookies)) {
        process.stderr.write('[integrations-runtime] storage-state: stored value missing cookies[] — skipping\n');
        return null;
      }
    } catch (err) {
      process.stderr.write(`[integrations-runtime] storage-state: invalid JSON in store (${err.message}) — skipping\n`);
      return null;
    }
    return v;
  }

  if (spec.format === 'email-accounts') {
    // `plain` is an array of per-account decrypted records when multi=true,
    // otherwise a single object — normalise.
    const items = Array.isArray(plain) ? plain : [plain];
    const accounts = [];
    const presets = {
      gmail:    { host: 'imap.gmail.com', port: 993, secure: true },
      zoho:     { host: 'imap.zoho.eu',   port: 993, secure: true },
      zoho_us:  { host: 'imap.zoho.com',  port: 993, secure: true },
    };
    for (const item of items) {
      const provider = (item.EMAIL_PROVIDER || 'gmail').toLowerCase();
      const preset = presets[provider];
      const host = preset?.host || (item.EMAIL_HOST || '').trim();
      const port = parseInt((item.EMAIL_PORT || (preset?.port ?? 993)).toString(), 10);
      const secure = preset ? preset.secure : true;
      if (!host || !item.EMAIL_USER || !item.EMAIL_PASS) continue;
      // Per-account toggle for outbound send. UI default is "no". When
      // false, the email-mcp's send_email / reply / forward tools refuse
      // to fire and tell the user to flip the toggle in Integrations →
      // Email if they actually want sending. Drafts (create_draft) work
      // regardless — drafts never leave the server.
      const allowSend = String(item.EMAIL_ALLOW_SEND || '').toLowerCase() === 'yes';
      accounts.push({
        id:     (item.EMAIL_ID || `account-${accounts.length + 1}`).trim(),
        host,
        port,
        secure,
        user:   item.EMAIL_USER.trim(),
        pass:   item.EMAIL_PASS,
        allow_send: allowSend,
      });
    }
    return accounts.length ? JSON.stringify(accounts, null, 2) : null;
  }

  return null;
}

/**
 * Inverse — unlink files this integration owns. Called from routes after
 * store.remove. We never touch files we didn't declare (catalog is the
 * single source of truth for ownership).
 */
export function unlinkFiles(id) {
  const cat = catalog.get(id);
  if (!cat?.mcp?.writeFiles) return;
  for (const spec of cat.mcp.writeFiles) {
    const path = resolvePath(spec.path);
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch (err) {
      process.stderr.write(`[integrations-runtime] unlink ${path}: ${err.message}\n`);
    }
  }
}

/**
 * Restart the bot by writing the restart-signal file. bot.sh's background
 * watcher (added 2026-05-31) polls the file's mtime every 2s and, on change,
 * kills the tmux session — which makes bot.sh's monitor loop exit and PM2
 * cycle the process. On startup bot.sh re-reads .credentials.json,
 * integrations.env, and .claude.json, so any changes wsapi wrote before
 * writing the signal are picked up by the new session.
 *
 * Why writeFileSync, not utimesSync: utime() (POSIX) requires file ownership
 * (or CAP_FOWNER / root) — group rw isn't enough. wsapi runs as uid 1001 but
 * the signal file is owned by bot (uid 1003), so utimesSync hits EPERM on
 * every call and the signal silently never fires. write() only needs the
 * group write permission that mode 0660 already grants, and bumps mtime
 * as a side effect. We write a Unix timestamp purely for observability —
 * the watcher only reads mtime, the body is ignored. Caught 2026-05-31
 * after the first deploy of this mechanism: encrypted store updated, on-
 * disk creds updated, but utimesSync EPERM → no restart → bot kept running
 * with stale token, web chat worked, Telegram returned 401.
 *
 * Previous mechanism (Telegram `/restart`) required the running bot to have
 * valid TG creds matching the chat we sent to. That broke for every case
 * that actually mattered: fresh TG activation (no plugin loaded yet),
 * token rotation (bot polls old token after Remove→Activate window), and
 * setup-token changes when TG wasn't configured at all. The file signal
 * has zero dependency on integration state.
 *
 * Why not `pm2 restart $BOT`: post-Phase-3, wsapi runs as uid 1001 and coder
 * (PM2 owner) runs as 1000. Each user has its own PM2 daemon socket (mode
 * 0600) — wsapi cannot reach coder's. The signal file uses the existing
 * `botshare` group (mode 0660) the same way integrations.env does, so no
 * new privilege boundary.
 *
 * Returns true if the signal write succeeded. Returns false if the signal
 * file doesn't exist — either the bot has never started in this container
 * yet, or it's running a pre-watcher bot.sh. In that case the caller's UI
 * should surface that the restart won't take effect until the next
 * container restart.
 *
 * Fire-and-forget from the caller's perspective — the write is sync, the
 * actual bot cycle takes ~3–4s (2s watcher poll + tmux teardown +
 * PM2 restart_delay 10s, observable as ~10–15s offline window in TG).
 */
export async function restartBot() {
  const botName = (process.env.BOT_NAME || 'bot').trim();
  const signalFile = `/home/bot/.${botName}/restart-signal`;

  try {
    const { existsSync, writeFileSync } = await import('node:fs');
    if (!existsSync(signalFile)) {
      process.stderr.write(`[integrations-runtime] restartBot: ${signalFile} missing — bot.sh watcher not wired up (pre-2026-05-31 image?). Bot must be cycled via container restart for changes to take effect.\n`);
      return false;
    }
    writeFileSync(signalFile, `${Date.now()}\n`);
    return true;
  } catch (err) {
    process.stderr.write(`[integrations-runtime] restartBot: write ${signalFile} failed: ${err.message}\n`);
    return false;
  }
}

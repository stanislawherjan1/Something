/**
 * Runtime config + visibility rules for the workspace API.
 *
 * Three visibility tiers for paths under PROJECT_DIR:
 *   HARD_HIDDEN  — never listed or readable. Credentials. Even an explicit
 *                  ?include_hidden=true won't surface these.
 *   SOFT_HIDDEN  — technical/build dirs (node_modules, .git, dist…). Hidden
 *                  by default; shown when the UI requests include_hidden.
 *   VISIBLE_DOT  — dot-prefixed entries that are always visible (currently
 *                  just `.claude`, which the sidebar pins to its footer).
 *
 * Other dot-prefixed entries (e.g. `.chat`, `.cache_local`) are hidden by
 * default and shown only when include_hidden is true.
 */

export const PORT          = Number(process.env.WORKSPACE_API_PORT || 3001);
export const PROJECT_DIR   = process.env.PROJECT_DIR || '/home/coder/project';
export const CLAUDE_BIN    = process.env.CLAUDE_BIN  || 'claude';

// Read limits — text endpoint kept conservative to guard wsapi memory
// (every fs.readFileSync loads the whole file into RAM as a JSON
// payload). Bumped from 1 MB to 5 MB on 2026-05-17 after the bot wrote
// a 1.26 MB markdown file and the operator hit `file too large` opening
// it in the workspace. 5 MB covers ~95% of "legit big report" cases
// without making BlockNote choke on parse. Bigger files should go
// through /api/files/raw + a download UX, not the JSON read path.
export const READ_MAX_BYTES = 5 * 1024 * 1024;       // text /api/files/read
export const RAW_MAX_BYTES  = 25 * 1024 * 1024;      // binary /api/files/raw

export const HARD_HIDDEN = new Set([
  '.email', '.google', '.env', '.env.local', '.gitignore-private',
  // Encrypted integration credentials + audit log. Never visible via the
  // file API, even with ?include_hidden=true. Defence in depth — even
  // ciphertext shouldn't be exfiltratable through the file viewer.
  '.integrations',
  // Phase-2 migration left the old PROJECT_DIR/.integrations renamed
  // to .integrations.migrated.bak as a belt-and-braces recovery copy
  // (so an empty wsapi-store volume can be re-seeded). The credentials
  // file inside stays AES-encrypted, but the bak path was never added
  // to HARD_HIDDEN — the audit.log next to it leaks plaintext
  // metadata (which integrations were activated, when, which field
  // names). Hide it now. Once the wsapi-store volume is known-good on
  // a client, the bak directory should be `rm -rf`'d outright; this
  // entry is the file-API safety net until that cleanup happens.
  '.integrations.migrated.bak',
  // Team whitelist + audit log. Managed exclusively through /api/team.
  '.allowed-emails.json',
  '.allowed-emails.audit.log',
  // Branding metadata + uploaded avatar. Managed via /api/branding.
  '.branding.json',
  '.branding',
  // Platform metadata + encrypted Claude OAuth token + audit log of setup
  // operations. Managed via /api/setup.
  '.platform.json',
  '.platform.token.enc',
  '.platform.audit.log',
  // Chat session metadata + thread transcripts. Internally managed by
  // lib/sessions.js / lib/chatHistory.js; never reachable through the
  // file API (would expose pasted secrets / multi-user transcripts).
  '.chat',
]);

// Per-bot working directory. Each deploy has a folder at PROJECT_DIR root
// named after the bot (capitalised: e.g. Bot/) where the
// assistant keeps its operational notes, generated artifacts, etc. From a
// user perspective this is a technical folder — they shouldn't see it in
// the tree by default. Names derived from process.env.BOT_NAME so it works
// for any client without code changes; we add a few casing variants to be
// resilient to filesystem casing conventions.
const BOT_NAME_RAW = (process.env.BOT_NAME || '').trim();
const botFolderVariants = (() => {
  if (!BOT_NAME_RAW) return [];
  const lower = BOT_NAME_RAW.toLowerCase();
  const capitalised = lower.charAt(0).toUpperCase() + lower.slice(1);
  const upper = lower.toUpperCase();
  return [BOT_NAME_RAW, lower, capitalised, upper];
})();

export const SOFT_HIDDEN = new Set([
  'node_modules', 'dist', 'build',
  '.git', '.cache', '.DS_Store', '.npm', '.bun', '.pm2',
  // .claude is technical too — it's surfaced via the dedicated Configuration
  // dashboard in the workspace UI, not as a raw folder in the file tree.
  '.claude',
  // Chat uploads live here; users see them as bubble chips, not as files.
  '.attachments',
  // Per-bot working directory (named after BOT_NAME) — see comment above.
  ...botFolderVariants,
  // Memory wiki — surfaced via the dedicated Memory dashboard in AI
  // Settings, not as raw markdown in the file tree. Editing the cards
  // directly is allowed (they're plain markdown) but the sidebar would
  // clutter user navigation since end-users aren't expected to hand-edit.
  'memory',
]);

export const VISIBLE_DOT = new Set([]);

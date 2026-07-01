/**
 * Branding store.
 *
 * Layout:
 *   PROJECT_DIR/.branding.json   — { title, botName, hideIdeText, updatedAt, updatedBy }
 *   PROJECT_DIR/branding/bot.png — avatar (publicly served via nginx alias)
 *
 * Resolves the active branding by merging:
 *   1. .branding.json values (highest priority, set by the user via the
 *      workspace UI).
 *   2. Environment variables (VITE_APP_TITLE, BOT_NAME, VITE_HIDE_IDE_TEXT)
 *      — the build-time defaults that the deploy wrapper baked in.
 *   3. Hardcoded fallbacks ("Workspace", "assistant", false).
 *
 * The avatar URL the API returns has a cache-bust query if the file exists
 * (mtime), so the client picks up the new image without a hard refresh.
 *
 * No secrets are stored here — the Claude OAuth token (added in phase 5)
 * lives in the encrypted integrations store.
 */

import {
  mkdirSync, readFileSync, writeFileSync, renameSync, existsSync,
  statSync, chmodSync, copyFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_DIR, CLAUDE_BIN } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRESET_DIR = join(__dirname, '..', 'assets', 'avatars');
const PRESET_RE = /^[0-9]{2}-[a-z]+$/;

const FILE        = join(PROJECT_DIR, '.branding.json');
const TMP         = join(PROJECT_DIR, '.branding.json.tmp');
const AVATAR_DIR  = join(PROJECT_DIR, '.branding');
const AVATAR_FILE = join(AVATAR_DIR, 'bot.png');
const LOGO_DIR    = AVATAR_DIR;     // same folder; just two files in it
const LOGO_FILE   = join(LOGO_DIR, 'logo.png');

export function avatarPath() {
  return AVATAR_FILE;
}

export function hasAvatar() {
  return existsSync(AVATAR_FILE);
}

export function logoPath() {
  return LOGO_FILE;
}

export function hasLogo() {
  return existsSync(LOGO_FILE);
}

const DEFAULTS = {
  title:        'Workspace',
  botName:      'assistant',
  hideIdeText:  false,
};

function readRaw() {
  try { mkdirSync(PROJECT_DIR, { recursive: true }); } catch {}
  if (!existsSync(FILE)) return {};
  try {
    const raw = readFileSync(FILE, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    process.stderr.write(`[branding] read failed: ${err.message}\n`);
    return {};
  }
}

function writeRaw(state) {
  try { mkdirSync(PROJECT_DIR, { recursive: true }); } catch {}
  writeFileSync(TMP, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { chmodSync(TMP, 0o600); } catch {}
  renameSync(TMP, FILE);
  try { chmodSync(FILE, 0o600); } catch {}
}

function envDefaults() {
  // VITE_APP_TITLE is build-baked; expose under both names for back-compat.
  const rawTitle = process.env.VITE_APP_TITLE || process.env.IDE_TITLE || '';
  const title    = rawTitle.replace(/\s*(?:IDE|Workspace)\s*$/i, '').trim();
  const botName  = (process.env.BOT_NAME || process.env.VITE_BOT_NAME || '').trim();
  const hideIdeText =
    String(process.env.VITE_HIDE_IDE_TEXT || '').toLowerCase() === 'true';
  return { title, botName, hideIdeText };
}

function avatarMtime() {
  try {
    if (!existsSync(AVATAR_FILE)) return null;
    return Math.floor(statSync(AVATAR_FILE).mtimeMs);
  } catch {
    return null;
  }
}

function logoMtime() {
  try {
    if (!existsSync(LOGO_FILE)) return null;
    return Math.floor(statSync(LOGO_FILE).mtimeMs);
  } catch {
    return null;
  }
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Legacy mode — when LEGACY_CONFIG=true, branding fields default from per-
 * client `.env` (BOT_NAME, VITE_APP_TITLE) + `overrides/public/*.png`. This
 * gives operators their familiar env-driven baseline.
 *
 * UI edits ARE allowed in legacy mode. `.branding.json` (the file) wins
 * over env when both are set — same precedence as non-legacy mode. The
 * `legacyMode: true` flag is exposed so the frontend can show an
 * informational banner ("you can edit here, but env defaults still apply
 * on a fresh container until you save once"), not to disable editing.
 *
 * Why bother with the flag at all: it tells the UI which values are
 * env-derived (and would survive a reset of `.branding.json`) vs file-
 * derived. Useful diagnostic, no longer a hard lock.
 *
 * Why a flag (rather than auto-detect): legacy clients
 * have BOT_NAME + VITE_APP_TITLE in env from the pre-wizard era and have
 * always been managed that way — surfacing edit UI for them would create a
 * second source of truth that drifts from the operator's `.env`. New clients
 * default to false (= edit-from-UI is the way).
 */
export function isLegacyMode() {
  return String(process.env.LEGACY_CONFIG || '').toLowerCase() === 'true';
}

/** Resolve the effective branding.
 *
 * Source order:
 *   - Legacy mode (LEGACY_CONFIG=true): file → env → defaults.
 *     Operator pre-parameterised .env, the UI is read-only, env values are
 *     the authoritative branding.
 *   - Non-legacy: file → defaults. Env is IGNORED for branding fields.
 *     The new-client flow expects every branding field to be entered through
 *     the wizard (Step 1: title + logo, Step 2: bot name + avatar, …). If
 *     env values fed back through here, the wizard would silently skip
 *     steps the operator never wanted to pre-fill.
 *
 * BOT_NAME / VITE_APP_TITLE in non-legacy `.env` are still used elsewhere
 * (Docker volume paths, tmux session, build-time browser tab title), but
 * NOT as branding source.
 */
export function resolve() {
  const file   = readRaw();
  const useEnv = isLegacyMode();
  const env    = useEnv ? envDefaults() : { title: '', botName: '', hideIdeText: undefined };
  const title       = (file.title       ?? env.title)       || DEFAULTS.title;
  const botName     = (file.botName     ?? env.botName)     || DEFAULTS.botName;
  const hideIdeText = (typeof file.hideIdeText === 'boolean')
    ? file.hideIdeText
    : (typeof env.hideIdeText === 'boolean' ? env.hideIdeText : DEFAULTS.hideIdeText);

  const mt = avatarMtime();
  // Avatar URL precedence:
  //   1. runtime upload (`PROJECT_DIR/.branding/bot.png`) → /api/branding/avatar
  //   2. build-time per-client override (clients/<x>/overrides/public/bot.png
  //      → frontend/public/bot.png) → /bot.png
  //   3. nothing — frontend's <img onError> swaps to /workspace-logo.svg
  // Backend can't distinguish 2 vs 3 (it doesn't see the SPA build), so we
  // always return /bot.png as the static fallback URL. Same for logo+icon.
  const botAvatarUrl = mt ? `/api/branding/avatar?v=${mt}` : '/bot.png';

  const lmt = logoMtime();
  const logoUrl = lmt ? `/api/branding/logo?v=${lmt}` : '/logo.png';
  const iconUrl = lmt ? `/api/branding/logo?v=${lmt}` : '/icon.png';

  return {
    title,
    botName,                   // lowercase canonical
    botDisplayName: capitalize(botName),  // for UI rendering
    hideIdeText,
    botAvatarUrl,
    logoUrl,
    iconUrl,
    legacyMode: isLegacyMode(),
    source: {
      title:       file.title       != null ? 'file' : (env.title ? 'env' : 'default'),
      botName:     file.botName     != null ? 'file' : (env.botName ? 'env' : 'default'),
      hideIdeText: typeof file.hideIdeText === 'boolean' ? 'file' : 'env',
      avatar:      mt ? 'file' : 'default',
      logo:        lmt ? 'file' : 'default',
    },
    updatedAt: file.updatedAt || null,
    updatedBy: file.updatedBy || null,
  };
}

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9 _-]{0,30}$/;

const PERSONALITY_KEYS = ['warmth', 'brevity', 'formality', 'proactivity', 'humor'];

function sanitizePersonality(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const k of PERSONALITY_KEYS) {
    const v = input[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[k] = Math.max(0, Math.min(100, Math.round(v)));
  }
  return Object.keys(out).length ? out : null;
}

export function update({ title, botName, hideIdeText, backstory, personality, actor }) {
  // The bootstrap path (entrypoint.sh seeding .branding.json from env) is
  // allowed in legacy mode — it doesn't go through update(). Anything that
  // calls update() is by definition a UI / API mutation and gets blocked.

  const file = readRaw();
  const oldName = file.botName;
  let dirty = false;
  let nameChanged    = false;
  let contentChanged = false;

  if (typeof title === 'string') {
    const t = title.trim();
    if (t.length === 0 || t.length > 80) {
      throw new Error('Title must be 1–80 characters.');
    }
    file.title = t;
    dirty = true;
  }
  if (typeof botName === 'string') {
    const b = botName.trim();
    if (!NAME_RE.test(b)) {
      throw new Error('Bot name must start with a letter and contain only letters, digits, spaces, dashes, or underscores (max 31 chars).');
    }
    if (file.botName !== b) nameChanged = true;
    file.botName = b;
    dirty = true;
  }
  if (typeof hideIdeText === 'boolean') {
    file.hideIdeText = hideIdeText;
    dirty = true;
  }
  if (typeof backstory === 'string') {
    const s = backstory.trim();
    if (s.length > 2000) throw new Error('Backstory must be ≤ 2000 characters.');
    if (s.length === 0) {
      delete file.backstory;
    } else {
      file.backstory = s;
    }
    dirty = true;
    contentChanged = true;
  }
  if (personality !== undefined) {
    const cleaned = sanitizePersonality(personality);
    if (cleaned) {
      file.personality = cleaned;
      dirty = true;
      contentChanged = true;
    }
  }
  if (!dirty) return resolve();

  file.updatedAt = new Date().toISOString();
  if (actor) file.updatedBy = String(actor).trim().toLowerCase();
  writeRaw(file);

  // Strategy:
  //   - If only the bot name changed and an existing CLAUDE.md is on disk,
  //     ask Claude to rename in-place. Preserves any manual edits the user
  //     made via the Instructions modal.
  //   - Otherwise (backstory/personality changed, or no file yet) regenerate
  //     the whole file from scratch — that's the fast, deterministic path.
  if (nameChanged && !contentChanged && oldName && oldName !== file.botName && existsSync(CLAUDE_MD)) {
    renameInClaudeMdAsync(oldName, file.botName);
  } else {
    synthesizeClaudeMd();
  }
  return resolve();
}

// Hard ceiling on the rename subprocess. Empirically a name swap completes
// in ~5-15s; if Claude API hangs or the file is much larger than expected,
// we'd rather kill the subprocess and fall back than leak a zombie.
const RENAME_TIMEOUT_MS = 60_000;

/**
 * Fire-and-forget: spawn Claude CLI to rename the assistant in CLAUDE.md.
 * The watcher picks up the file change and the UI re-reads it. We don't
 * block the HTTP response — a rename takes ~5-15s and the user already saw
 * the new name applied to the rest of the UI.
 *
 * Subprocess is bounded by RENAME_TIMEOUT_MS — if Claude hangs (network,
 * API outage, runaway prompt), we SIGKILL it and synthesize from scratch
 * so the file ends up coherent rather than half-renamed.
 */
async function renameInClaudeMdAsync(oldName, newName) {
  if (!CLAUDE_BIN) return;

  // Dynamic import to dodge the branding↔setup circular import.
  let setup;
  try { setup = await import('./setup.js'); }
  catch (err) {
    process.stderr.write(`[branding/rename] setup import failed: ${err.message}\n`);
    synthesizeClaudeMd();
    return;
  }

  const childEnv = { ...process.env };
  if (!childEnv.CLAUDE_CODE_OAUTH_TOKEN && setup.hasClaudeToken?.()) {
    try { childEnv.CLAUDE_CODE_OAUTH_TOKEN = setup.readClaudeToken(); }
    catch (err) { process.stderr.write(`[branding] token decrypt failed: ${err.message}\n`); }
  }
  if (!childEnv.CLAUDE_CODE_OAUTH_TOKEN) {
    // No token, can't run Claude. Fall back to regenerating from scratch.
    process.stderr.write('[branding] no Claude token, falling back to synthesizeClaudeMd\n');
    synthesizeClaudeMd();
    return;
  }

  const message = [
    `Edit the file ${CLAUDE_MD}.`,
    `The assistant has been renamed from "${oldName}" to "${newName}".`,
    `Find every reference to "${oldName}" and replace it with "${newName}".`,
    `Do NOT change anything else — keep all formatting, structure, sections, ground rules, and other content identical.`,
    `If there is an HTML comment at the top starting with "<!-- auto-generated", keep it exactly as it is.`,
    `When done, reply with a single short confirmation line.`,
  ].join(' ');

  try {
    const proc = spawn(CLAUDE_BIN, [
      '-p',
      '--dangerously-skip-permissions',
      '--output-format', 'text',
    ], {
      cwd: PROJECT_DIR,
      env: childEnv,
      stdio: ['pipe', 'ignore', 'pipe'],
      detached: false,
    });

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      process.stderr.write(`[branding/rename] timeout after ${RENAME_TIMEOUT_MS}ms — killing claude\n`);
      try { proc.kill('SIGKILL'); } catch {}
    }, RENAME_TIMEOUT_MS);

    proc.stdin.write(message);
    proc.stdin.end();

    proc.stderr.on('data', (chunk) => {
      process.stderr.write(`[branding/rename] ${chunk.toString('utf8')}`);
    });
    proc.on('error', (err) => {
      clearTimeout(killTimer);
      process.stderr.write(`[branding/rename] spawn failed: ${err.message}\n`);
    });
    proc.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (timedOut || signal === 'SIGKILL') {
        // Killed mid-edit — the file may now be inconsistent. Synthesize
        // from scratch so we end up with a deterministic, valid CLAUDE.md.
        process.stderr.write(`[branding/rename] killed; falling back to synthesizeClaudeMd\n`);
        try { synthesizeClaudeMd(); } catch (err) {
          process.stderr.write(`[branding/rename] fallback synth failed: ${err.message}\n`);
        }
      } else if (code !== 0) {
        process.stderr.write(`[branding/rename] claude exited ${code}\n`);
      } else {
        process.stdout.write(`[branding/rename] ${oldName} → ${newName} OK\n`);
      }
    });
  } catch (err) {
    process.stderr.write(`[branding/rename] failed: ${err.message}\n`);
  }
}

/**
 * Read the raw stored fields (so callers like setup.js can synthesize a
 * CLAUDE.md from name + backstory + personality without re-parsing). Does
 * NOT include env fallbacks — only what the user explicitly saved.
 */
export function readStored() {
  return readRaw();
}

const CLAUDE_MD = join(PROJECT_DIR, '.claude', 'CLAUDE.md');
const CLAUDE_MD_TMP = join(PROJECT_DIR, '.claude', 'CLAUDE.md.tmp');

// LOGO_DIR + LOGO_FILE are declared at the top of the file alongside AVATAR_*.

export function saveLogo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Empty upload.');
  if (buffer.length > AVATAR_MAX_BYTES) throw new Error('Logo must be smaller than 2 MiB.');
  const isPng  = buffer.length >= 8 && buffer.slice(0, 8).equals(PNG_MAGIC);
  const isJpeg = buffer.length >= 3 && buffer.slice(0, 3).equals(JPEG_MAGIC);
  if (!isPng && !isJpeg) throw new Error('Logo must be a PNG or JPEG image.');
  mkdirSync(LOGO_DIR, { recursive: true });
  const tmp = `${LOGO_FILE}.tmp`;
  writeFileSync(tmp, buffer, { mode: 0o644 });
  try { chmodSync(tmp, 0o644); } catch {}
  renameSync(tmp, LOGO_FILE);
  try { chmodSync(LOGO_FILE, 0o644); } catch {}
}

export function applyPresetAvatar(presetId) {
  const n = parseInt(presetId, 10);
  if (!Number.isInteger(n) || n < 1 || n > 16) {
    throw new Error('Invalid preset ID — must be 1–16.');
  }
  const src = join(PRESET_DIR, `${n}.png`);
  if (!existsSync(src)) throw new Error(`Preset ${n} not found.`);
  mkdirSync(AVATAR_DIR, { recursive: true });
  const tmp = `${AVATAR_FILE}.tmp`;
  copyFileSync(src, tmp);
  try { chmodSync(tmp, 0o644); } catch {}
  renameSync(tmp, AVATAR_FILE);
  try { chmodSync(AVATAR_FILE, 0o644); } catch {}
  return resolve();
}

const PERSONALITY_INSTRUCTIONS = {
  warmth: [
    [0,  39, 'Keep a professional distance. Skip pleasantries and small talk — get straight to the point.'],
    [40, 69, 'Be friendly but focused. A collegial tone is fine; avoid over-warming.'],
    [70, 100,'Be warm and genuinely personable. Show real interest in the person, not just the task.'],
  ],
  brevity: [
    [0,  39, 'Go deep. Thorough, detailed answers are expected — the user values depth over speed.'],
    [40, 69, 'Cover what matters, cut the rest. One well-structured answer beats three loose ones.'],
    [70, 100,'Be terse. Say it in a sentence if you can. Offer to go deeper rather than dumping everything upfront.'],
  ],
  formality: [
    [0,  39, 'Keep it casual. Contractions, first names, relaxed phrasing — this is a conversation, not a report.'],
    [40, 69, 'Match the register of whoever you\'re talking to. Adapt as the conversation shifts.'],
    [70, 100,'Stay formal. Full sentences, no contractions, precise vocabulary. Boardroom tone throughout.'],
  ],
  proactivity: [
    [0,  39, 'Answer what\'s asked, nothing more. Don\'t volunteer opinions or next steps unless asked.'],
    [40, 69, 'Surface ideas when they\'re clearly relevant, otherwise stay reactive.'],
    [70, 100,'Be proactive. Flag risks before they\'re raised, suggest next steps, notice what the user hasn\'t asked yet.'],
  ],
  humor: [
    [0,  39, 'Stay dry and precise. No jokes, no banter — wit is a distraction here.'],
    [40, 69, 'A light touch of wit is welcome when the moment calls for it. Don\'t force it.'],
    [70, 100,'Be playful. Banter is fine, a well-timed joke lands well. Keep it smart, never cringe.'],
  ],
};

function axisInstruction(key, value) {
  const bands = PERSONALITY_INSTRUCTIONS[key];
  if (!bands) return null;
  for (const [lo, hi, desc] of bands) {
    if (value >= lo && value <= hi) return desc;
  }
  return null;
}

// Marker line at the top of every auto-generated CLAUDE.md. If the file
// exists but doesn't start with this marker, the user has hand-edited it
// and a regenerate would silently destroy their changes. We log a loud
// warning in that case but still proceed — the wizard explicitly opted into
// regeneration by changing backstory/personality, and refusing to write
// would leave the user with no way to update those fields. Operator can
// recover the old file from `.claude/CLAUDE.md.preserved` written below.
const AUTOGEN_MARKER = '<!-- auto-generated by workspace-api/branding — edits here are overwritten on the next branding/personality save -->';

function isAutoGenerated(content) {
  if (!content) return true;
  // Tolerate leading whitespace + BOM. Marker sits at the very top.
  return content.replace(/^﻿/, '').trimStart().startsWith(AUTOGEN_MARKER);
}

export function synthesizeClaudeMd() {
  const stored = readRaw();
  const resolved = resolve();
  const name = resolved.botDisplayName || 'Assistant';
  const lines = [];

  // Preserve hand-edited content before we overwrite. Surfaces in PM2 logs
  // so the operator can grep + diff if a save was unintended.
  if (existsSync(CLAUDE_MD)) {
    try {
      const current = readFileSync(CLAUDE_MD, 'utf8');
      if (!isAutoGenerated(current)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const preserved = join(PROJECT_DIR, '.claude', `CLAUDE.md.preserved.${stamp}`);
        try {
          writeFileSync(preserved, current, { mode: 0o644 });
          process.stderr.write(
            `[branding] CLAUDE.md had custom edits — saved a copy at ${preserved} before regenerating.\n`
          );
        } catch (err) {
          process.stderr.write(`[branding] failed to preserve custom CLAUDE.md: ${err.message}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[branding] CLAUDE.md preservation read failed: ${err.message}\n`);
    }
  }

  lines.push(AUTOGEN_MARKER);
  lines.push('');
  lines.push(`# ${name}`);
  lines.push('');

  // Identity / backstory
  if (stored.backstory) {
    lines.push('## Role');
    lines.push('');
    lines.push(stored.backstory.trim());
    lines.push('');
  } else {
    lines.push('## Role');
    lines.push('');
    lines.push(`You are ${name}, the AI assistant for the **${resolved.title}** workspace.`);
    lines.push('Your job is to be genuinely useful — help the team think, write, build, and ship.');
    lines.push('');
  }

  // Ground rules derived from personality sliders
  const p = stored.personality;
  if (p && typeof p === 'object' && Object.keys(p).length > 0) {
    lines.push('## Ground Rules');
    lines.push('');
    lines.push('- **Talk like a coworker, not a system.** Keep internal mechanism — skill names, file paths, tools, ids — out of replies unless the user asks how you did it. Say the outcome, not the plumbing.');
    for (const key of ['warmth', 'brevity', 'formality', 'proactivity', 'humor']) {
      if (typeof p[key] === 'number') {
        const instruction = axisInstruction(key, p[key]);
        if (instruction) lines.push(`- **${key.charAt(0).toUpperCase() + key.slice(1)}:** ${instruction}`);
      }
    }
    lines.push('');
  } else {
    lines.push('## Ground Rules');
    lines.push('');
    lines.push('- **Talk like a coworker, not a system.** Keep internal mechanism — skill names, file paths, tools, ids — out of replies unless the user asks how you did it. Say the outcome, not the plumbing.');
    lines.push('- **Be direct.** Skip preamble. Get to the point.');
    lines.push('- **Don\'t over-format.** Use headers and bullets only when the content actually needs structure.');
    lines.push('- **Be concise.** Offer to go deeper rather than dumping everything upfront.');
    lines.push('');
  }

  // Workspace context
  lines.push('## Workspace');
  lines.push('');
  lines.push(`You are working inside the **${resolved.title}** workspace environment.`);
  lines.push('You have access to the project files, a terminal, and the full chat history.');
  lines.push('This is a real working environment — act accordingly.');
  lines.push('');

  // File handling
  lines.push('## Files');
  lines.push('');
  lines.push('Never rename existing files or folders unless explicitly asked.');
  lines.push('When saving notes or summaries, always write to a `.md` file — never paste into chat only.');
  lines.push('Always tell the user where you saved something.');
  lines.push('');

  // Reference to UI docs
  lines.push('## UI Reference');
  lines.push('');
  lines.push('See `.claude/WORKSPACE.md` for a full description of the workspace UI — sidebar, editor pane, chat panel, AI Settings, Skills, Integrations, and key file locations.');
  lines.push('Use it when a user reports a UI problem or asks about a specific feature.');

  const content = lines.join('\n');

  try {
    mkdirSync(join(PROJECT_DIR, '.claude'), { recursive: true });
    writeFileSync(CLAUDE_MD_TMP, content, { mode: 0o644 });
    try { chmodSync(CLAUDE_MD_TMP, 0o644); } catch {}
    renameSync(CLAUDE_MD_TMP, CLAUDE_MD);
    try { chmodSync(CLAUDE_MD, 0o644); } catch {}
  } catch (err) {
    process.stderr.write(`[branding] CLAUDE.md write failed: ${err.message}\n`);
  }
}

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;   // 2 MiB
const PNG_MAGIC  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

export function saveAvatar(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Empty upload.');
  }
  if (buffer.length > AVATAR_MAX_BYTES) {
    throw new Error('Avatar must be smaller than 2 MiB.');
  }

  const isPng  = buffer.length >= 8 && buffer.slice(0, 8).equals(PNG_MAGIC);
  const isJpeg = buffer.length >= 3 && buffer.slice(0, 3).equals(JPEG_MAGIC);
  if (!isPng && !isJpeg) {
    throw new Error('Avatar must be a PNG or JPEG image.');
  }

  mkdirSync(AVATAR_DIR, { recursive: true });
  const tmp = `${AVATAR_FILE}.tmp`;
  // Mode 0644 — this file is publicly served via nginx alias.
  writeFileSync(tmp, buffer, { mode: 0o644 });
  try { chmodSync(tmp, 0o644); } catch {}
  renameSync(tmp, AVATAR_FILE);
  try { chmodSync(AVATAR_FILE, 0o644); } catch {}
  return resolve();
}

/**
 * Email whitelist resolver.
 *
 * Source of truth (in order of precedence):
 *   1. PROJECT_DIR/.allowed-emails.json — file-based, managed via the
 *      workspace's Team dashboard. JSON array of { email, role, ... }.
 *   2. IDE_ALLOWED_EMAILS env var — legacy fallback. Comma-separated.
 *
 * The file path is `${PROJECT_DIR}/.allowed-emails.json` (PROJECT_DIR is
 * bind-mounted read-only into auth-service via docker-compose). We cache the
 * parsed result for 30 s so we don't read the disk on every auth_request,
 * while still picking up admin-made changes within a sane window.
 *
 * Returns:
 *   isAllowed(email)  → boolean
 *   roleOf(email)     → 'admin' | 'member' | null
 */

const fs   = require('fs');
const path = require('path');

const PROJECT_DIR = process.env.PROJECT_DIR || '/home/coder/project';
const FILE        = path.join(PROJECT_DIR, '.allowed-emails.json');
const TTL_MS      = 30_000;

const ENV_FALLBACK = new Set(
    (process.env.IDE_ALLOWED_EMAILS || '')
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean)
);

let cache = { ts: 0, byEmail: null };

function readFile() {
    try {
        if (!fs.existsSync(FILE)) return null;
        const raw = fs.readFileSync(FILE, 'utf8');
        if (!raw.trim()) return null;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        const map = new Map();
        for (const e of parsed) {
            const email = String(e?.email || '').trim().toLowerCase();
            if (!email) continue;
            const role = e?.role === 'admin' ? 'admin' : 'member';
            map.set(email, role);
        }
        return map;
    } catch (err) {
        console.warn('[whitelist] file read failed:', err.message);
        return null;
    }
}

function get() {
    const now = Date.now();
    if (cache.byEmail && now - cache.ts < TTL_MS) return cache.byEmail;

    const fromFile = readFile();
    if (fromFile && fromFile.size > 0) {
        cache = { ts: now, byEmail: fromFile };
        return fromFile;
    }

    // Env fallback — every entry treated as 'admin' so the bootstrap user
    // (typically the only person on a fresh deploy) can manage the team
    // before .allowed-emails.json exists.
    const envMap = new Map();
    for (const email of ENV_FALLBACK) envMap.set(email, 'admin');
    cache = { ts: now, byEmail: envMap };
    return envMap;
}

function isAllowed(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!e) return false;
    return get().has(e);
}

function roleOf(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!e) return null;
    return get().get(e) || null;
}

function size() {
    return get().size;
}

function source() {
    // For the startup log line — does the live whitelist come from the file
    // or from the legacy env? Useful when debugging "why can/can't I log in".
    const fromFile = readFile();
    if (fromFile && fromFile.size > 0) return 'file';
    if (ENV_FALLBACK.size > 0) return 'env';
    return 'empty';
}

module.exports = { isAllowed, roleOf, size, source };

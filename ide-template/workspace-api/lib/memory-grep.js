/**
 * memory-grep — ripgrep wrapper for the `memory_grep` agent tool (P1).
 *
 * Cheap deterministic lookup over `<PROJECT_DIR>/memory/`. The agent reads
 * INDEX on session start (now in the cached prefix), then needs a way to
 * find specific facts without `Read`-ing a whole topic page. This module
 * shells out to ripgrep and returns line-level snippets in a shape that
 * mirrors Anthropic's memory-tool `view` ergonomics: file + line + snippet.
 *
 * Why ripgrep and not native JS:
 *   - rg already lives in the workspace image (used by file-search elsewhere)
 *   - At ~30 files in memory/ the JS-side string search would also be fine,
 *     but rg's regex engine + Unicode handling is more correct.
 *   - If rg is missing in dev (rare), `grepMemory` falls back to a pure-
 *     Node line scan so tests + local dev work without a system binary.
 *
 * The result shape is deliberately small (file, line, snippet) so the
 * agent gets cheap "is X mentioned" answers without paging in whole files.
 * Caller can `Read` the matching file when it wants the surrounding context.
 *
 * Security:
 *   - The query is passed as a literal regex by default (--fixed-strings).
 *     Set `regex: true` only for known-safe agent-authored queries.
 *   - The search root is forced to PROJECT_DIR/memory/ — there's no escape
 *     hatch for arbitrary paths. The agent cannot grep outside memory/.
 *   - File results report paths relative to PROJECT_DIR for portability.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PROJECT_DIR } from './config.js';

const DEFAULT_MAX_COUNT = 10;
const DEFAULT_MAX_FILESIZE = '1M';
const DEFAULT_CONTEXT = 0;
const RG_BIN = process.env.RG_BIN || 'rg';
const MAX_QUERY_LEN = 256;

function memoryRoot() {
  return join(process.env.PROJECT_DIR || PROJECT_DIR, 'memory');
}

/**
 * Search memory/ for `query`. Returns `[{ file, line, snippet }]`.
 *
 * @param {string} query — literal text by default; regex when `opts.regex`.
 * @param {object} [opts]
 * @param {number} [opts.maxCount=10]         — max matches per file
 * @param {string} [opts.maxFilesize='1M']    — passed to rg as --max-filesize
 * @param {boolean} [opts.regex=false]        — true: regex; false: --fixed-strings
 * @param {boolean} [opts.ignoreCase=true]    — case-insensitive matching
 * @param {number}  [opts.totalLimit=80]      — cap the response list size
 * @param {number}  [opts.timeoutMs=3000]     — rg wall-clock cap
 *
 * Throws on invalid query. Returns [] when memory/ is missing.
 */
export async function grepMemory(query, opts = {}) {
  if (typeof query !== 'string' || query.length === 0) {
    throw new Error('grepMemory: query is required');
  }
  if (query.length > MAX_QUERY_LEN) {
    throw new Error(`grepMemory: query too long (${query.length} > ${MAX_QUERY_LEN})`);
  }
  const root = memoryRoot();
  if (!existsSync(root)) return [];

  const maxCount    = Number(opts.maxCount ?? DEFAULT_MAX_COUNT);
  const maxFilesize = opts.maxFilesize ?? DEFAULT_MAX_FILESIZE;
  const ignoreCase  = opts.ignoreCase !== false;
  const regex       = !!opts.regex;
  const totalLimit  = Number(opts.totalLimit ?? 80);
  const timeoutMs   = Number(opts.timeoutMs ?? 3000);

  try {
    const results = await runRipgrep({ query, root, maxCount, maxFilesize, ignoreCase, regex, timeoutMs });
    return results.slice(0, totalLimit);
  } catch (err) {
    // rg missing or transient failure → fall back to pure-Node line scan.
    // The fallback is slower + less correct but keeps the tool functional
    // in dev environments without rg installed.
    process.stderr.write(`[memory-grep] rg unavailable (${err.message}); using JS fallback\n`);
    return jsGrepFallback({ query, root, maxCount, ignoreCase, regex, totalLimit });
  }
}

function runRipgrep({ query, root, maxCount, maxFilesize, ignoreCase, regex, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = [
      '--json',
      '--max-count', String(maxCount),
      '--max-filesize', String(maxFilesize),
      '--no-heading',
      '--with-filename',
      '--line-number',
      '--type', 'md',
      // Team mode: never grep INTO a user's private memory (memory/users/<slug>/).
      // memory_grep is an MCP tool — it bypasses the file-path scope-guard hook —
      // so a member (or the dashboard search) must not be able to surface another
      // teammate's private cards. Shared memory only; a user's own private memory
      // is in their cached prefix + reachable via Read.
      '--glob', '!users/**',
    ];
    if (!regex) args.push('--fixed-strings');
    if (ignoreCase) args.push('--ignore-case');
    args.push('--', query, root);

    const proc = spawn(RG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      settle(reject, new Error(`rg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });

    proc.on('error', (err) => {
      clearTimeout(timer);
      settle(reject, new Error(`rg spawn failed: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      // rg exits 1 when there are zero matches — that's not an error.
      if (code !== 0 && code !== 1) {
        return settle(reject, new Error(`rg exited code=${code}${stderr ? ': ' + stderr.trim() : ''}`));
      }
      const out = [];
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.type !== 'match') continue;
        const data = evt.data || {};
        const filePath = data.path?.text;
        const lineNo   = data.line_number;
        const text     = data.lines?.text;
        if (!filePath || !lineNo || typeof text !== 'string') continue;
        out.push({
          file: relative(process.env.PROJECT_DIR || PROJECT_DIR, filePath),
          line: lineNo,
          snippet: text.replace(/\n$/, '').slice(0, 240),
        });
      }
      settle(resolve, out);
    });
  });
}

/**
 * Pure-Node fallback. Walks `memory/` recursively, scans .md files line by
 * line. Slower than rg, no regex compilation; fine for the small memory/
 * trees the workspace deals with (≤ ~30 files) and the small handful of dev
 * environments without ripgrep installed.
 */
function jsGrepFallback({ query, root, maxCount, ignoreCase, regex, totalLimit }) {
  const out = [];
  let matcher;
  try {
    matcher = regex ? new RegExp(query, ignoreCase ? 'i' : '') : null;
  } catch (err) {
    throw new Error(`grepMemory: invalid regex (${err.message})`);
  }
  const needleLc = ignoreCase ? query.toLowerCase() : query;

  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= totalLimit) return;
      // Skip per-user private memory (parity with the rg --glob '!users/**'
      // exclusion above) — never surface another teammate's private cards.
      if (e.isDirectory() && dir === root && e.name === 'users') continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
      try {
        const st = statSync(abs);
        if (st.size > 1 * 1024 * 1024) continue;
      } catch { continue; }
      let body;
      try { body = readFileSync(abs, 'utf8'); } catch { continue; }
      const lines = body.split('\n');
      let perFile = 0;
      for (let i = 0; i < lines.length && perFile < maxCount; i++) {
        const ln = lines[i];
        let hit = false;
        if (regex) {
          hit = matcher.test(ln);
        } else {
          hit = (ignoreCase ? ln.toLowerCase() : ln).includes(needleLc);
        }
        if (hit) {
          out.push({
            file: relative(process.env.PROJECT_DIR || PROJECT_DIR, abs),
            line: i + 1,
            snippet: ln.slice(0, 240),
          });
          perFile++;
          if (out.length >= totalLimit) return;
        }
      }
    }
  }
  walk(root);
  return out;
}

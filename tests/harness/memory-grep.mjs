/**
 * Harness for kind=memory-grep. Builds a small synthetic memory/ dir with
 * known text, then runs grepMemory and asserts the result shape + content.
 *
 * Pure-Node. Uses the JS fallback path automatically when `rg` is missing,
 * so it works in every dev environment.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export default async function (input) {
  const dir = join(tmpdir(), 'sauna-eval-memory-grep-' + Date.now());
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'memory', 'topics'), { recursive: true });

  // Seed the directory with the fixtures the case requests.
  for (const f of (input.files || [])) {
    const abs = join(dir, 'memory', f.path);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, f.body, 'utf8');
  }

  process.env.PROJECT_DIR = dir;
  const mod = await import('../../ide-template/workspace-api/lib/memory-grep.js?a=' + Date.now());
  const matches = await mod.grepMemory(input.query, { maxCount: input.maxCount || 10, regex: !!input.regex });
  rmSync(dir, { recursive: true, force: true });

  return {
    count: matches.length,
    first_file:    matches[0]?.file || null,
    first_snippet_contains: input.query && matches[0]?.snippet
      ? matches[0].snippet.toLowerCase().includes(String(input.query).toLowerCase())
      : false,
  };
}

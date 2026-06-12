/**
 * Harness for kind=memory-loader-scope. Asserts that
 * buildCachedPrefix({ scope }) filters its source list by
 * scope.memory_paths and that pathMatchesMemoryPaths handles the glob
 * shapes the workspace actually uses.
 *
 * input.mode:
 *   - 'matches'        → pathMatchesMemoryPaths(file, patterns)
 *   - 'narrow-prefix'  → buildCachedPrefix with a narrowed scope; assert
 *                        which source ids stayed in scope.
 */
import { mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const TEMPLATES_DIR = join(__dirname, '..', '..', 'ide-template', 'skills', 'default', 'memory-cards', 'templates');

export default async function (input) {
  const dir = join(tmpdir(), 'sauna-eval-mls-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'memory'), { recursive: true });
  for (const f of ['AGENT_IDENTITY.md', 'AGENT_TOOLS.md', 'RULES.md', 'INDEX.md', 'USER_PROFILE.md', 'USER_PREFERENCES.md']) {
    const src = join(TEMPLATES_DIR, f);
    if (existsSync(src)) copyFileSync(src, join(dir, 'memory', f));
  }
  process.env.PROJECT_DIR = dir;

  const mod = await import('../../ide-template/workspace-api/lib/memory-loader.js?a=' + Date.now());

  if (input.mode === 'matches') {
    const r = mod.pathMatchesMemoryPaths(input.file, input.patterns);
    rmSync(dir, { recursive: true, force: true });
    return { matched: r };
  }

  if (input.mode === 'narrow-prefix') {
    const r = mod.buildCachedPrefix({ scope: { memory_paths: input.memory_paths } });
    rmSync(dir, { recursive: true, force: true });
    return {
      in_scope_ids: r.sources.filter(s => s.in_scope).map(s => s.id).sort(),
      block_contains_index: r.block.includes('## INDEX'),
      block_contains_user_profile: r.block.includes('## USER_PROFILE'),
    };
  }

  rmSync(dir, { recursive: true, force: true });
  throw new Error(`unknown memory-loader-scope mode: ${input.mode}`);
}

/**
 * Harness for kind=memory-loader. Exercises buildCachedPrefix against a
 * synthetic memory dir seeded from the in-repo templates so the eval can
 * verify the cached prefix:
 *   - includes the canonical sources in stable order
 *   - clears the 4096-token cache floor (Opus 4.7 / Sonnet 4.6)
 *   - reports breakpoint metadata in the documented shape
 *
 * Pure-Node; doesn't call Claude. Each run uses a throwaway tmp dir so the
 * test is hermetic.
 */
import { mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const TEMPLATES_DIR = join(__dirname, '..', '..', 'ide-template', 'skills', 'default', 'memory-cards', 'templates');

export default async function (input) {
  const dir = join(tmpdir(), 'sauna-eval-memory-loader-' + Date.now());
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'memory'), { recursive: true });

  // Seed the memory dir from in-repo templates. `cards` defaults to all
  // canonical files; pass [] to test the missing-file case.
  const cards = input.cards || [
    'AGENT_IDENTITY', 'AGENT_TOOLS', 'RULES', 'INDEX',
    'USER_PROFILE', 'USER_PREFERENCES',
  ];
  for (const c of cards) {
    const src = join(TEMPLATES_DIR, `${c}.md`);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(dir, 'memory', `${c}.md`));
  }

  process.env.PROJECT_DIR = dir;
  const mod = await import('../../ide-template/workspace-api/lib/memory-loader.js?a=' + Date.now());
  const result = mod.buildCachedPrefix();
  rmSync(dir, { recursive: true, force: true });

  return {
    sources_present:    result.sources.filter(s => s.present).map(s => s.id),
    meets_cache_floor:  mod.meetsCacheFloor(result),
    breakpoint_type:    result.breakpoint && result.breakpoint.type,
    breakpoint_ttl:     result.breakpoint && result.breakpoint.ttl,
    has_preamble:       result.block.startsWith('# Workspace memory'),
    block_nonempty:     result.block.length > 0,
  };
}

// Memory READ isolation (the deterministic, container-free half): asserts the
// cached-prefix builder and memory_grep keep one user's PRIVATE memory out of
// another user's context, and that grep never reaches into users/**. Run:
//   node ide-template/scripts/test-memory-read.mjs
import { buildCachedPrefix } from '../workspace-api/lib/memory-loader.js';
import { grepMemory } from '../workspace-api/lib/memory-grep.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP = join(tmpdir(), `memread-${process.pid}`);
const MEM = join(TMP, 'memory');
process.env.PROJECT_DIR = TMP;
mkdirSync(join(MEM, 'users', 'alice'), { recursive: true });
mkdirSync(join(MEM, 'users', 'bob'), { recursive: true });
writeFileSync(join(MEM, 'RULES.md'), '---\ntitle: Rules\n---\nSHAREDMARKER: always be kind.\n');
writeFileSync(join(MEM, 'INDEX.md'), '# Memory index\n\n## Cards\n- [[RULES]]\n');
writeFileSync(join(MEM, 'users', 'alice', 'USER_PROFILE.md'), '---\ntitle: Alice\n---\nALICEPRIVATE: runs the north region.\n');
writeFileSync(join(MEM, 'users', 'alice', 'INDEX.md'), "# alice's private memory\n\n## Cards\n- [[USER_PROFILE]]\n");
writeFileSync(join(MEM, 'users', 'bob', 'USER_PROFILE.md'), '---\ntitle: Bob\n---\nBOBPRIVATE: handles finance.\n');

let P = 0, F = 0;
const check = (n, c) => { console.log((c ? '  OK   ' : '  FAIL ') + n); c ? P++ : F++; };

// cross-user prefix isolation
const alice = buildCachedPrefix({ memoryDir: MEM, actor: 'alice' });
check('prefix: alice sees her OWN private profile', alice.block.includes('ALICEPRIVATE'));
check("prefix: alice does NOT see bob's private profile", !alice.block.includes('BOBPRIVATE'));
check("prefix: alice's private USER_INDEX is loaded", alice.block.includes('## USER_INDEX'));
const bob = buildCachedPrefix({ memoryDir: MEM, actor: 'bob' });
check("prefix: bob does NOT see alice's private profile", !bob.block.includes('ALICEPRIVATE'));

// group brain must NOT advertise a member's private pages
const group = buildCachedPrefix({ memoryDir: MEM, actor: 'alice', excludeIds: ['USER_INDEX'] });
check('prefix: group turn (excludeIds USER_INDEX) drops the private index', !group.block.includes('## USER_INDEX'));

// grep isolation
const sharedHit = await grepMemory('SHAREDMARKER', {});
check('grep: finds SHARED content', sharedHit.length > 0);
const privHit = await grepMemory('ALICEPRIVATE', {});
check('grep: CANNOT reach private users/** content', privHit.length === 0);

console.log(`\nREAD ISOLATION: ${P} passed, ${F} failed`);
rmSync(TMP, { recursive: true, force: true });
process.exit(F ? 1 : 0);

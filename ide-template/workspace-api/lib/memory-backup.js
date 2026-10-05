/**
 * memory-backup — a person's own copy of their memory, as a .tar.gz download.
 *
 * It holds exactly what that person may read — the shared tree, their own
 * memory/users/<slug>/ and the groups they are in — never another person's tree
 * and never memory/_engine/ (its log records everyone's changes). The same rule
 * for everyone: an admin's download is not a copy of the whole workspace.
 *
 * Before the migration it is cut from memory/ as it is; after it, from the
 * archive the migration took before moving anything (the old memory is gone from
 * memory/ by then), so "download the backup" still means the old memory.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function projectDir() { return process.env.PROJECT_DIR || '/home/coder/project'; }

/** May this person read this path (relative to PROJECT_DIR, under memory/)? */
export function readableMemoryPath(rel, { slug, groups = [] }) {
  const parts = String(rel).replace(/^\.\//, '').split('/').filter(Boolean);
  if (parts[0] !== 'memory' || parts.length < 2 || parts.includes('..')) return false;
  if (parts[1] === '_engine') return false;
  if (parts[1] === 'users') return parts.length > 3 && parts[2] === slug;
  if (parts[1] === 'groups') return parts.length > 3 && groups.includes(parts[2]);
  return true;
}

function liveFiles() {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(join(projectDir(), rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) out.push(child);
    }
  };
  walk('memory');
  return out;
}

/** The members of a backup, for a person: from live memory, or from an archive. */
export function backupMembers({ slug, groups = [], archive = null }) {
  let all;
  if (archive) {
    const r = spawnSync('tar', ['tzf', archive], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`cannot read the archive: ${r.stderr || r.error?.message}`);
    all = r.stdout.split('\n').map(l => l.trim().replace(/^\.\//, '')).filter(l => l && !l.endsWith('/'));
  } else {
    all = liveFiles();
  }
  return all.filter(rel => readableMemoryPath(rel, { slug, groups })).sort();
}

/**
 * Stream a person's backup into `out` (an HTTP response). Resolves with the
 * number of files; rejects on a tar failure before anything was sent.
 */
export function streamBackup(out, { slug, groups = [], archive = null }) {
  const members = backupMembers({ slug, groups, archive });
  const work = mkdtempSync(join(tmpdir(), 'memory-backup-'));
  const list = join(work, 'files.txt');
  writeFileSync(list, members.join('\n') + (members.length ? '\n' : ''));
  let root = projectDir();
  if (archive && members.length) {
    const x = spawnSync('tar', ['xzf', archive, '-C', work, '-T', list], { encoding: 'utf8' });
    if (x.status !== 0) { rmSync(work, { recursive: true, force: true }); throw new Error(`cannot extract: ${x.stderr}`); }
    root = work;
  }
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['czf', '-', '-C', root, '-T', list], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    tar.stderr.on('data', (d) => { err += d; });
    tar.stdout.pipe(out);
    tar.on('error', (e) => { rmSync(work, { recursive: true, force: true }); reject(e); });
    tar.on('close', (code) => {
      rmSync(work, { recursive: true, force: true });
      if (code === 0) resolve(members.length); else reject(new Error(`tar exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

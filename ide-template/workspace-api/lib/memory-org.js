/**
 * memory-org — what the team wrote down about itself, for the sharing router.
 *
 * The router decides which lines of a person's private conversation the team
 * may see. Without knowing the company it can only guess who needs what, so it
 * shared next to nothing: on a production client the founder's supplier
 * outreach stayed private for weeks while the co-founder who "leads sourcing"
 * (the company card says so) was asking the group bot about it. This gives the
 * router the company card's own words and who is on the team, as data — never
 * as instructions, and never anyone's private memory.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTeamMode, list as rosterList } from './team.js';

const MAX_COMPANY = 2400;   // the card's budget is 3 KB; its bullets, not its scaffolding

function memoryDir() { return join(process.env.PROJECT_DIR || '/home/coder/project', 'memory'); }

/** The company card's bullets (MISSION.md), without front matter, comments or source tails. */
export function companyLines() {
  let raw = '';
  try { raw = readFileSync(join(memoryDir(), 'MISSION.md'), 'utf8'); } catch { return []; }
  const body = raw.replace(/^---[\s\S]*?\n---\n/, '').replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  let len = 0;
  for (const l of body.split('\n')) {
    if (!/^\s*[-*]\s+\S/.test(l)) continue;
    const t = l.replace(/^\s*[-*]\s+/, '').replace(/\s*\[Source:[^\]]*\]\s*$/i, '').trim();
    if (!t || len + t.length > MAX_COMPANY) break;
    out.push(t); len += t.length + 1;
  }
  return out;
}

/**
 * The ORGANISATION block the router reads, or '' when there is nobody to share
 * with (solo, or a roster of one) — sharing is then moot, and the router runs
 * as it always did.
 */
export function orgContext({ person = null } = {}) {
  if (!getTeamMode()) return '';
  let team = [];
  try { team = rosterList().map(m => m.displayName || m.slug).filter(Boolean); } catch { team = []; }
  if (team.length < 2) return '';
  const company = companyLines();
  return [
    `TEAM: ${team.join(', ')}${person ? ` (this conversation is ${person}'s)` : ''}`,
    company.length ? `ABOUT THE COMPANY (as the team wrote it):\n${company.map(l => `- ${l}`).join('\n')}` : 'ABOUT THE COMPANY: nothing written down yet.',
  ].join('\n');
}

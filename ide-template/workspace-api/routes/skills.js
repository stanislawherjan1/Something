/**
 * /api/skills — listing of every skill the assistant can pick up.
 *
 * Post-Bundle 6 (WS3) unified-location model: every skill lives in
 *   PROJECT_DIR/.claude/skills/<name>/SKILL.md
 *
 * Frontmatter `source:` tells the UI what kind it is:
 *   - `system`             — shipped from /opt/ide/skills/default/, re-staged on every
 *                            entrypoint cycle. UI marks read-only.
 *   - `integration:<name>` — installed conditionally based on active MCPs. UI marks
 *                            read-only (auto-managed).
 *   - `project`            — user-created or operator-edited. UI fully editable.
 *
 * Each entry includes the description parsed from the SKILL.md YAML
 * frontmatter so the UI can render it without per-skill HTTP fetches,
 * plus `tags` (user-defined organization labels — only meaningful on
 * project skills), `references` (list of references/*.md filenames for
 * the editor's collapsible cards), and `managed_by` (informational —
 * who rebuilds this skill on redeploy, e.g. an integration id). `editable`
 * tells the UI whether to show Save / Delete buttons — false for system
 * skills, false when frontmatter declares `editable: false` explicitly.
 * Matches the backend ACL in lib/skill-acl.js so the UI never offers a
 * button that the API would refuse.
 *
 * Legacy: the $HOME/.claude/skills/ directory is wiped by the entrypoint
 * after Bundle 6, but mid-transition any pre-Bundle-6 client still gets
 * those skills surfaced (origin='global') so the UI shows them rather
 * than silently dropping. Next entrypoint cycle removes them.
 */

import { Router } from 'express';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from '../lib/config.js';

const HOME = process.env.HOME || '/home/coder';

const PROJECT_SKILLS_DIR = join(PROJECT_DIR, '.claude', 'skills');
const GLOBAL_SKILLS_DIR  = join(HOME, '.claude', 'skills');  // legacy, pre-Bundle-6

function parseFrontmatter(text) {
  const empty = { description: null, requires: null, tags: [], source: null, editable: null, managed_by: null };
  if (!text) return empty;
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return empty;
  const fm = m[1];

  const descMatch = fm.match(/^description:\s*(.+)$/im);
  // requires: <id>  →  scalar (string)
  // requires: [a, b] → take first id (UI tile gets one logo; if a skill spans
  // multiple integrations the first wins, which is good enough for an icon).
  const reqMatch = fm.match(/^requires:\s*(.+)$/im);
  let requires = null;
  if (reqMatch) {
    const raw = reqMatch[1].trim().replace(/^[\[]\s*/, '').replace(/\s*[\]]$/, '');
    const first = raw.split(',')[0]?.trim().replace(/['"]/g, '');
    if (first) requires = first;
  }

  // tags: [a, b, c] OR tags: foo (single scalar). Empty array if missing.
  // Trimmed, deduped, lowercase. Cap at 8 to prevent a runaway frontmatter
  // from flooding the filter chip bar.
  let tags = [];
  const tagsMatch = fm.match(/^tags:\s*(.+)$/im);
  if (tagsMatch) {
    const raw = tagsMatch[1].trim().replace(/^[\[]\s*/, '').replace(/\s*[\]]$/, '');
    const seen = new Set();
    for (const t of raw.split(',')) {
      const cleaned = t.trim().replace(/['"]/g, '').toLowerCase();
      if (cleaned && !seen.has(cleaned)) { seen.add(cleaned); tags.push(cleaned); }
      if (tags.length >= 8) break;
    }
  }

  const srcMatch  = fm.match(/^source:\s*(.+)$/im);
  const editMatch = fm.match(/^editable:\s*(.+)$/im);
  const mbMatch   = fm.match(/^managed_by:\s*(.+)$/im);
  const source   = srcMatch  ? srcMatch[1].trim().replace(/['"]/g, '')  : null;
  const editableRaw = editMatch ? editMatch[1].trim().toLowerCase()     : null;
  // Tri-state: true | false | null (frontmatter didn't say either way).
  const editable = editableRaw === 'true'  ? true
                 : editableRaw === 'false' ? false
                 : null;

  return {
    description: descMatch ? descMatch[1].trim() : null,
    requires,
    tags,
    source,
    editable,
    managed_by: mbMatch ? mbMatch[1].trim().replace(/['"]/g, '') : null,
  };
}

// Find the SKILL.md inside a skill folder — case-insensitive because some
// older skills shipped with SKILL.MD (uppercase). Returns the absolute path
// to the file, or null if no SKILL.* file exists.
function findSkillFile(skillDir) {
  let entries;
  try { entries = readdirSync(skillDir); } catch { return null; }
  const match = entries.find(n => n.toLowerCase() === 'skill.md');
  return match ? join(skillDir, match) : null;
}

// List .md files inside <skillDir>/references/ — Bundle 10 split moves
// reference material out of SKILL.md into a sibling folder. We surface the
// filenames so the editor modal can render them as collapsible cards under
// the main textarea. Returns sorted array of basenames, or [] if no folder.
function listReferences(skillDir) {
  const refsDir = join(skillDir, 'references');
  if (!existsSync(refsDir)) return [];
  let entries;
  try { entries = readdirSync(refsDir); } catch { return []; }
  return entries
    .filter(n => n.toLowerCase().endsWith('.md') && !n.startsWith('.'))
    .sort();
}

function listSkillsFromDir(dir, origin) {
  if (!existsSync(dir)) return [];
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of entries) {
    const skillDir = join(dir, name);
    let st;
    try { st = statSync(skillDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (name.startsWith('.')) continue;

    // Only consider directories with a SKILL.md (case-insensitive) inside.
    // Empty/category folders (e.g. shopify/ holding shopify-orders/,
    // shopify-products/) get skipped — clicking them used to 404.
    const skillFile = findSkillFile(skillDir);
    if (!skillFile) continue;

    let fm = { description: null, requires: null, tags: [], source: null, editable: null, managed_by: null };
    try { fm = parseFrontmatter(readFileSync(skillFile, 'utf8')); }
    catch { /* keep nulls — file might be unreadable but exists */ }

    // Infer source + editable when frontmatter didn't declare them. Mirrors
    // lib/skill-acl.js: global skills are always read-only system skills;
    // project skills default to editable. Tags are dropped for non-project
    // skills (user shouldn't see system tags in their filter bar).
    const inferredSource = fm.source || (origin === 'global' ? 'system' : 'project');
    const inferredEditable = fm.editable !== null
      ? fm.editable
      : inferredSource === 'project';

    out.push({
      name,
      origin,
      description: fm.description,
      requires:    fm.requires,
      tags:        inferredSource === 'project' ? fm.tags : [],
      source:      inferredSource,
      editable:    inferredEditable,
      managed_by:  fm.managed_by,
      references:  listReferences(skillDir),
    });
  }
  return out;
}

// Defensive: skill name + reference filename must be simple slugs — no
// slashes, no `..`, no leading dot — so a join can't escape the skill dir.
const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const REF_NAME_RE   = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/i;

export default function skillsRouter() {
  const router = Router();

  router.get('/skills', (_req, res) => {
    const project = listSkillsFromDir(PROJECT_SKILLS_DIR, 'project');
    // Legacy: post-Bundle-6 the global dir is wiped by entrypoint, but if a
    // pre-Bundle-6 client lands here mid-transition the old skills are still
    // surfaced (origin='global') so the UI shows them rather than silently
    // dropping. Next entrypoint cycle removes them.
    const global = listSkillsFromDir(GLOBAL_SKILLS_DIR, 'global');

    // Project name collision wins (same precedence claude uses).
    const projectNames = new Set(project.map(s => s.name));
    const merged = [
      ...project,
      ...global.filter(s => !projectNames.has(s.name)),
    ].sort((a, b) => a.name.localeCompare(b.name));

    res.json({ skills: merged });
  });

  // GET /api/skills/tags — unique tag list across PROJECT skills only.
  // System / integration skills don't surface tags (user shouldn't organize
  // around labels they can't control). Used by the dashboard filter chip
  // bar; if the list is empty, the bar hides itself.
  router.get('/skills/tags', (_req, res) => {
    const project = listSkillsFromDir(PROJECT_SKILLS_DIR, 'project');
    const counts = new Map();
    for (const s of project) {
      for (const t of (s.tags || [])) {
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    const tags = Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    res.json({ tags });
  });

  // Read-only fetch of one skill file's text. Two shapes:
  //   ?name=foo                    → fetches foo/SKILL.md
  //   ?name=foo&path=references/x.md → fetches foo/references/x.md
  // Origin defaults to project; pass origin=global to read a system skill.
  // We can't reuse /api/files/read because that's anchored to PROJECT_DIR
  // and globals live under $HOME. Defensive slug validation on both name
  // and the reference path so the join can't escape the skill folder.
  router.get('/skills/raw', (req, res) => {
    const name   = typeof req.query.name === 'string' ? req.query.name : '';
    const origin = req.query.origin === 'global' ? 'global' : 'project';
    const refPath = typeof req.query.path === 'string' ? req.query.path : '';

    if (!SKILL_NAME_RE.test(name)) {
      return res.status(400).json({ error: 'invalid skill name' });
    }

    const baseDir = origin === 'global' ? GLOBAL_SKILLS_DIR : PROJECT_SKILLS_DIR;
    const skillDir = join(baseDir, name);

    let targetPath;
    if (refPath) {
      // Reference file fetch. Expect "references/<slug>.md" exactly — no
      // nested paths, no .. tricks, no leading dot. Splits and revalidates
      // rather than trusting the regex on the full string, because a clever
      // attacker might slip a `/` past a single-shot match.
      const parts = refPath.split('/').filter(Boolean);
      if (parts.length !== 2 || parts[0] !== 'references' || !REF_NAME_RE.test(parts[1])) {
        return res.status(400).json({ error: 'invalid reference path' });
      }
      targetPath = join(skillDir, 'references', parts[1]);
    } else {
      targetPath = findSkillFile(skillDir);
      if (!targetPath) return res.status(404).json({ error: 'not found' });
    }

    try {
      const content = readFileSync(targetPath, 'utf8');
      res.json({ content, origin, name, path: refPath || null });
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

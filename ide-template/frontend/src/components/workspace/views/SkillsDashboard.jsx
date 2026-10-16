import { Children, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Wrench, Hexagon, Circle, Package, X, Loader2, AlertTriangle, ArrowRight, Plus, Trash2, Lock, FileText, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownView, stripFrontmatter } from '@/lib/markdown';
import EditorHeader from '../EditorHeader.jsx';
import { useBranding } from '../identity';
import { useApi, invalidate } from '@/lib/useApi';
import { SkeletonCardGrid } from '@/components/ui/Skeleton';
import useMe from '../useMe.js';
import { Tabs, Pick, OrgMark, logoUrl as resolveLogo } from './IntegrationsDashboard.jsx';
import { Avatar } from './TeamDashboard.jsx';

/** Where a skill lives: the team's under .claude/skills, a person's own in their private tree. */
const skillBase = (skill, slug) => (skill?.scope === 'personal' || skill?.origin === 'personal') && slug ? `users/${slug}/.skills` : '.claude/skills';

/**
 * Skills dashboard — visual parity with IntegrationsDashboard.
 *
 *   - Tile grid (auto-fill, minmax 260px) instead of stacked rows
 *   - Modal-based editor for SKILL.md (left: read-only "What this is",
 *     right: textarea + Save) — matches the Integrations activate modal
 *   - Subtitle paragraph above the grid mirrors the Integrations one
 *
 * Each tile reads the skill's frontmatter description on demand (1 file
 * read per tile), batched on first render. If the API or frontmatter is
 * missing we show the skill id as the description fallback.
 */
export default function SkillsDashboard({ fileEventNonce, sidebarOpen }) {
  const { botDisplayName } = useBranding();
  const { data, loading, error, reload: reloadApi } = useApi('/api/skills');
  // Integration catalog provides logos. Each skill's frontmatter `requires:`
  // points at one integration id; we use that integration's logo on the
  // skill tile instead of the default hexagon. Cheap to fetch (cached by
  // useApi) and the catalog rarely changes during a session.
  const { data: integrationsData } = useApi('/api/integrations');
  const requiresLogoMap = useMemo(() => {
    const map = {};
    for (const i of integrationsData?.integrations || []) {
      if (i.id && i.logo) map[i.id] = i.logo;
      // A skill's `requires:` may name the server instead (email, analytics).
      if (i.mcp?.name && i.logo && !map[i.mcp.name]) map[i.mcp.name] = i.logo;
      if (i.id && i.label) map[`label:${i.id}`] = i.label;
      if (i.mcp?.name && i.label && !map[`label:${i.mcp.name}`]) map[`label:${i.mcp.name}`] = i.label;
    }
    return map;
  }, [integrationsData]);
  // Known integration ids — any project skill whose `requires:` points at
  // one of these belongs in the "Integration skills" tier, regardless of
  // whether the integration is currently active. Keeps the categorisation
  // stable: removing an integration shouldn't reshuffle its skill tile
  // into the user-handcrafted bucket.
  const knownIntegrationIds = useMemo(() => {
    const set = new Set();
    for (const i of integrationsData?.integrations || []) {
      if (i.id) set.add(i.id);
      if (i.mcp?.name) set.add(i.mcp.name);
    }
    return set;
  }, [integrationsData]);
  // `?edit=<skill-name>` is the canonical "open the editor on this skill"
  // URL — works for deep links (paste a URL, modal opens), browser back
  // closes the modal, and refresh re-opens it. The component still keeps
  // a local mirror so we can carry skill metadata (origin, description)
  // across modal open without re-fetching.
  const [searchParams, setSearchParams] = useSearchParams();
  const editName = searchParams.get('edit');
  const [editing, setEditing]     = useState(null);
  const [creating, setCreating]   = useState(false);
  const [deleting, setDeleting]   = useState(null);


  // Sync URL → local editing state. When ?edit=<name> changes, look up
  // the matching skill in `skills` and open the editor on it.
  const skills = useMemo(() => data?.skills || [], [data]);
  useEffect(() => {
    if (!editName) { setEditing(null); return; }
    const match = skills.find(s => s.name === editName);
    if (match) setEditing(match);
    // If skills haven't loaded yet, this effect re-runs once they do.
  }, [editName, skills]);

  const openEditor = useCallback((skill) => {
    const next = new URLSearchParams(searchParams);
    next.set('edit', skill.name);
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  const closeEditor = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('edit');
    setSearchParams(next);
    setEditing(null);
  }, [searchParams, setSearchParams]);

  // Force-refresh when a file watcher event fires (skill added/removed
  // outside the dashboard). Only on a NEW event: the nonce is already non-zero
  // when the tab mounts, and treating that as an event dropped the cache on
  // every visit — the list vanished into a skeleton each time the tab opened.
  const seenNonce = useRef(fileEventNonce);
  useEffect(() => {
    if (fileEventNonce === seenNonce.current) return;
    seenNonce.current = fileEventNonce;
    invalidate('/api/skills');
    reloadApi();
  }, [fileEventNonce, reloadApi]);

  const reload = useCallback(() => {
    invalidate('/api/skills');
    return reloadApi();
  }, [reloadApi]);

  const isInitialLoad = loading && !data;
  const { me } = useMe();
  const team = data?.teamMode === true;
  const canEditTeam = data?.canEditTeam !== false;
  const [tab, setTab] = useState(() => (searchParams.get('tab') === 'mine' ? 'mine' : 'team'));
  const teamSkills = useMemo(() => skills.filter(s => s.scope !== 'personal'), [skills]);
  const ownSkills = useMemo(() => skills.filter(s => s.scope === 'personal'), [skills]);
  // A new skill: the team's in solo; in a team a member's is their own, an admin chooses.
  const [createFor, setCreateFor] = useState('team');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={Wrench} title="Skills" sidebarOpen={sidebarOpen} />
      {/* In a team: the team's skills and your own, as two tabs. */}
      {data && team && (
        <div className="shrink-0 px-6 pb-3 pt-1">
          <Tabs value={tab} onChange={setTab} items={[
            { id: 'team', count: teamSkills.length, label: 'Team' },
            { id: 'mine', count: ownSkills.length, label: 'Yours' },
          ]} />
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <div className="flex flex-col gap-5 px-6 pb-12 pt-2">
          {isInitialLoad && <SkeletonCardGrid count={6} width={306} />}

          {error && !data && (
            <div className="rounded-[6px] border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
              Couldn't load skills: {error}
            </div>
          )}

          {data && (
            <SkillsGrid
              skills={!team ? skills : tab === 'mine' ? ownSkills : teamSkills}
              team={team}
              canAdd={!team || tab === 'mine' || canEditTeam}
              ownLabel={team ? null : 'Your skills'}
              requiresLogoMap={requiresLogoMap}
              knownIntegrationIds={knownIntegrationIds}
              onEdit={openEditor}
              onAdd={() => { setCreateFor(team && tab === 'mine' ? 'personal' : team && !me?.isAdmin ? 'personal' : 'team'); setCreating(true); }}
              onDelete={(s) => setDeleting(s)}
            />
          )}
        </div>
      </div>

      {editing && (
        <SkillEditModal
          skill={editing}
          onClose={closeEditor}
          onSaved={() => reload()}
        />
      )}

      {deleting && (
        <DeleteSkillModal
          skill={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setDeleting(null); reload(); }}
        />
      )}

      {creating && (
        <CreateSkillModal
          existingNames={skills.map(s => s.name)}
          initialFor={createFor}
          canChoose={team && !!me?.isAdmin}
          personSlug={me?.slug}
          onClose={() => setCreating(false)}
          onCreated={(name, whose) => {
            setCreating(false);
            if (team) setTab(whose === 'personal' ? 'mine' : 'team');
            reload();
            // Open the editor on the freshly-created skill via URL so the
            // deep link works the same as clicking a tile.
            openEditor({ name });
          }}
        />
      )}
    </div>
  );
}

// ─── Grid + sections ──────────────────────────────────────────────────────

function SkillsGrid({ skills, team = false, canAdd = true, ownLabel = 'Your skills', requiresLogoMap, knownIntegrationIds, onEdit, onAdd, onDelete }) {
  // Three buckets:
  //   1. user — handcrafted project skills with no `requires:` link to a
  //      known integration
  //   2. integration — project skills whose `requires:` matches an
  //      integration in the catalog (active or not)
  //   3. global — system-wide skills shipped with the IDE image
  // Post-Bundle 6: source frontmatter field is the source of truth.
  //   source: project             → user-owned (top section, editable)
  //   source: integration:<name>  → installed per active MCP (middle, read-only)
  //   source: system              → ide-template default (bottom, read-only)
  // Legacy origin === 'global' fallback retained for first-cycle transition
  // (pre-Bundle 6 system skills surfaced from $HOME/.claude/skills/ until
  // the next entrypoint wipes that dir).
  const isIntegration = s => (s.source && s.source.startsWith('integration:'))
                          || (!s.source && s.origin === 'project' && s.requires && knownIntegrationIds?.has(s.requires));
  const isSystem      = s => s.source === 'system' || s.origin === 'global';

  // One grid, ordered: handcrafted first, then a service's, then the system's.
  // What kind a skill is shows as the pill on its tile (System / Integration).
  const withKind = skills;
  const rank = (s) => isSystem(s) ? 2 : isIntegration(s) ? 1 : 0;
  const ordered = useMemo(() => [...withKind].sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name)), [withKind]);


  const shown = ordered;

  const { botDisplayName } = useBranding();
  // Nothing here yet: the same empty screen as Routines — a title, one line, the way to add one.
  if (!ordered.length) return (
    <div className="flex min-h-[calc(100dvh-14rem)] items-center justify-center px-6 py-16">
      <div className="flex max-w-[320px] flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground/50">
          <Wrench className="size-6" strokeWidth={1.75} />
        </div>
        <h2 className="text-[14px] font-semibold tracking-tight text-foreground/85">{team ? 'No skills of your own yet' : 'No skills yet'}</h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground/75">
          Tell {botDisplayName} in the chat how you want something done, and it becomes a skill — or write one yourself.
        </p>
        {canAdd && (
          <button type="button" onClick={onAdd}
            className="mt-1 inline-flex items-center gap-1 rounded-[6px] bg-foreground/[0.09] px-3 py-1.5 text-[12.5px] font-medium text-foreground/90 transition-colors hover:bg-foreground/[0.14]">
            <Plus className="size-3.5" strokeWidth={2} /> Add your own
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-12">
      <Section
        label={ownLabel}
        count={shown.length}
        empty="No skills yet."
      >
        {shown.map(s => (
          <SkillTile
            key={`${s.scope || s.origin}-${s.name}`}
            skill={s}
            logoUrl={s.requires ? requiresLogoMap?.[s.requires] : null}
            serviceLabel={s.requires ? requiresLogoMap?.[`label:${s.requires}`] : null}
            team={team}
            onEdit={() => onEdit(s)}
            onDelete={() => onDelete(s)}
          />
        ))}
        {canAdd && <AddSkillTile onClick={onAdd} />}
      </Section>
    </div>
  );
}

function Section({ label, count, hint, empty, belowHeader, children }) {
  // children always include at least the AddSkillTile for the project group,
  // so "empty state" only kicks in when there are no real cards.
  const tileCount = Array.isArray(children) ? children.flat().length : 1;
  return (
    <div className="flex flex-col gap-2.5">
      {/* No title when the tab above already says what this is. */}
      {label && (
        <div className="flex items-baseline gap-2 px-0.5">
          <span className="text-[10.5px] font-semibold uppercase leading-none tracking-wider text-muted-foreground/65">
            {label}
          </span>
          <span className="text-[11px] leading-none text-muted-foreground/50">
            {count}{count === 1 ? '' : ''}
          </span>
          {hint && <span className="ml-1 text-[11px] leading-none text-muted-foreground/65">· {hint}</span>}
        </div>
      )}
      {/* Optional slot between header + tiles. Used by "Your skills" to hang
          the tag filter bar directly under its label, since the filter only
          affects this one section — visual grouping > top-of-grid placement. */}
      {belowHeader}
      {tileCount === 0 && empty ? (
        <div className="rounded-[6px] border border-border/50 bg-muted/15 px-4 py-5 text-center text-[13px] text-muted-foreground/75">
          {empty}
        </div>
      ) : (
        <div className="grid auto-rows-fr gap-3 grid-cols-[repeat(auto-fill,306px)] max-sm:grid-cols-1">
          {Children.map(children, (child) =>
            child ? (
              <motion.div
                key={child.key ?? undefined}
                className="h-full"
                layout
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              >
                {child}
              </motion.div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tile ──────────────────────────────────────────────────────────────────

/**
 * Small integration logo chip rendered next to a skill's name. White
 * background + hairline outline so the brand mark reads consistently in
 * both light and dark mode (most product logos are designed against white).
 * Sized to match the title row height. Falls back to invisible on img error
 * so a missing/404 logo doesn't push out a broken-image placeholder.
 */
function IntegrationBadge({ src }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <span className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-[4px] bg-white ring-1 ring-border/55">
      <img
        src={src}
        alt=""
        className="size-[12px] object-contain"
        onError={() => setFailed(true)}
      />
    </span>
  );
}

function SkillTile({ skill, logoUrl, serviceLabel = null, team = false, activeTags, onToggleTag, onEdit, onDelete }) {
  const own = skill.scope === 'personal';
  const { name, description, origin, source, editable, tags = [], references = [] } = skill;
  // Read-only = backend says `editable: false` (system / integration skills)
  // OR the legacy origin=global signal (pre-Bundle-6 clients before the
  // entrypoint cycle wipes $HOME/.claude/skills/). Fallback covers a mid-
  // transition window when frontmatter hasn't been stamped yet.
  const isReadOnly = editable === false || origin === 'global';
  // Source-driven badge label. `Global` fallback covers legacy entries
  // surfaced before the entrypoint re-stamps frontmatter with `source:`.
  let badgeLabel = null;
  if (source === 'system') badgeLabel = 'System';
  else if (origin === 'global') badgeLabel = 'Global';
  const refsCount = references.length;
  // Tags only render when the skill has any AND we have a toggle handler
  // (i.e. on "Your skills" tiles — integration / system tiles don't pass
  // activeTags/onToggleTag, so chips silently no-op there).
  const showTags = tags.length > 0 && onToggleTag;
  // Cap visible chips at 2 to keep tile density manageable; overflow chip
  // shows the remainder and acts as a generic "more tags" affordance — a
  // click on it opens the editor (no good place to drill into a single
  // skill's full tag list otherwise). Bundle 10 left most skills with 1-2
  // tags so this rarely triggers in practice.
  const visibleTags  = showTags ? tags.slice(0, 2) : [];
  const overflowTags = showTags ? Math.max(0, tags.length - visibleTags.length) : 0;

  return (
    <div className="group relative flex h-full flex-col rounded-[6px] border border-border/60 bg-card transition-all duration-150 hover:border-foreground/15 hover:shadow-[0_2px_6px_rgba(0,0,0,0.035)]">
      {/* Hover-revealed trash — hidden when read-only (system / integration).
          Absolute positioning so it doesn't shift layout when it appears.
          Positioned at the top-right corner — overlaps the right end of the
          name row on hover, which is fine since the name is visible at rest
          and the trash only shows on intent. */}
      {!isReadOnly && onDelete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="absolute right-2.5 top-[18px] z-10 rounded-[6px] p-1.5 text-muted-foreground/65 opacity-0 transition-all duration-150 hover:bg-destructive/[0.08] hover:text-destructive group-hover:opacity-100 focus:opacity-100"
          aria-label={`Delete ${name}`}
          title="Delete skill"
        >
          <Trash2 className="size-3.5" strokeWidth={1.75} />
        </button>
      )}

      <div className="flex flex-1 flex-col px-4 pt-4">
        <div className="flex items-center gap-2">
          <span className="group/kind relative inline-flex shrink-0">
          <div className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)] ring-1 ring-black/[0.04]',
            // A service's logo sits on white in both themes, as on Integrations:
            // brand marks are drawn for a white backdrop.
            logoUrl ? 'bg-white' : 'bg-card',
            isReadOnly && 'opacity-70',
          )}>
            {/* What kind of skill, by its icon: the service's logo, the product's package, or one's own. */}
            {logoUrl
              ? <img src={resolveLogo(logoUrl)} alt="" className="size-3.5 object-contain" />
              : badgeLabel
                ? <Package className="size-3 text-muted-foreground/70" strokeWidth={1.75} aria-label="System skill" />
                : own
                  ? <Circle className="size-2.5 text-muted-foreground/70" strokeWidth={1.75} />
                  : <Hexagon className="size-2.5 text-muted-foreground/70" strokeWidth={1.75} />}
          </div>
            <span role="tooltip" className="pointer-events-none absolute left-0 top-full z-30 mt-1.5 hidden w-max max-w-[260px] rounded bg-popover px-3 py-2 text-[12px] font-normal leading-snug text-popover-foreground/90 shadow-md ring-1 ring-foreground/10 group-hover/kind:block">{logoUrl ? `Integration skill${serviceLabel ? `: ${serviceLabel}` : ''}` : badgeLabel ? 'System skill' : own ? 'Your skill' : team ? 'Team skill' : 'Skill'}</span>
          </span>
          {/* Name + integration badge sit together on the left so the
              hover trash (top-right corner) can't occlude the logo. The
              wrapper claims flex-1 so the source pill (when present) is
              pushed all the way right. */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="min-w-0 truncate text-[14.5px] font-semibold text-foreground/90">
              {name}
            </span>
          </div>
          {refsCount > 0 && (
            <span
              className={cn('inline-flex shrink-0 items-center gap-1 rounded-[6px] bg-muted/45 px-1.5 py-0.5 text-[10.5px] font-medium leading-none text-muted-foreground/80', !isReadOnly && onDelete && 'transition-opacity group-hover:opacity-0')}
              title={`${refsCount} reference file${refsCount === 1 ? '' : 's'}`}
            >
              <FileText className="size-3" strokeWidth={2} />
              {refsCount}
            </span>
          )}
        </div>
        <div className="mt-2 line-clamp-2 min-h-[3.25em] text-[12.5px] leading-relaxed text-muted-foreground/80">
          {description || <span className="italic text-muted-foreground/55">No description in SKILL.md</span>}
        </div>
        {showTags && (
          <div className="mt-auto flex flex-wrap items-center gap-1 pt-3">
            {visibleTags.map(t => (
              <button
                key={t}
                type="button"
                onClick={(e) => { e.stopPropagation(); onToggleTag(t); }}
                className={cn(
                  'inline-flex items-center rounded-[6px] px-1.5 py-0.5 text-[10.5px] font-medium leading-none transition-colors',
                  activeTags?.has(t)
                    ? 'bg-muted/85 text-foreground ring-1 ring-foreground/30'
                    : 'bg-muted/45 text-muted-foreground/80 hover:bg-muted/65 hover:text-foreground/85',
                )}
                title={`Filter by #${t}`}
              >
                #{t}
              </button>
            ))}
            {overflowTags > 0 && (
              <span className="text-[10.5px] leading-none text-muted-foreground/60">+{overflowTags}</span>
            )}
          </div>
        )}
      </div>

      {/* Same footer as the AI Settings tiles: a quiet secondary button —
          primary black is kept for things that still need setting up. */}
      <div className="px-4 pb-4 pt-3.5">
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-[6px] bg-muted/40 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/75 transition-all hover:bg-muted/55 hover:text-foreground/90 active:scale-[0.98]"
        >
          {isReadOnly ? 'View' : 'Edit'}
        </button>
      </div>
    </div>
  );
}

// ─── Add tile ──────────────────────────────────────────────────────────────

// Same as the Team view's "Add member" tile: a dashed, centred call to add one.
function AddSkillTile({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-full w-full group flex flex-col items-center justify-center gap-2 rounded-[6px] border border-dashed border-border/70 bg-muted/15 px-4 py-4 text-muted-foreground/70 transition-all hover:border-foreground/25 hover:bg-muted/30 hover:text-foreground/85"
    >
      <div className="flex size-12 shrink-0 items-center justify-center rounded-[6px] bg-background ring-1 ring-border/60 transition-colors group-hover:ring-foreground/20">
        <Plus className="size-5" strokeWidth={1.75} />
      </div>
      <div className="text-[13.5px] font-medium">Add skill</div>
      <div className="text-[11.5px] text-muted-foreground/65">Create a new playbook</div>
    </button>
  );
}

// ─── Create Modal ──────────────────────────────────────────────────────────

const SLUG_RE   = /^[a-z0-9][a-z0-9-]{1,49}$/;
const TAG_RE    = /^[a-z0-9][a-z0-9-]{0,29}$/;
const RESERVED  = new Set(['', '.', '..']);
// Initial template the new SKILL.md is seeded with — frontmatter + a stub
// body. Using a consistent shape across all skills makes the description
// surface in the dashboard immediately. Tags are only emitted when the
// user actually entered any — keeps an empty `tags: []` line out of the
// frontmatter for the common case.
const SKILL_TEMPLATE = (name, description) => {
  return `---\nname: ${name}\ndescription: ${description || `Use this when …`}\n---\n\n# ${name}\n\nDescribe how the assistant should approach this task.\n`;
};

function CreateSkillModal({ existingNames, initialFor = 'team', canChoose = false, personSlug = null, onClose, onCreated }) {
  const [whose, setWhose] = useState(initialFor);
  const { me } = useMe();
  const branding = useBranding();
  const [name, setName]               = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState(null);

  const slug = name.trim().toLowerCase();
  const slugValid   = SLUG_RE.test(slug) && !RESERVED.has(slug);
  const slugTaken   = existingNames.some(n => n.toLowerCase() === slug);
  const slugError   = !slug ? null
    : !slugValid ? 'Use lowercase letters, digits, and dashes only (2–50 chars).'
    : slugTaken  ? 'A skill with this name already exists.'
    : null;
  const canCreate = slug && slugValid && !slugTaken && !busy;


  // Esc closes; lock body scroll while modal is open.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const submit = async (e) => {
    e?.preventDefault();
    if (!canCreate) return;
    setBusy(true); setError(null);
    // Pick up a half-typed tag the user didn't press Enter on — feels
    // friendlier than silently dropping it.
    try {
      const path = `${skillBase({ scope: whose }, personSlug)}/${slug}/SKILL.md`;
      const resp = await fetch('/api/files/create', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ path, content: SKILL_TEMPLATE(slug, description.trim()) }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      onCreated(slug, whose);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create skill"
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop px-4 animate-[fade-in_0.12s_ease-out]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <form onSubmit={submit} className="flex w-full max-w-lg flex-col overflow-hidden modal-panel">
        <div className="flex items-center gap-3 border-b border-border/40 px-6 py-4">
          <Hexagon className="size-4 shrink-0 text-muted-foreground/70" strokeWidth={1.75} />
          <div className="min-w-0 flex-1 text-[15px] font-semibold text-foreground/90">New skill</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] p-1.5 text-muted-foreground/65 transition-colors hover:bg-muted/30 hover:text-foreground/85"
            aria-label="Close"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-skill-name" className="text-[12.5px] font-medium text-foreground/85">
              Name
            </label>
            <input
              id="new-skill-name"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. customer-replies"
              disabled={busy}
              className="rounded border border-border/60 bg-background px-3.5 py-2 font-mono text-[13px] text-foreground outline-none transition-all focus:border-foreground/60 focus:ring-2 focus:ring-foreground/10 disabled:opacity-60"
            />
            <div className="text-[11.5px] text-muted-foreground/70">
              Used as the folder name under <span className="font-mono">.claude/skills/</span>. Lowercase, dashes between words.
            </div>
            {slugError && (
              <div className="text-[11.5px] text-destructive">{slugError}</div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-skill-description" className="text-[12.5px] font-medium text-foreground/85">
              Description (optional)
            </label>
            <input
              id="new-skill-description"
              autoComplete="off"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One line: when should the assistant use this skill?"
              disabled={busy}
              className="rounded border border-border/60 bg-background px-3.5 py-2 text-[13px] text-foreground outline-none transition-all focus:border-foreground/60 focus:ring-2 focus:ring-foreground/10 disabled:opacity-60"
            />
            <div className="text-[11.5px] text-muted-foreground/70">
              Surfaces in the dashboard tile and helps the assistant pick the right skill. You can edit it anytime.
            </div>
          </div>

          {canChoose && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-foreground/85">For whom</span>
              <div className="flex">
                <Pick id="skill-for" value={whose} onChange={setWhose} disabled={busy} options={[
                  { value: 'team', label: 'The whole team', icon: <OrgMark orgIcon={branding.iconUrl || branding.logoUrl} className="size-4" /> },
                  { value: 'personal', label: 'Just me', icon: <Avatar name={me?.displayName || me?.email} email={me?.email} avatarUrl={me?.avatarUrl} className="!size-4 text-[8px]" /> },
                ]} />
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded border border-destructive/25 bg-destructive/[0.04] px-3 py-2 text-[12.5px] text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/40 bg-background px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-4 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground/85 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canCreate}
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-5 py-2 text-[13px] font-medium transition-all',
              canCreate
                ? 'bg-foreground text-background hover:opacity-95 active:scale-[0.98]'
                : 'cursor-not-allowed bg-muted text-muted-foreground/60',
            )}
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Edit Modal ────────────────────────────────────────────────────────────

function SkillEditModal({ skill, onClose, onSaved }) {
  const { name, origin, references = [], editable } = skill;
  // `editable` is the backend-authoritative read-only signal (Bundle 6 +
  // skill-acl). `isGlobal` is the legacy origin-based check, kept as a
  // fallback during the mid-transition window when frontmatter hasn't
  // been stamped yet on a given client.
  const isGlobal   = origin === 'global';
  const isReadOnly = editable === false || isGlobal;
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const dirty = !isReadOnly && content !== original;
  // Both project and global skills go through /api/skills/raw because it
  // does case-insensitive SKILL.md lookup (some older skills shipped with
  // uppercase SKILL.MD — /api/files/read with a hardcoded path 404s those).
  const readPath = `/api/skills/raw?name=${encodeURIComponent(name)}&origin=${origin}`;
  // Writes still go through /api/files/write — Save canonicalises to lower-
  // case "SKILL.md" so newly-saved skills don't perpetuate the casing quirk.
  const { me: viewer } = useMe();
  const writePath = `${skillBase(skill, viewer?.slug)}/${name}/SKILL.md`;

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    fetch(readPath)
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) { setStatus('error'); setError(data.error || `HTTP ${r.status}`); return; }
        setContent(data.content || '');
        setOriginal(data.content || '');
        setStatus('ok');
      })
      .catch(err => { if (!cancelled) { setStatus('error'); setError(err.message); } });
    return () => { cancelled = true; };
  }, [readPath]);

  const save = async () => {
    if (isReadOnly) return;   // belt & braces — Save button is hidden anyway
    setSaving(true); setError(null);
    try {
      const resp = await fetch('/api/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: writePath, content }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        setError(err.error || `HTTP ${resp.status}`);
        return;
      }
      setOriginal(content);
      onSaved?.();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };


  // Esc to close, Cmd/Ctrl+S to save.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && dirty && !saving) {
        e.preventDefault(); save();
      }
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prevOverflow; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, saving, content]);

  const description = parseDescription(content);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Edit skill: ${name}`}
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop px-4 animate-[fade-in_0.12s_ease-out]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={cn(
        'relative flex w-full max-w-6xl flex-col overflow-hidden modal-panel',
        // When references exist, lock modal height. Otherwise expanding a
        // collapsed reference card would push the modal taller, which looks
        // like the modal is jumping. With explicit height the body's
        // overflow-y-auto handles all content shifts internally.
        // No references → size to content (small skills stay compact).
        references.length > 0 ? 'h-[82vh]' : 'max-h-[88vh]',
      )}>
        {/* Slim header — title + dirty pill + close. No left side column;
            description (if any) sits as a one-line caption right under it
            so the editor gets every available pixel. */}
        <div className="flex items-center gap-3 border-b border-border/40 px-6 py-3.5">
          <Hexagon className="size-4 shrink-0 text-muted-foreground/70" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14.5px] font-semibold text-foreground/90">{name}</div>
            {description && (
              <div className="truncate text-[12px] text-muted-foreground/75">{description}</div>
            )}
          </div>
          {dirty && (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">Unsaved</span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] p-1.5 text-muted-foreground/65 transition-colors hover:bg-muted/30 hover:text-foreground/85"
            aria-label="Close"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* Body — full-width writing surface. Textarea fills the modal,
            content centred in a comfortable prose width so long lines don't
            stretch across a 1200 px screen but the box itself is huge. */}
        <div className="flex-1 overflow-y-auto bg-background">
          {status === 'loading' && (
            <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          )}
          {status === 'error' && (
            <div className="flex h-full items-center justify-center px-8 text-center">
              <div className="flex max-w-md items-start gap-2 rounded-[6px] border border-destructive/25 bg-destructive/[0.04] px-3.5 py-2.5 text-[12.5px] text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
                <span>{error}</span>
              </div>
            </div>
          )}
          {status === 'ok' && (
            <div className="mx-auto w-full max-w-3xl px-8 py-8">
              {isReadOnly && (
                <div className="mb-5 flex items-start gap-2 rounded-[6px] border border-border/50 bg-muted/30 px-3.5 py-2 text-[12px] text-muted-foreground/85">
                  <Lock className="mt-0.5 size-3 shrink-0 text-muted-foreground/60" strokeWidth={2} />
                  <span>
                    {isGlobal
                      ? 'Global skill, read-only here. To customise it for this project, copy the contents into a new project skill with the same name; it\'ll override the global.'
                      : 'This skill is marked read-only. To customise it, create a project skill with the same name: that takes precedence.'}
                  </span>
                </div>
              )}
              {/* Read-only skills (global + read-only project skills) render as
                  formatted markdown — the raw ## / ** / frontmatter dump was
                  unreadable. Editable skills keep the mono textarea so the
                  source stays exactly what you save. */}
              {isReadOnly ? (
                <MarkdownView className={references.length > 0 ? 'min-h-[12vh]' : 'min-h-[40vh]'}>
                  {stripFrontmatter(content)}
                </MarkdownView>
              ) : (
                <textarea
                  value={content}
                  onChange={(e) => { setContent(e.target.value); setError(null); }}
                  spellCheck={false}
                  autoFocus
                  className={cn(
                    'block w-full resize-none border-0 bg-transparent font-mono text-[14px] leading-[1.75] tracking-[-0.005em] text-foreground/92 outline-none placeholder:text-muted-foreground/40',
                    // When references exist, the modal already has substantial
                    // content below the textarea — don't claim space just to
                    // sit on it. Let fieldSizing grow the textarea with its
                    // actual content (couple lines = couple lines tall) and
                    // references get the room they need below.
                    references.length > 0 ? 'min-h-[12vh]' : 'min-h-[60vh]',
                  )}
                  style={{ fieldSizing: 'content' }}
                />
              )}

              {/* References — collapsible cards below the main editor. Skills
                  split via Bundle 10 keep their bulky reference material in
                  references/*.md so the always-loaded SKILL.md body stays
                  small. Cards render closed; first expand triggers a fetch.
                  Each card has its own dirty state + ⌘S save (folded into
                  the modal's keydown handler via card-level callbacks). */}
              {references.length > 0 && (
                <div className="mt-8 flex flex-col gap-2.5 border-t border-border/40 pt-6">
                  <div className="flex items-baseline gap-2 px-0.5">
                    <FileText className="size-3.5 text-muted-foreground/65" strokeWidth={1.75} />
                    <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      References
                    </span>
                    <span className="text-[11px] text-muted-foreground/50">{references.length}</span>
                  </div>
                  {references.map(refName => (
                    <ReferenceCard
                      key={refName}
                      skillName={name}
                      origin={origin}
                      refName={refName}
                      readOnly={isReadOnly}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 border-t border-border/40 bg-background px-6 py-3">
          <span className="text-[11.5px] text-muted-foreground/60">
            {isReadOnly
              ? 'Read-only, close with '
              : 'Save with '}
            {!isReadOnly && <kbd className="rounded bg-muted/60 px-1 py-px font-mono text-[10.5px]">⌘S</kbd>}
            {!isReadOnly && ', close with '}
            <kbd className="rounded bg-muted/60 px-1 py-px font-mono text-[10.5px]">Esc</kbd>
          </span>
          {error && status === 'ok' && (
            <span className="ml-3 text-[12.5px] text-destructive">{error}</span>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="ml-auto rounded px-4 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground/85 disabled:opacity-50"
          >
            Close
          </button>
          {!isReadOnly && (
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving}
              className={cn(
                'inline-flex items-center gap-1.5 rounded px-6 py-2 text-[13px] font-medium transition-all',
                !dirty || saving
                  ? 'cursor-not-allowed bg-muted text-muted-foreground/60'
                  : 'bg-foreground text-background hover:opacity-95 active:scale-[0.98]',
              )}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" />
                : null}
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Reference card (inside SkillEditModal) ────────────────────────────────

// A single references/*.md file as a collapsible card. Closed by default —
// expanding fetches the file from /api/skills/raw?path=references/... and
// renders a self-contained editor (textarea + Save). Each card has its
// own state so editing one doesn't trigger a re-render of the others.
//
// Saves go through /api/files/write at the full project path so the watcher,
// audit log, and skill-acl gate all see the change exactly like a SKILL.md
// save would. Read-only when the parent skill is (system / integration).
function ReferenceCard({ skillName, origin, refName, readOnly }) {
  const { me: viewer } = useMe();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | ok | error
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const dirty = !readOnly && status === 'ok' && content !== original;

  const readPath = `/api/skills/raw?name=${encodeURIComponent(skillName)}&origin=${origin}&path=${encodeURIComponent(`references/${refName}`)}`;
  const writePath = `${skillBase({ origin }, viewer?.slug)}/${skillName}/references/${refName}`;

  const expand = useCallback(() => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (status === 'ok' || status === 'loading') return; // already fetched
    setStatus('loading');
    fetch(readPath)
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { setStatus('error'); setError(data.error || `HTTP ${r.status}`); return; }
        setContent(data.content || '');
        setOriginal(data.content || '');
        setStatus('ok');
      })
      .catch(err => { setStatus('error'); setError(err.message); });
  }, [open, status, readPath]);

  const save = async () => {
    if (readOnly || !dirty) return;
    setSaving(true); setError(null);
    try {
      const resp = await fetch('/api/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: writePath, content }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        setError(err.error || `HTTP ${resp.status}`);
        return;
      }
      setOriginal(content);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  // Cmd/Ctrl+S inside this card's textarea. We attach to the textarea
  // (not window) so it doesn't compete with the parent modal's ⌘S which
  // saves SKILL.md.
  const onTextareaKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && dirty && !saving) {
      e.preventDefault(); save();
    }
  };

  return (
    <div className="overflow-hidden rounded-[6px] border border-border/55 bg-card">
      <button
        type="button"
        onClick={expand}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-muted/30"
      >
        {open
          ? <ChevronDown  className="size-3.5 shrink-0 text-muted-foreground/70" strokeWidth={2} />
          : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70" strokeWidth={2} />}
        <span className="min-w-0 flex-1 truncate font-mono text-foreground/85">{`references/${refName}`}</span>
        {dirty && (
          <span className="rounded-full bg-amber-500/10 px-1.5 py-px text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
            Unsaved
          </span>
        )}
        {status === 'error' && (
          <span className="text-[11px] text-destructive">load failed</span>
        )}
      </button>

      {open && (
        <div className="border-t border-border/40 bg-background px-3.5 py-3">
          {status === 'loading' && (
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground/85">
              <Loader2 className="size-3.5 animate-spin" /> Loading…
            </div>
          )}
          {status === 'error' && (
            <div className="flex items-start gap-2 rounded-[6px] border border-destructive/25 bg-destructive/[0.04] px-3 py-2 text-[12px] text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
              <span>{error}</span>
            </div>
          )}
          {status === 'ok' && (
            <>
              <textarea
                value={content}
                onChange={(e) => { setContent(e.target.value); setError(null); }}
                onKeyDown={onTextareaKey}
                spellCheck={false}
                readOnly={readOnly}
                className={cn(
                  'block min-h-[20vh] w-full resize-none border-0 bg-transparent font-mono text-[13px] leading-[1.7] outline-none placeholder:text-muted-foreground/40',
                  readOnly ? 'text-foreground/75' : 'text-foreground/92',
                )}
                style={{ fieldSizing: 'content' }}
              />
              {!readOnly && (
                <div className="mt-2 flex items-center justify-end gap-2">
                  {error && (
                    <span className="mr-auto text-[11.5px] text-destructive">{error}</span>
                  )}
                  <button
                    type="button"
                    onClick={save}
                    disabled={!dirty || saving}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded px-3 py-1 text-[12px] font-medium transition-all',
                      !dirty || saving
                        ? 'cursor-not-allowed bg-muted text-muted-foreground/60'
                        : 'bg-foreground text-background hover:opacity-95 active:scale-[0.98]',
                    )}
                  >
                    {saving ? <Loader2 className="size-3 animate-spin" />
                : null}
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Delete Skill Modal (fixed, top-level) ─────────────────────────────────

function DeleteSkillModal({ skill, onClose, onDeleted }) {
  const { name } = skill;
  const { me: viewer } = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const remove = async () => {
    setBusy(true); setError(null);
    try {
      const dir = `${skillBase(skill, viewer?.slug)}/${name}`;
      const resp = await fetch(`/api/files/delete?path=${encodeURIComponent(dir)}`, { method: 'DELETE' });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      onDeleted();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Delete skill: ${name}`}
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop px-4 animate-[fade-in_0.12s_ease-out]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md overflow-hidden modal-panel">
        <div className="flex items-start gap-3.5 px-6 py-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
            <Trash2 className="size-4 text-destructive" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-foreground">Delete {name}?</div>
            <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground/85">
              This permanently removes <span className="font-mono text-[12px]">.claude/skills/{name}/</span> and all files inside. This can't be undone.
            </div>
            {error && (
              <div className="mt-3 rounded border border-destructive/25 bg-destructive/[0.04] px-2.5 py-1.5 text-[12px] text-destructive">
                {error}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/50 bg-muted/15 px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground/85 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded bg-destructive px-4 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-95 disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Frontmatter helper ────────────────────────────────────────────────────

// Pull the `description:` line out of a SKILL.md YAML frontmatter block.
// Skill files use the simple convention:
//   ---
//   name: foo
//   description: One-liner used in the dashboard.
//   ---
//   <body>
function parseDescription(text) {
  if (!text) return null;
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return null;
  const desc = m[1].match(/^description:\s*(.+)$/im);
  return desc ? desc[1].trim() : null;
}

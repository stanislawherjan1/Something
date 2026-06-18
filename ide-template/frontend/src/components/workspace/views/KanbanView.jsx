import { useState, useEffect, useMemo } from 'react';
import { KanbanSquare, CircleUserRound, Calendar, CheckCircle2, Columns3, List as ListIcon, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import { useBranding } from '../identity.jsx';
import { useApi } from '@/lib/useApi';

const VIEW_MODE_KEY = 'tasks-view-mode';

/**
 * KanbanView — render Tasks.md as a board.
 *
 * Format (matches the task-management skill in
 * ide-template/skills/default/task-management/SKILL.md):
 *
 *   ## Column                                    ← e.g. Backlog / In Progress / Done
 *   ### Task title                               ← card heading
 *   **Owner:** Name · **Priority:** High · **Deadline:** YYYY-MM-DD or TBD
 *
 *   One or more paragraphs describing the task.
 *
 *   ### Next task title
 *   ...
 *
 * Cards in `## Done` may also carry `**Completed:** YYYY-MM-DD`.
 *
 * Iteration 3: read-only render. Drag-drop + write-back to file lands later.
 */
export default function KanbanView({ path, fileEventNonce, sidebarOpen }) {
  const url = `/api/files/read?path=${encodeURIComponent(path)}`;
  const { data, loading, error, reload } = useApi(url);

  // View mode persists per-device in localStorage. Default 'list' — most
  // tasks are read top-to-bottom and the list is denser for scanning.
  const [viewMode, setViewMode] = useState(() => {
    try {
      const v = localStorage.getItem(VIEW_MODE_KEY);
      return v === 'list' || v === 'board' ? v : 'list';
    } catch { return 'list'; }
  });
  useEffect(() => {
    try { localStorage.setItem(VIEW_MODE_KEY, viewMode); } catch { /* private mode */ }
  }, [viewMode]);

  // Background refresh when a file watcher event fires
  useEffect(() => {
    if (fileEventNonce) reload();
  }, [fileEventNonce, reload]);

  const columns = useMemo(() => {
    if (!data?.content) return [];
    return parseKanban(data.content);
  }, [data]);

  const isInitialLoad = loading && !data;
  const isNotFound = error && (error.includes('404') || error.includes('ENOENT'));
  const realError = error && !isNotFound ? error : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader
        icon={KanbanSquare}
        title="Tasks"
        meta={<ViewToggle value={viewMode} onChange={setViewMode} />}
        sidebarOpen={sidebarOpen}
      />
      <div className="flex-1 overflow-auto">
        {isInitialLoad && <Centered>Loading…</Centered>}
        {isNotFound && <TasksEmptyState />}
        {realError && <Centered error>Error: {realError}</Centered>}
        {!isInitialLoad && !isNotFound && (
          <div className="h-full pb-6 pt-2">
            {viewMode === 'list' ? <ListView columns={columns} /> : <Board columns={columns} />}
          </div>
        )}
      </div>
    </div>
  );
}

function ViewToggle({ value, onChange }) {
  return (
    <div role="group" aria-label="View" className="flex items-center gap-0.5 rounded-md border border-border/50 bg-muted/40 p-0.5">
      <ToggleButton active={value === 'list'}  label="List"  icon={ListIcon}  onClick={() => onChange('list')} />
      <ToggleButton active={value === 'board'} label="Board" icon={Columns3}  onClick={() => onChange('board')} />
    </div>
  );
}

function ToggleButton({ active, label, icon: Icon, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className={cn(
        'inline-flex items-center gap-1 rounded px-2 py-1 text-[11.5px] font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-xs'
          : 'text-muted-foreground/75 hover:text-foreground/85',
      )}
    >
      <Icon className="size-3.5" strokeWidth={1.75} />
      {label}
    </button>
  );
}

function ListView({ columns }) {
  if (columns.length === 0) {
    return (
      <Centered>
        No columns yet. Add headings like
        <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-[12px]">## Backlog</code>
        and tasks as
        <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-[12px]">### Title</code>.
      </Centered>
    );
  }
  return (
    <div className="flex w-full flex-col gap-7 px-6 pt-2">
      {columns.map((col, i) => (
        <ListSection key={i} column={col} />
      ))}
    </div>
  );
}

function ListSection({ column }) {
  const isDone = /^done$/i.test(column.name.trim());
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
          {column.name}
        </h3>
        <span className="rounded-full bg-muted/55 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground/75">
          {column.cards.length}
        </span>
      </div>
      {column.cards.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/40 bg-muted/10 px-4 py-4 text-[12.5px] italic text-muted-foreground/55">
          No tasks
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {column.cards.map((card, i) => (
            <ListRow key={i} card={card} done={isDone} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ListRow({ card, done }) {
  return (
    <li
      className={cn(
        'group flex items-center gap-3 rounded-xl border border-border/55 bg-card px-4 py-3 transition-all duration-150',
        'hover:border-foreground/15 hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)]',
        done && 'opacity-70',
      )}
    >
      {done ? (
        <CheckCircle2 className="size-[15px] shrink-0 text-emerald-600/75 dark:text-emerald-400/75" strokeWidth={2} />
      ) : (
        <span className="size-[15px] shrink-0 rounded-full ring-[1.5px] ring-border/55 ring-offset-0" aria-hidden />
      )}
      <span className={cn(
        'min-w-0 flex-1 truncate text-[13.5px] leading-snug',
        done ? 'font-medium text-muted-foreground/75 line-through' : 'font-medium text-foreground/90',
      )}>
        {card.title}
      </span>
      <span className="flex shrink-0 items-center gap-2.5">
        {card.deadline && (
          <span className="inline-flex items-center gap-1 text-[11.5px] tabular-nums text-muted-foreground/75">
            <Calendar className="size-[12px]" strokeWidth={1.75} />
            {card.deadline}
          </span>
        )}
        {card.priority && <PriorityChip value={card.priority} />}
        {!card.priority && !card.deadline && (
          <span className="text-[12px] text-muted-foreground/30">—</span>
        )}
      </span>
    </li>
  );
}

function PriorityChip({ value }) {
  const key = value.trim().toLowerCase();
  const style = PRIORITY_STYLE[key] || PRIORITY_STYLE.low;
  const Icon = style.icon;
  return (
    <span
      title={value}
      aria-label={`Priority: ${value}`}
      className="inline-flex size-[16px] items-center justify-center text-muted-foreground/70"
    >
      <Icon className="size-[14px]" strokeWidth={2} />
    </span>
  );
}

function Board({ columns }) {
  if (columns.length === 0) {
    return (
      <Centered>
        No columns. Add headings like
        <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-[12px]">## Backlog</code>
        and tasks as
        <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-[12px]">### Title</code>.
      </Centered>
    );
  }
  return (
    <div className="flex h-full gap-5 overflow-x-auto px-6 pt-2">
      {columns.map((col, i) => <Column key={i} column={col} />)}
    </div>
  );
}

function Column({ column }) {
  const isDone = /^done$/i.test(column.name.trim());
  return (
    <div className="flex w-[300px] shrink-0 flex-col gap-3">
      <div className="flex items-center gap-2 px-1">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
          {column.name}
        </h3>
        <span className="rounded-full bg-muted/55 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground/75">
          {column.cards.length}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {column.cards.map((card, i) => <Card key={i} card={card} done={isDone} />)}
        {column.cards.length === 0 && (
          <div className="rounded-xl border border-dashed border-border/40 bg-muted/10 px-3.5 py-3 text-[12px] italic text-muted-foreground/55">
            No tasks
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ card, done }) {
  return (
    <div className={cn(
      'rounded-xl border border-border/55 bg-card p-3.5 transition-all duration-150',
      'hover:border-foreground/15 hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)]',
      done && 'opacity-70',
    )}>
      <div className={cn(
        'text-[13.5px] font-medium leading-snug',
        done ? 'text-muted-foreground/75 line-through' : 'text-foreground/90',
      )}>
        {card.title}
      </div>

      {card.description && (
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted-foreground/80">
          {card.description}
        </p>
      )}

      {(card.owner || card.priority || card.deadline) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {card.deadline && (
            <span className={metaPillClass + ' tabular-nums'}>
              <Calendar className="size-[12px] text-muted-foreground/60" strokeWidth={1.75} />
              {card.deadline}
            </span>
          )}
          {card.owner && (
            <span className={metaPillClass}>
              <CircleUserRound className="size-[13px] text-muted-foreground/60" strokeWidth={1.75} />
              {card.owner}
            </span>
          )}
          {card.priority && (
            <span className={cn(metaPillClass, 'ml-auto')}>
              <PriorityChip value={card.priority} />
              {card.priority}
            </span>
          )}
        </div>
      )}

      {card.completed && (
        <div className="mt-3 inline-flex items-center gap-1 text-[11px] text-muted-foreground/60">
          <CheckCircle2 className="size-3" strokeWidth={2} />
          {card.completed}
        </div>
      )}
    </div>
  );
}

// Soft pill shared across the meta row on Board cards. Outline-only — a
// hairline ring with no fill keeps three pills in a row from competing with
// the task title or description.
const metaPillClass =
  'inline-flex items-center gap-1 rounded-[3px] px-1.5 py-0.5 text-[11px] text-muted-foreground/85 ring-1 ring-inset ring-border/50';

// Priority — bare icon: arrow up (high), dash (medium), arrow down (low).
const PRIORITY_STYLE = {
  high:   { icon: ArrowUp },
  medium: { icon: Minus },
  low:    { icon: ArrowDown },
};


function Centered({ children, error }) {
  return (
    <div className={cn(
      'flex h-full items-center justify-center text-sm',
      error ? 'text-destructive' : 'text-muted-foreground/70',
    )}>
      {children}
    </div>
  );
}

function TasksEmptyState() {
  const branding = useBranding();
  const botName = branding.botDisplayName || 'Assistant';
  return (
    <div className="flex h-full items-center justify-center px-6 py-16">
      <div className="flex max-w-[320px] flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground/50">
          <KanbanSquare className="size-6" strokeWidth={1.75} />
        </div>
        <h2 className="text-[14px] font-semibold tracking-tight text-foreground/85">No tasks yet</h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground/75">
          If you ask <span className="font-medium text-foreground/85">{botName}</span> to save a task for you, it will appear here. You can also always ask <span className="font-medium text-foreground/85">{botName}</span> about your tasks in chat.
        </p>
      </div>
    </div>
  );
}

/* ─── Parser ──────────────────────────────────────────────────────────── */

/**
 * Parse Tasks.md (per the task-management skill format) into columns of cards.
 *
 * Rules:
 *   `## Heading`     — start a new column, reset current card.
 *   `### Heading`    — start a new card under the current column.
 *   `**Key:** Value` lines (separated by ` · `) — populate Owner/Priority/
 *                     Deadline/Completed metadata for the current card.
 *   anything else    — appended to the current card's description, with
 *                     leading/trailing blank lines collapsed.
 *
 * Content above the first `##` (e.g. a top-level `# Tasks` title) is ignored.
 */
function parseKanban(md) {
  if (!md) return [];
  const columns = [];
  let column = null;
  let card   = null;
  // descLines accumulates plain lines for the current card; we trim/join on flush.
  let descLines = [];

  const flushCard = () => {
    if (!card) return;
    card.description = descLines.join('\n').replace(/^\s+|\s+$/g, '');
    descLines = [];
  };

  for (const rawLine of md.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');

    const colMatch = /^##\s+(.+)/.exec(line);
    if (colMatch) {
      flushCard();
      card = null;
      column = { name: colMatch[1].trim(), cards: [] };
      columns.push(column);
      continue;
    }

    if (!column) continue;  // skip preamble before first column

    const cardMatch = /^###\s+(.+)/.exec(line);
    if (cardMatch) {
      flushCard();
      card = { title: cardMatch[1].trim() };
      column.cards.push(card);
      continue;
    }

    if (!card) continue;  // text inside a column but before any card — skip

    // Metadata line: contains one or more `**Key:** Value` chunks.
    const fields = parseMetadataLine(line);
    if (fields) {
      Object.assign(card, fields);
      continue;
    }

    // Plain content → description. Skip leading blank lines but keep mid-paragraph ones.
    if (line === '' && descLines.length === 0) continue;
    descLines.push(line);
  }
  flushCard();
  return columns;
}

const KEY_TO_FIELD = {
  owner:     'owner',
  priority:  'priority',
  deadline:  'deadline',
  completed: 'completed',
};

/**
 * Parse a metadata line like
 *   **Owner:** Alex · **Priority:** High · **Deadline:** 2026-05-02
 * Returns an object with keys from KEY_TO_FIELD, or null if the line doesn't
 * look like metadata.
 */
function parseMetadataLine(line) {
  // Quick reject: must contain at least one `**Key:**` token.
  if (!/\*\*[A-Za-z]+:\*\*/.test(line)) return null;
  const out = {};
  let any = false;
  // Each chunk: `**Key:** Value`. Allow chunks to be separated by ` · ` or `,`
  // or newline-trimmed extra whitespace; metadata typically all on one line.
  const re = /\*\*([A-Za-z]+):\*\*\s*([^*·]+?)(?=\s*(?:·|\*\*|$))/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (KEY_TO_FIELD[key] && val) {
      out[KEY_TO_FIELD[key]] = val;
      any = true;
    }
  }
  return any ? out : null;
}

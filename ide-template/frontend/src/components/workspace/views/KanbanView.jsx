import { useState, useEffect, useMemo, useCallback, createContext, useContext } from 'react';
import { KanbanSquare, CircleUserRound, Calendar, CheckCircle2, Columns3, List as ListIcon, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import { useBranding } from '../identity.jsx';
import { useApi } from '@/lib/useApi';
import { Skeleton } from '@/components/ui/Skeleton';

const VIEW_MODE_KEY = 'tasks-view-mode';

// Board columns, in display order. `key` matches a task's `status`.
const TASK_COLUMNS = [
  { key: 'in_progress', name: 'In Progress' },
  { key: 'backlog',     name: 'Backlog' },
  { key: 'done',        name: 'Done' },
];

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
// slug → { name, avatar } for resolving a task's Owner to a teammate's profile.
const PeopleContext = createContext({});

export default function KanbanView({ path, fileEventNonce, sidebarOpen }) {
  const { data, loading, error, reload } = useApi('/api/tasks');

  // Local optimistic copy of the structured task list, synced from the API.
  // Mutations (drag-drop, check→done) update this immediately, then PATCH.
  const [tasks, setTasks] = useState(null);
  useEffect(() => { if (data?.tasks) setTasks(data.tasks); }, [data]);

  // slug → { name, avatar } for assignee avatars (comes with the task list).
  const people = useMemo(() => data?.people || {}, [data]);

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

  // Optimistic field update → PATCH /api/tasks/:id. On failure, reload truth.
  const patchTask = useCallback(async (id, patch) => {
    setTasks(prev => (prev ? prev.map(t => (t.id === id ? { ...t, ...patch } : t)) : prev));
    try {
      const r = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      reload();   // revert to server truth
    }
  }, [reload]);

  const columns = useMemo(() => {
    const list = tasks || [];
    return TASK_COLUMNS.map(c => ({
      key: c.key,
      name: c.name,
      cards: list.filter(t => t.status === c.key).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    }));
  }, [tasks]);

  const isInitialLoad = loading && !data;
  const isEmpty = tasks && tasks.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader
        icon={KanbanSquare}
        title="Tasks"
        meta={<ViewToggle value={viewMode} onChange={setViewMode} />}
        sidebarOpen={sidebarOpen}
      />
      <div className="flex-1 overflow-auto">
        {isInitialLoad && (
          <div className="h-full pb-6 pt-2">
            {viewMode === 'list' ? <ListSkeleton /> : <BoardSkeleton />}
          </div>
        )}
        {error && !data && <Centered error>Error: {error}</Centered>}
        {!isInitialLoad && isEmpty && <TasksEmptyState />}
        {!isInitialLoad && tasks && !isEmpty && (
          <PeopleContext.Provider value={people}>
            <div className="h-full pb-6 pt-2">
              {viewMode === 'list'
                ? <ListView columns={columns} onPatch={patchTask} />
                : <Board columns={columns} onPatch={patchTask} />}
            </div>
          </PeopleContext.Provider>
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

function ListView({ columns, onPatch }) {
  // Drop onto a section → move the task there, appended to the end.
  const onDropTask = (id, status, cards) => onPatch(id, { status, order: cards.length });
  return (
    <div className="flex w-full flex-col gap-7 px-6 pt-2">
      {columns.map((col) => (
        <ListSection key={col.key} column={col} onPatch={onPatch} onDropTask={onDropTask} />
      ))}
    </div>
  );
}

function ListSection({ column, onPatch, onDropTask }) {
  const isDone = column.key === 'done';
  const [over, setOver] = useState(false);
  return (
    <section
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!over) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData('text/plain');
        if (id) onDropTask(id, column.key, column.cards);
      }}
      className={cn(
        'flex flex-col gap-2 rounded-xl p-1 -m-1 transition-colors',
        over && 'bg-foreground/[0.04] ring-1 ring-inset ring-foreground/20',
      )}
    >
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
          {over ? 'Drop here' : 'No tasks'}
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {column.cards.map((card) => (
            <ListRow key={card.id} card={card} done={isDone} onPatch={onPatch} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ListRow({ card, done, onPatch }) {
  return (
    <li
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', card.id); e.dataTransfer.effectAllowed = 'move'; }}
      className={cn(
        'group flex cursor-grab items-center gap-3 rounded-xl border border-border/55 bg-card px-4 py-3 transition-all duration-150 active:cursor-grabbing',
        'hover:border-foreground/15 hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)]',
        done && 'opacity-70',
      )}
    >
      <button
        type="button"
        onClick={() => onPatch?.(card.id, { status: done ? 'backlog' : 'done' })}
        title={done ? 'Move back to Backlog' : 'Mark done'}
        aria-label={done ? 'Move back to Backlog' : 'Mark done'}
        className="shrink-0 rounded-full outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-foreground/20"
      >
        {done ? (
          <CheckCircle2 className="size-[16px] text-emerald-600/80 dark:text-emerald-400/80" strokeWidth={2} />
        ) : (
          <span className="block size-[16px] rounded-full ring-[1.5px] ring-border/60 transition-colors hover:ring-emerald-500/60" aria-hidden />
        )}
      </button>
      <span className={cn(
        'min-w-0 flex-1 truncate text-[13.5px] leading-snug',
        done ? 'font-medium text-muted-foreground/75 line-through' : 'font-medium text-foreground/90',
      )}>
        {card.title}
      </span>
      <span className="flex shrink-0 items-center gap-2.5">
        <ListAssignee owner={card.owner} />
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

// ─── Loading skeletons (match the board / list layouts) ──────────────────────

const SKELETON_COLS = [
  { name: 'In Progress', n: 2 },
  { name: 'Backlog', n: 3 },
  { name: 'Done', n: 1 },
];

function BoardSkeleton() {
  return (
    <div className="flex h-full gap-5 overflow-x-auto px-6 pt-2">
      {SKELETON_COLS.map((col) => (
        <div key={col.name} className="flex w-[300px] shrink-0 flex-col gap-3">
          <div className="flex items-center gap-2 px-1">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-4 w-5 rounded-full" />
          </div>
          <div className="flex flex-col gap-2">
            {Array.from({ length: col.n }, (_, i) => <CardSkeleton key={i} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="rounded-xl border border-border/55 bg-card p-3.5">
      <Skeleton className="h-3.5 w-3/4" />
      <Skeleton className="mt-2 h-3 w-full" />
      <Skeleton className="mt-1.5 h-3 w-2/3" />
      <div className="mt-3 flex items-center gap-1.5">
        <Skeleton className="h-5 w-16 rounded-[3px]" />
        <Skeleton className="h-5 w-14 rounded-[3px]" />
        <Skeleton className="ml-auto h-5 w-12 rounded-[3px]" />
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex w-full flex-col gap-7 px-6 pt-2">
      {SKELETON_COLS.map((col) => (
        <section key={col.name} className="flex flex-col gap-2">
          <div className="flex items-center gap-2 px-1">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-4 w-5 rounded-full" />
          </div>
          <ul className="flex flex-col gap-1.5">
            {Array.from({ length: col.n }, (_, i) => (
              <li key={i} className="flex items-center gap-3 rounded-xl border border-border/55 bg-card px-4 py-3">
                <Skeleton className="size-[16px] shrink-0 rounded-full" />
                <Skeleton className="h-3.5 w-1/2" />
                <span className="ml-auto flex items-center gap-2.5">
                  <Skeleton className="size-[18px] rounded-full" />
                  <Skeleton className="h-3 w-16" />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Board({ columns, onPatch }) {
  // Drop onto a column → move the task there, appended to the end.
  const onDropTask = (taskId, status, targetCards) => {
    onPatch(taskId, { status, order: targetCards.length });
  };
  return (
    <div className="flex h-full gap-5 overflow-x-auto px-6 pt-2">
      {columns.map((col) => <Column key={col.key} column={col} onDropTask={onDropTask} />)}
    </div>
  );
}

function Column({ column, onDropTask }) {
  const isDone = column.key === 'done';
  const [over, setOver] = useState(false);
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
      <div
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!over) setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const id = e.dataTransfer.getData('text/plain');
          if (id) onDropTask(id, column.key, column.cards);
        }}
        className={cn(
          'flex min-h-[64px] flex-col gap-2 rounded-xl p-1 -m-1 transition-colors',
          over && 'bg-foreground/[0.04] ring-1 ring-inset ring-foreground/20',
        )}
      >
        {column.cards.map((card) => <Card key={card.id} card={card} done={isDone} />)}
        {column.cards.length === 0 && (
          <div className="rounded-xl border border-dashed border-border/40 bg-muted/10 px-3.5 py-3 text-[12px] italic text-muted-foreground/55">
            {over ? 'Drop here' : 'No tasks'}
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ card, done }) {
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', card.id); e.dataTransfer.effectAllowed = 'move'; }}
      className={cn(
        'cursor-grab rounded-xl border border-border/55 bg-card p-3.5 transition-all duration-150 active:cursor-grabbing',
        'hover:border-foreground/15 hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)]',
        done && 'opacity-70',
      )}
    >
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
          <Assignee owner={card.owner} />
          {card.priority && (
            <span className={cn(metaPillClass, 'ml-auto')}>
              <PriorityChip value={card.priority} />
              {card.priority}
            </span>
          )}
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

// Task assignee. An Owner value matching a roster slug renders as that
// teammate's avatar + name; otherwise it's shown as plain text (solo workspace
// or a free-text owner). Renders nothing when there's no owner.
function Assignee({ owner }) {
  const people = useContext(PeopleContext);
  if (!owner) return null;
  const person = people[owner.trim().toLowerCase()];
  if (person) {
    return (
      <span className={metaPillClass} title={`Assigned to ${person.name}`}>
        <TaskAvatar name={person.name} avatar={person.avatar} />
        {person.name}
      </span>
    );
  }
  return (
    <span className={metaPillClass}>
      <CircleUserRound className="size-[13px] text-muted-foreground/60" strokeWidth={1.75} />
      {owner}
    </span>
  );
}

// Compact assignee for the dense list rows — avatar only (with a tooltip), or
// nothing when unassigned / owner isn't a known teammate.
function ListAssignee({ owner }) {
  const people = useContext(PeopleContext);
  if (!owner) return null;
  const person = people[owner.trim().toLowerCase()];
  if (!person) return null;
  return (
    <span title={`Assigned to ${person.name}`}>
      <TaskAvatar name={person.name} avatar={person.avatar} className="size-[18px] text-[9px]" />
    </span>
  );
}

// Small circular profile picture with an initial fallback.
function TaskAvatar({ name, avatar, className }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  return (
    <span className={cn(
      'flex size-[15px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[8px] font-semibold text-muted-foreground/90 ring-1 ring-border/55',
      className,
    )}>
      {avatar
        ? <img src={avatar} alt="" className="size-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
        : initial}
    </span>
  );
}

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

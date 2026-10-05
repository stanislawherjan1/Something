import { useState, useEffect, useMemo, useCallback, createContext, useContext } from 'react';
import { KanbanSquare, CircleUserRound, Calendar, CheckCircle2, Columns3, List as ListIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import PersonInitial from '../PersonInitial.jsx';
import { useBranding } from '../identity.jsx';
import { useApi } from '@/lib/useApi';
import { Skeleton } from '@/components/ui/Skeleton';

const VIEW_MODE_KEY = 'tasks-view-mode';

// Board columns, in display order. `key` matches a task's `status`.
const TASK_COLUMNS = [
  { key: 'backlog',     name: 'Backlog' },
  { key: 'in_progress', name: 'In Progress' },
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
  // Who a task is assigned to only means something with teammates: solo, the
  // owner column is hidden (the data stays, and shows again with team mode).
  const teamMode = !!data?.teamMode;

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
          <PeopleContext.Provider value={teamMode ? people : null}>
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
    <div role="group" aria-label="View" className="flex items-center gap-0.5 rounded-[6px] border border-border/55 bg-muted/40 p-0.5">
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
        'inline-flex items-center gap-1 rounded-[5px] px-2.5 py-1 text-[12px] font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.05)]'
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
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData('text/plain');
        if (id) onDropTask(id, column.key, column.cards);
      }}
      className={cn(
        'flex flex-col gap-2 rounded-[6px] p-2.5 -m-2.5 transition-colors',
        over && 'outline-dashed outline-1 -outline-offset-1 outline-foreground/35',
      )}
    >
      <div className="flex items-center gap-2 px-1">
        <h3 className="text-[13.5px] font-semibold leading-snug text-foreground/90">
          {column.name}
        </h3>
        <span className="text-[12px] tabular-nums text-muted-foreground/55">{column.cards.length}</span>
      </div>
      {column.cards.length === 0 ? (
        <div className="border-y border-border/60 px-2 py-3 text-[12.5px] text-muted-foreground/55">
          {over ? 'Drop here' : 'Nothing here'}
        </div>
      ) : (
        <ul className="divide-y divide-border/60 border-y border-border/60">
          {column.cards.map((card) => (
            <ListRow key={card.id} card={card} done={isDone} onPatch={onPatch} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ListRow({ card, done, onPatch }) {
  const [dragging, setDragging] = useState(false);
  const showOwner = !!useContext(PeopleContext);
  return (
    <li
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', card.id); e.dataTransfer.effectAllowed = 'move'; setDragging(true); }}
      onDragEnd={() => setDragging(false)}
      className={cn(
        'group flex cursor-grab items-center gap-3 px-2 py-3 transition-colors duration-150 active:cursor-grabbing',
        'hover:bg-muted/30',
        done && 'opacity-70',
        dragging && 'opacity-40',
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
          <span className="block size-[16px] rounded-full ring-[1.5px] ring-foreground/25 transition-colors hover:ring-foreground/60" aria-hidden />
        )}
      </button>
      <span className={cn(
        'min-w-0 flex-1 truncate text-[14px] leading-snug',
        done ? 'text-muted-foreground/70 line-through' : 'text-foreground/90',
      )}>
        {card.title}
      </span>
      {/* Fixed-width cells so owners, dates and tags line up from row to row. */}
      <span className="flex shrink-0 items-center gap-3 text-[12px] text-muted-foreground/75">
        {showOwner && <span className="w-[76px] truncate"><Assignee owner={card.owner} /></span>}
        <span className="w-[60px]">
          {card.deadline && (
            <span className="inline-flex items-center gap-1 text-[11.5px] tabular-nums">
              <Calendar className="size-[12px]" strokeWidth={1.75} />
              {shortDeadline(card.deadline)}
            </span>
          )}
        </span>
        <span className="flex w-[38px] justify-end">{card.priority && <PriorityChip value={card.priority} />}</span>
      </span>
    </li>
  );
}

function PriorityChip({ value }) {
  const key = value.trim().toLowerCase();
  if (key !== 'high' && key !== 'low') return null;   // medium is the default — no tag
  return (
    <span
      aria-label={`Priority: ${value}`}
      className={cn(
        'inline-flex items-center rounded-[5px] px-1.5 py-px text-[11px] font-medium leading-[18px] ring-1 ring-inset',
        key === 'high' ? 'text-foreground/85 ring-foreground/25' : 'text-muted-foreground/70 ring-foreground/[0.1]',
      )}
    >
      {key === 'high' ? 'High' : 'Low'}
    </span>
  );
}

// ─── Loading skeletons (match the board / list layouts) ──────────────────────

const SKELETON_COLS = [
  { name: 'Backlog', n: 3 },
  { name: 'In Progress', n: 2 },
  { name: 'Done', n: 1 },
];

function BoardSkeleton() {
  return (
    <div className="flex h-full gap-5 overflow-x-auto px-6 pt-2">
      {SKELETON_COLS.map((col) => (
        <div key={col.name} className="flex min-w-[260px] max-w-[360px] flex-1 flex-col gap-3">
          <div className="flex items-center gap-2 px-1">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-3 w-4" />
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
    <div className="rounded-[6px] border border-border/60 p-3.5">
      <Skeleton className="h-3.5 w-3/4" />
      <Skeleton className="mt-2 h-3 w-full" />
      <Skeleton className="mt-1.5 h-3 w-2/3" />
      <div className="mt-3 flex items-center gap-2.5">
        <Skeleton className="size-4 rounded-full" />
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-[18px] w-10 rounded-[5px]" />
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
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-3 w-4" />
          </div>
          <ul className="flex flex-col divide-y divide-border/60 border-y border-border/60">
            {Array.from({ length: col.n }, (_, i) => (
              <li key={i} className="flex items-center gap-3 px-2 py-3">
                <Skeleton className="size-[16px] shrink-0 rounded-full" />
                <Skeleton className="h-3.5 w-1/2" />
                <span className="ml-auto flex items-center gap-3">
                  <Skeleton className="size-4 rounded-full" />
                  <Skeleton className="h-3 w-14" />
                  <Skeleton className="h-3 w-12" />
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
    <div className="flex h-full gap-5 overflow-x-auto px-6 pt-2 after:w-1 after:shrink-0 after:content-['']">
      {columns.map((col) => <Column key={col.key} column={col} onDropTask={onDropTask} />)}
    </div>
  );
}

function Column({ column, onDropTask }) {
  const isDone = column.key === 'done';
  const [over, setOver] = useState(false);
  return (
    <div className="flex min-w-[260px] max-w-[360px] flex-1 flex-col gap-3">
      <div className="flex items-center gap-2 px-1">
        <h3 className="text-[13.5px] font-semibold leading-snug text-foreground/90">
          {column.name}
        </h3>
        <span className="text-[12px] tabular-nums text-muted-foreground/55">{column.cards.length}</span>
      </div>
      <div
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!over) setOver(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const id = e.dataTransfer.getData('text/plain');
          if (id) onDropTask(id, column.key, column.cards);
        }}
        className={cn(
          'flex min-h-[64px] flex-col gap-2 rounded-[6px] p-1 -m-1 transition-colors',
          over && 'outline-dashed outline-1 -outline-offset-1 outline-foreground/35',
        )}
      >
        {column.cards.map((card) => <Card key={card.id} card={card} done={isDone} />)}
        {column.cards.length === 0 && (
          <div className="rounded-[6px] border border-dashed border-border/70 px-3.5 py-3 text-[12px] text-muted-foreground/55">
            {over ? 'Drop here' : 'No tasks'}
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ card, done }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', card.id); e.dataTransfer.effectAllowed = 'move'; setDragging(true); }}
      onDragEnd={() => setDragging(false)}
      className={cn(
        'cursor-grab rounded-[6px] border border-border/55 bg-card p-3.5 transition-all duration-150 active:cursor-grabbing',
        'hover:border-foreground/15 hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)]',
        done && 'opacity-70',
        dragging && 'opacity-40',
      )}
    >
      <div className={cn(
        'text-[14px] leading-snug',
        done ? 'text-muted-foreground/70 line-through' : 'text-foreground/90',
      )}>
        {card.title}
      </div>

      {card.description && (
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted-foreground/80">
          {card.description}
        </p>
      )}

      {(card.owner || card.priority || card.deadline) && (
        <div className="mt-3 flex items-center gap-2.5 text-[11.5px] text-muted-foreground/75">
          <Assignee owner={card.owner} />
          {card.deadline && (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Calendar className="size-[12px]" strokeWidth={1.75} />
              {shortDeadline(card.deadline)}
            </span>
          )}
          {card.priority && <PriorityChip value={card.priority} />}
        </div>
      )}

    </div>
  );
}


// Task assignee. An Owner value matching a roster slug renders as that
// teammate's avatar + name; otherwise it's shown as plain text (solo workspace
// or a free-text owner). Renders nothing when there's no owner.
function Assignee({ owner }) {
  const people = useContext(PeopleContext);
  if (!owner || !people) return null;   // solo workspace: no owner shown
  const person = people[owner.trim().toLowerCase()];
  if (person) {
    return (
      <span className="inline-flex items-center gap-1.5" title={`Assigned to ${person.name}`}>
        <TaskAvatar name={person.name} avatar={person.avatar} className="size-[16px] text-[8.5px]" />
        {person.name}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <CircleUserRound className="size-[13px]" strokeWidth={1.75} />
      {owner}
    </span>
  );
}

// Small circular profile picture; the ink-on-paper initial when there is none
// or it fails to load.
function TaskAvatar({ name, avatar, className }) {
  const [failed, setFailed] = useState(false);
  if (!avatar || failed) return <PersonInitial initial={name} className={className} />;
  return (
    <span className={cn('flex shrink-0 overflow-hidden rounded-full ring-1 ring-border/55', className)}>
      <img src={avatar} alt="" className="size-full object-cover" onError={() => setFailed(true)} />
    </span>
  );
}

// A deadline as "10 Jul" (and the year only when it is not this one); anything
// that is not an ISO date is shown as written.
function shortDeadline(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return value;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}



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

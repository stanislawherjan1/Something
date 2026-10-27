import { useState, useEffect, useMemo, useCallback, createContext, useContext } from 'react';
import { KanbanSquare, CircleUserRound, Calendar, CheckCircle2, Columns3, List as ListIcon, Brain, UserRound, UsersRound, Check, ChevronDown, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import PersonInitial from '../PersonInitial.jsx';
import { useBranding } from '../identity.jsx';
import { useApi } from '@/lib/useApi';
import { Skeleton } from '@/components/ui/Skeleton';

const VIEW_MODE_KEY = 'tasks-view-mode';
const ONLY_MINE_KEY = 'tasks-only-mine';

// Board columns, in display order. `key` matches a task's `status`.
export const TASK_COLUMNS = [
  { key: 'backlog',     name: 'Backlog' },
  { key: 'in_progress', name: 'In Progress' },
  { key: 'done',        name: 'Done' },
];

/**
 * KanbanView — the task board, from /api/tasks (see the task-management skill
 * in ide-template/skills/default/task-management/SKILL.md).
 *
 * Two lists, one board. In team mode a task is on the team board (everyone's)
 * or on the person's own list (`scope: 'user:<slug>'`, a file in their private
 * tree that only they get back from the API). Own tasks sit in the columns
 * like any other and are assigned like any other (to the person); the list
 * and the board do not say who sees a task — a task opened does, with the
 * switch that puts an own task on the team board (the bot takes a task back
 * to a person's list on request). A drag changes a task's column, never its
 * list (the API numbers each list's columns separately). Solo has one list
 * and shows none of this.
 */
// slug → { name, avatar } for resolving a task's Owner to a teammate's profile.
export const PeopleContext = createContext({});
// Who is looking (their roster slug), for "this task is mine to take".
const MeContext = createContext(null);
const isOwn = (t) => /^user:/.test(t?.scope || '');

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

  // "Mine" in the header narrows the board to the tasks assigned to the person,
  // whoever sees them. Team mode only; remembered per device like the view mode.
  const [onlyMine, setOnlyMine] = useState(() => {
    try { return localStorage.getItem(ONLY_MINE_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(ONLY_MINE_KEY, onlyMine ? '1' : '0'); } catch { /* private mode */ }
  }, [onlyMine]);

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

  // A drop changes the column only; the task keeps its list, and its place
  // is the end of that list's part of the column.
  const moveTo = useCallback((id, status) => {
    const list = tasks || [];
    const t = list.find(x => x.id === id);
    const order = list.filter(x => x.status === status && isOwn(x) === isOwn(t)).length;
    patchTask(id, { status, order });
  }, [tasks, patchTask]);

  const me = teamMode ? (data?.me || null) : null;
  const columns = useMemo(() => {
    const all = tasks || [];
    const list = onlyMine && me ? all.filter(t => t.owner === me) : all;
    const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
    return TASK_COLUMNS.map(c => {
      const cards = list.filter(t => t.status === c.key);
      // Each list numbers its own part of the column; own tasks follow the
      // team's, so the two sequences never interleave.
      return { key: c.key, name: c.name, cards: [...cards.filter(t => !isOwn(t)).sort(byOrder), ...cards.filter(isOwn).sort(byOrder)] };
    });
  }, [tasks, onlyMine, me]);

  // The task whose details are open (a click on a row or a card). Read from
  // the live list so a change made while it is open shows in it.
  const [openId, setOpenId] = useState(null);
  const openTask = useMemo(() => (tasks || []).find(t => t.id === openId) || null, [tasks, openId]);

  const isInitialLoad = loading && !data;
  const isEmpty = tasks && tasks.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader
        icon={KanbanSquare}
        title="Tasks"
        meta={(
          <div className="flex items-center gap-2">
            {me && <MineToggle active={onlyMine} onChange={setOnlyMine} />}
            <ViewToggle value={viewMode} onChange={setViewMode} />
          </div>
        )}
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
            <MeContext.Provider value={me}>
              <TooltipPrimitive.Provider delayDuration={200} skipDelayDuration={400}>
                <div className="h-full pb-6 pt-2">
                  {viewMode === 'list'
                    ? <ListView columns={columns} onPatch={patchTask} onMove={moveTo} onOpen={setOpenId} />
                    : <Board columns={columns} onMove={moveTo} onOpen={setOpenId} />}
                </div>
                <TaskDialog task={openTask} onClose={() => setOpenId(null)} onPatch={patchTask} />
              </TooltipPrimitive.Provider>
            </MeContext.Provider>
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

// Only the tasks assigned to me — not "only the ones I see", which is the
// visibility icon's job. A plain checkbox in the page's own tones (the Memory
// screen's Tick) with its label.
function MineToggle({ active, onChange }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={active}
      onClick={() => onChange(!active)}
      className="group/mine inline-flex h-[30px] items-center gap-2 rounded-[6px] px-1.5 text-[12px] leading-none text-muted-foreground/80 transition-colors hover:text-foreground/90"
    >
      <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
        active ? 'border-foreground/80 bg-foreground text-background' : 'border-border bg-transparent group-hover/mine:border-foreground/40')}>
        {active && <Check className="size-3" strokeWidth={3} />}
      </span>
      Show only my tasks
    </button>
  );
}

// One task, opened. What matters most comes first and gets the room: the
// title, then the description — the brief the row and the card leave out.
// Between them one quiet line of the work's state: the column (a menu, to
// move it), who does it, when, how urgent, who sees it. The rest is a footer:
// the memory fact it came from, when it was added and by whom.
/**
 * A task's fact, the way the Memory screen shows a fact's task (TaskOfFact):
 * a card with the title and, as a tag, whose memory it is in. Someone else's
 * private fact shows that there is one and nothing of what it says.
 */
function FactOfTask({ fact, onOpen }) {
  const scope = fact.private ? 'private' : fact.scope === 'shared' ? 'shared' : /^group:/.test(fact.scope || '') ? 'group' : 'private';
  const tag = { private: ['Private', UserRound], shared: ['Shared', UsersRound], group: ['Group', UsersRound] }[scope];
  const Tag = tag[1];
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className={cn('text-[14px] leading-snug', fact.private ? 'text-muted-foreground/60' : 'text-foreground/90')}>{fact.private ? "Someone's private memory" : fact.title}</span>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-[5px] px-1.5 py-px text-[11px] font-medium leading-[18px] text-muted-foreground/70 ring-1 ring-inset ring-foreground/[0.1]"><Tag className="size-2.5" strokeWidth={2.25} />{tag[0]}</span>
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-[11.5px] text-muted-foreground/75">
        <Brain className="size-[12px]" strokeWidth={1.75} />
        From memory
      </div>
    </>
  );
  const cls = 'block w-full rounded-[6px] border border-border/55 bg-card p-3.5 text-left ';
  if (!onOpen) return <div className={cn(cls, 'opacity-80')}>{body}</div>;
  return <button type="button" onClick={onOpen} className={cn(cls, 'transition-all duration-150 hover:border-foreground/15 hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)]')}>{body}</button>;
}

const EYEBROW = 'text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60';
function Field({ label, children }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className={EYEBROW}>{label}</div>
      <div className="flex min-h-[20px] min-w-0 items-center gap-1.5 leading-none">{children}</div>
    </div>
  );
}
function TaskDialog({ task, onClose, onPatch }) {
  const navigate = useNavigate();
  const me = useContext(MeContext);
  const people = useContext(PeopleContext);
  const createdBy = task?.createdBy ? (people?.[task.createdBy]?.name || task.createdBy) : null;
  return (
    <Dialog open={!!task} onOpenChange={(o) => { if (!o) onClose(); }}>
      {task && (
        <DialogContent className="gap-0 p-0 sm:max-w-2xl">
          <div className="px-8 pt-8">
            <DialogHeader>
              <DialogTitle className="pr-8 text-[20px] font-bold leading-snug tracking-tight">{task.title}</DialogTitle>
            </DialogHeader>
          </div>
          {/* Two columns: the description first, the work's state beside it. */}
          <div className="grid gap-10 px-8 pb-8 pt-6 sm:grid-cols-[1fr_200px]">
            <div className="flex min-w-0 flex-col gap-4">
              {/* The work's state, under the title: the column (a menu) and who does it. */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] leading-none text-muted-foreground/80">
                <StatusMenu value={task.status} onChange={(status) => onPatch?.(task.id, { status })} />
                {people && (task.owner ? <Assignee owner={task.owner} /> : <span className="text-muted-foreground/50">Unassigned</span>)}
              </div>
              {task.description ? (
                <p className="mt-3 whitespace-pre-wrap text-[14px] leading-relaxed text-foreground/90">{task.description}</p>
              ) : (
                <p className="mt-3 text-[13px] text-muted-foreground/55">No description yet.</p>
              )}
              {/* Where the task came from: the memory fact it is linked to, the
                  way the Memory screen shows a fact's task — a card, a click away. */}
              {(task.fact?.title || task.fact?.private) && <div className="mt-auto pt-6"><FactOfTask fact={task.fact} onOpen={task.fact.title ? () => { onClose(); navigate(`/memory?tab=facts&q=${encodeURIComponent(task.fact.title)}`); } : null} /></div>}
            </div>
            <div className="flex flex-col gap-5 text-[12.5px] text-foreground/85 sm:border-l sm:border-border/50 sm:pl-8">
              <Field label="Priority">
                {task.priority ? <PriorityChip value={task.priority} showMedium /> : <span className="text-muted-foreground/50">None</span>}
              </Field>
              <Field label="Deadline">
                {task.deadline ? <><Calendar className="size-[13px] text-muted-foreground/75" strokeWidth={1.75} /><span className="tabular-nums">{shortDeadline(task.deadline)}</span></> : <span className="text-muted-foreground/50">None</span>}
              </Field>
              {me && (
                <Field label="Visibility">
                  <Visibility card={task} onPatch={onPatch} />
                  <span>{isOwn(task) ? 'Only you' : 'Whole team'}</span>
                </Field>
              )}
              {task.createdAt && (
                <Field label="Added">
                  <span className="tabular-nums">{shortDeadline(String(task.createdAt).slice(0, 10))}</span>
                  {createdBy && <span className="text-muted-foreground/60">by {createdBy}</span>}
                </Field>
              )}
              {task.completed && <Field label="Done"><span className="tabular-nums">{shortDeadline(task.completed)}</span></Field>}
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

// The column a task is in, as one of our dropdowns (the Integrations screen's
// Pick, in the row's size): pick another column to move the task.
function StatusMenu({ value, onChange }) {
  const current = TASK_COLUMNS.find(c => c.key === value)?.name || value;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="inline-flex min-w-[9.5rem] items-center justify-between gap-2 rounded border border-border/60 bg-background px-3 py-1.5 text-[13px] leading-none text-foreground outline-none transition-all focus-visible:border-foreground/60 focus-visible:ring-2 focus-visible:ring-foreground/10 data-[state=open]:border-foreground/60">
          <span>{current}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/70" />
        </button>
      </DropdownMenuTrigger>
      {/* As wide as its trigger, the same size of type: one control, open or shut. */}
      <DropdownMenuContent align="start" sideOffset={4} className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-0 rounded p-1">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {TASK_COLUMNS.map(c => <DropdownMenuRadioItem key={c.key} value={c.key} className="rounded-[3px] py-1.5 text-[13px] whitespace-nowrap">{c.name}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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

function ListView({ columns, onPatch, onMove, onOpen }) {
  return (
    <div className="flex w-full flex-col gap-7 px-6 pt-2">
      {columns.map((col) => (
        <ListSection key={col.key} column={col} onPatch={onPatch} onDropTask={onMove} onOpen={onOpen} />
      ))}
    </div>
  );
}

function ListSection({ column, onPatch, onDropTask, onOpen }) {
  const isDone = column.key === 'done';
  const [over, setOver] = useState(false);
  const row = (card) => <ListRow key={card.id} card={card} done={isDone} onPatch={onPatch} onOpen={onOpen} />;
  return (
    <section
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!over) setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData('text/plain');
        if (id) onDropTask(id, column.key);
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
          {column.cards.map(row)}
        </ul>
      )}
    </section>
  );
}

// A card is its title and one line of facts; the description stays in the
// task (the bot reads it) and is not laid out on the board.
// A small tooltip, the same one the Reminders screen uses.
function Tip({ label, children, side = 'top' }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={10}
          className="z-50 max-w-[18rem] rounded-[6px] border border-border/60 bg-popover px-2.5 py-1.5 text-[11.5px] leading-snug text-popover-foreground shadow-md"
        >
          {label}
          <TooltipPrimitive.Arrow className="fill-popover" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

// Who sees a task: one person (only you) or the team — the same icons as the
// sidebar's Team entry and its single-person counterpart. On an own task the
// icon is also the switch that puts it on the team board; a team task shows
// the team icon and nothing to click.
function Visibility({ card, onPatch }) {
  const me = useContext(MeContext);
  if (!me) return null;
  const cls = 'inline-flex items-center rounded-[4px] p-0.5 transition-colors';
  if (isOwn(card)) {
    return (
      <Tip label="Only you see this task. Click to put it on the team board.">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onPatch?.(card.id, { scope: 'shared' }); }}
          aria-label="Only you see this task. Put it on the team board"
          className={cn(cls, 'text-foreground/70 hover:bg-muted hover:text-foreground')}
        >
          <UserRound className="size-[14px]" strokeWidth={1.75} />
        </button>
      </Tip>
    );
  }
  // Who sees it is always said, on every task. A team task stays a team task
  // from here (the bot takes one back on request); the icon alone.
  return (
    <Tip label="The whole team sees this task.">
      <span className={cn(cls, 'text-muted-foreground/40')}>
        <UsersRound className="size-[14px]" strokeWidth={1.75} />
      </span>
    </Tip>
  );
}

function ListRow({ card, done, onPatch, onOpen }) {
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
      {/* The title opens the task's details. */}
      <button
        type="button"
        onClick={() => onOpen?.(card.id)}
        className={cn(
          'min-w-0 flex-1 truncate text-left text-[14px] leading-snug outline-none focus-visible:underline',
          done ? 'text-muted-foreground/70 line-through' : 'text-foreground/90',
        )}
      >
        {card.title}
      </button>
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

// Each priority has its sign: up for high, a dash for medium, down for low.
// The board and the list leave medium out (the default, no tag); a task opened
// shows it (`showMedium`).
const PRIORITY = {
  high:   { label: 'High',   Icon: ArrowUp,   cls: 'text-foreground/85 ring-foreground/25' },
  medium: { label: 'Medium', Icon: Minus,     cls: 'text-muted-foreground/75 ring-foreground/[0.14]' },
  low:    { label: 'Low',    Icon: ArrowDown, cls: 'text-muted-foreground/70 ring-foreground/[0.1]' },
};
export function PriorityChip({ value, showMedium = false, className }) {
  const key = String(value || '').trim().toLowerCase();
  const p = PRIORITY[key];
  if (!p || (key === 'medium' && !showMedium)) return null;
  return (
    <span
      aria-label={`Priority: ${p.label}`}
      className={cn('inline-flex items-center gap-0.5 rounded-[5px] py-px pl-1 pr-1.5 text-[11px] font-medium leading-[18px] ring-1 ring-inset', p.cls, className)}
    >
      <p.Icon className="size-[11px]" strokeWidth={2.25} />
      {p.label}
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

function Board({ columns, onMove, onOpen }) {
  return (
    <div className="flex h-full gap-5 overflow-x-auto px-6 pt-2 after:w-1 after:shrink-0 after:content-['']">
      {columns.map((col) => <Column key={col.key} column={col} onDropTask={onMove} onOpen={onOpen} />)}
    </div>
  );
}

function Column({ column, onDropTask, onOpen }) {
  const isDone = column.key === 'done';
  const [over, setOver] = useState(false);
  const cardOf = (card) => <Card key={card.id} card={card} done={isDone} onOpen={onOpen} />;
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
          if (id) onDropTask(id, column.key);
        }}
        className={cn(
          'flex min-h-[64px] flex-col gap-2 rounded-[6px] p-1 -m-1 transition-colors',
          over && 'outline-dashed outline-1 -outline-offset-1 outline-foreground/35',
        )}
      >
        {column.cards.map(cardOf)}
        {column.cards.length === 0 && (
          <div className="rounded-[6px] border border-dashed border-border/70 px-3.5 py-3 text-[12px] text-muted-foreground/55">
            {over ? 'Drop here' : 'No tasks'}
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ card, done, onOpen }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      draggable
      onClick={(e) => { if (!e.target.closest('button')) onOpen?.(card.id); }}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', card.id); e.dataTransfer.effectAllowed = 'move'; setDragging(true); }}
      onDragEnd={() => setDragging(false)}
      className={cn(
        'group cursor-grab rounded-[6px] border border-border/55 bg-card p-3.5 transition-all duration-150 active:cursor-grabbing',
        'hover:border-foreground/15 hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)]',
        done && 'opacity-70',
        dragging && 'opacity-40',
      )}
    >
      {/* The priority tag above the title (medium, the default, has none); the
          memory fact behind the task shows when the task is opened. */}
      {card.priority && <PriorityChip value={card.priority} className="mb-2" />}
      <div className={cn(
        'text-[14px] leading-snug',
        done ? 'text-muted-foreground/70 line-through' : 'text-foreground/90',
      )}>
        {card.title}
      </div>

      {(card.owner || card.deadline) && (
        <div className="mt-3 flex items-center gap-2.5 text-[11.5px] text-muted-foreground/75">
          <Assignee owner={card.owner} />
          {card.deadline && (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Calendar className="size-[12px]" strokeWidth={1.75} />
              {shortDeadline(card.deadline)}
            </span>
          )}
        </div>
      )}

    </div>
  );
}


// Task assignee. An Owner value matching a roster slug renders as that
// teammate's avatar + name; otherwise it's shown as plain text (solo workspace
// or a free-text owner). Renders nothing when there's no owner.
export function Assignee({ owner }) {
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
export function shortDeadline(value) {
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

import { useState, useEffect, useCallback } from 'react';
import { Users, Loader2, Trash2, UserPlus, Shield, AlertTriangle, X, Lock, UsersRound, UserRound, Send, Pencil, Check, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/AuthContext';
import EditorHeader from '../EditorHeader.jsx';
import { useApi, invalidate } from '@/lib/useApi';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * TeamDashboard — file-based whitelist management.
 *
 *   GET    /api/team           → { entries, me: { email, role, isAdmin } }
 *   POST   /api/team           → add { email, role }
 *   PATCH  /api/team/:email    → set role
 *   DELETE /api/team/:email    → remove
 *
 * Visible to anyone authenticated (read-only for members). Mutating actions
 * are gated server-side; the UI hides them for non-admins to avoid a
 * confusing "you can click but it'll fail" experience.
 */
export default function TeamDashboard({ sidebarOpen }) {
  const { user } = useAuth();
  const { data, loading, error, reload: reloadApi } = useApi('/api/team');
  const [adding, setAdding]     = useState(false);
  const [editing, setEditing]   = useState(null);
  const [removing, setRemoving] = useState(null);
  const [switching, setSwitching] = useState(false);
  const [modeError, setModeError] = useState(null);

  const reload = useCallback(() => {
    invalidate('/api/team');
    return reloadApi();
  }, [reloadApi]);

  const isInitialLoad = loading && !data;
  const isAdmin    = data?.me?.isAdmin || user?.isAdmin || false;
  const myEmail    = (data?.me?.email || user?.email || '').toLowerCase();
  const entries    = data?.entries || [];
  const adminCount = entries.filter(e => e.role === 'admin').length;
  const teamMode          = data?.teamMode ?? false;
  const personalFileCount = data?.personalFileCount ?? 0;
  const [confirmingOff, setConfirmingOff] = useState(false);

  const setMode = useCallback(async (enabled, mergePersonal = false) => {
    setSwitching(true); setModeError(null);
    try {
      const resp = await fetch('/api/team/mode', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ enabled, mergePersonal }),
      });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(d.error || `HTTP ${resp.status}`);
      invalidate('/api/me');   // sidebar split + role badge react live
      invalidate('/api/files/tree');   // merged files show up in the workspace tree
      reload();
    } catch (err) {
      setModeError(err.message);
    } finally {
      setSwitching(false);
    }
  }, [reload]);

  // Turning OFF with personal files present needs a decision (move vs hide);
  // every other transition is immediate.
  const handleToggle = useCallback((next) => {
    if (!next && personalFileCount > 0) setConfirmingOff(true);
    else setMode(next);
  }, [personalFileCount, setMode]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={UsersRound} title="Team" sidebarOpen={sidebarOpen} />

      <div className="flex-1 overflow-auto">
        <div className="flex min-h-full flex-col gap-5 px-6 pb-8 pt-2">
          {!isInitialLoad && data && (
            <ModeCard
              teamMode={teamMode}
              isAdmin={isAdmin}
              busy={switching}
              error={modeError}
              onChange={handleToggle}
            />
          )}

          {isInitialLoad && (
            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,320px))]">
              <TeamCardSkeleton />
              <TeamCardSkeleton />
              <TeamCardSkeleton />
            </div>
          )}

          {error && !data && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
              Couldn't load the team list: {error}
            </div>
          )}

          {data && teamMode && entries.length === 0 && (
            <div className="rounded-xl border border-border/40 bg-muted/20 px-5 py-8 text-center text-[13px] text-muted-foreground">
              No one on the team yet. {isAdmin ? 'Invite the first member to get started.' : 'Ask an admin to invite you.'}
            </div>
          )}

          {data && teamMode && entries.length > 0 && (
            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,320px))]">
              {entries.map((entry) => (
                <div key={entry.email} className="rounded-xl border border-border/60 bg-card transition-all duration-150 hover:border-border hover:shadow-[0_2px_6px_rgba(0,0,0,0.035)]">
                  <TeamRow
                    entry={entry}
                    isMe={entry.email === myEmail}
                    isLastAdmin={entry.role === 'admin' && adminCount === 1}
                    canManage={isAdmin}
                    onEdit={() => setEditing(entry)}
                    onRemove={() => setRemoving(entry)}
                  />
                </div>
              ))}
              {isAdmin && <AddMemberTile onClick={() => setAdding(true)} />}
            </div>
          )}

          {!isInitialLoad && data && teamMode && entries.length > 0 && (
            <p className="mx-auto mt-auto max-w-xl text-balance pt-6 text-center text-[12px] leading-relaxed text-muted-foreground/55">
              Anyone on this list can sign in to the workspace with their Google account.
              {isAdmin
                ? ' Admins can invite, promote, and remove team members.'
                : ' Only admins can invite or remove members.'}
            </p>
          )}
        </div>
      </div>

      {adding && (
        <AddMemberModal
          onClose={() => setAdding(false)}
          onSuccess={() => { setAdding(false); reload(); }}
        />
      )}
      {editing && (
        <EditMemberModal
          entry={editing}
          isMe={editing.email === myEmail}
          isLastAdmin={editing.role === 'admin' && adminCount === 1}
          onClose={() => setEditing(null)}
          onSuccess={() => { setEditing(null); reload(); }}
        />
      )}
      {removing && (
        <RemoveMemberModal
          entry={removing}
          isLastAdmin={removing.role === 'admin' && adminCount === 1}
          onClose={() => setRemoving(null)}
          onSuccess={() => { setRemoving(null); reload(); }}
        />
      )}
      {confirmingOff && (
        <DisablePersonalModal
          count={personalFileCount}
          busy={switching}
          onCancel={() => setConfirmingOff(false)}
          onMerge={async () => { await setMode(false, true);  setConfirmingOff(false); }}
          onHide={async ()  => { await setMode(false, false); setConfirmingOff(false); }}
        />
      )}
    </div>
  );
}

// ─── Solo / Collaborative mode ──────────────────────────────────────────────

// Gates the whole team experience. Solo = clean single-user workspace (no
// Workspace/Personal split, no roles, no invites). Enabling collaboration is
// the deliberate step that unlocks inviting teammates.
function ModeCard({ teamMode, isAdmin, busy, error, onChange }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-foreground/70">
            <Globe className="size-[18px]" strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <div className="text-[14.5px] font-semibold text-foreground/90">
              {teamMode ? 'Collaborative workspace' : 'Solo workspace'}
            </div>
            <p className="mt-0.5 max-w-xl text-[12.5px] leading-relaxed text-muted-foreground/75">
              {teamMode
                ? 'Teammates can sign in — each gets their own files plus the shared files.'
                : 'Just you. Turn on collaboration to invite teammates and split Shared vs. Your files.'}
            </p>
          </div>
        </div>
        {isAdmin ? (
          <Switch on={teamMode} busy={busy} onClick={() => onChange(!teamMode)} />
        ) : (
          <span className="shrink-0 rounded-full bg-muted/60 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/85">
            {teamMode ? 'On' : 'Off'}
          </span>
        )}
      </div>
      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

function Switch({ on, busy, onClick }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Enable team collaboration"
      disabled={busy}
      onClick={onClick}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        on ? 'bg-foreground' : 'bg-muted-foreground/30',
      )}
    >
      <span
        className={cn(
          'inline-block size-5 transform rounded-full bg-background shadow-sm transition-transform',
          on ? 'translate-x-[22px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

// Turning off collaboration while you have personal files: decide whether to
// move them into the shared workspace or keep them tucked away. Only ever
// touches YOUR OWN files — teammates' personal files are never moved.
function DisablePersonalModal({ count, busy, onCancel, onMerge, onHide }) {
  const noun = count === 1 ? 'file' : 'files';
  return (
    <ModalShell onClose={busy ? () => {} : onCancel} ariaLabel="Turn off collaboration">
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-border/60 bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
          <h2 className="text-[14px] font-semibold text-foreground/90">Turn off collaboration?</h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85 disabled:opacity-50"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-5 py-4 text-[13px] text-foreground/85">
          <p>
            You have <span className="font-semibold">{count} {noun} in Your Files</span>. What should happen to {count === 1 ? 'it' : 'them'}?
          </p>
          <ul className="flex flex-col gap-2 text-[12.5px] text-muted-foreground/85">
            <li><span className="font-medium text-foreground/85">Move to Shared Files</span> — they join the shared files (renamed if a name clashes). This can't be auto-undone.</li>
            <li><span className="font-medium text-foreground/85">Keep private</span> — they stay tucked away, hidden from the file list, and come back if you re-enable collaboration.</li>
          </ul>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onHide}
            disabled={busy}
            className="rounded-md border border-border/55 px-3 py-1.5 text-[12.5px] font-medium text-foreground/85 hover:bg-muted/40 disabled:opacity-50"
          >
            Keep private
          </button>
          <button
            type="button"
            onClick={onMerge}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition-colors hover:bg-foreground/85 disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            Move to Shared Files
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────

function TeamRow({ entry, isMe, isLastAdmin, canManage, onEdit, onRemove }) {
  const { email, role, addedAt, avatarUrl, displayName } = entry;
  const canRemove = canManage && !isMe && !isLastAdmin;
  return (
    <div className="flex h-full flex-col">
      {/* Header - avatar on the left, role on the right */}
      <div className="flex items-start justify-between gap-3 pl-4 pr-[18px] pt-4 pb-3">
        <Avatar email={email} avatarUrl={avatarUrl} className="size-12 text-[18px]" />
        <RoleBadge role={role} />
      </div>

      {/* Identity - name + channels, email, invited meta */}
      <div className="flex flex-1 flex-col px-4">
        <div className="flex items-center justify-between gap-2 pr-2 text-[16px] font-semibold leading-tight text-foreground/90">
          <span className="truncate">{displayName || email.split('@')[0]}</span>
          <ChannelIcons entry={entry} />
        </div>
        <div className="mt-1.5 truncate text-[12.5px] text-muted-foreground/70">
          {email}
        </div>
        {addedAt && (
          <div className="mt-2.5 text-[11px] text-muted-foreground/55">
            invited {formatRelative(new Date(addedAt))}
          </div>
        )}
      </div>

      {/* Footer - actions for admins; a same-height spacer for everyone else so
          every card keeps the same height whether or not it has buttons. */}
      <div className="px-4 pb-4 pt-3.5">
        {canManage ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-muted/40 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/75 transition-colors hover:bg-muted/55 hover:text-foreground/90"
            >
              <Pencil className="size-3.5" strokeWidth={1.75} />
              Edit
            </button>
            {canRemove && (
              <button
                type="button"
                onClick={onRemove}
                title="Remove member"
                aria-label="Remove member"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/40 text-muted-foreground/65 transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-3.5" strokeWidth={1.75} />
              </button>
            )}
          </div>
        ) : (
          <div className="h-8" aria-hidden />
        )}
      </div>
    </div>
  );
}

// Loading placeholder matching a TeamRow card (avatar + role on top, name /
// email / invited below, an action footer).
function TeamCardSkeleton() {
  return (
    <div className="rounded-xl border border-border/60 bg-card">
      <div className="flex items-start justify-between gap-3 pl-4 pr-[18px] pt-4 pb-3">
        <Skeleton className="size-12 rounded-full" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="flex flex-col gap-2 px-4">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="px-4 pb-4 pt-3.5">
        <Skeleton className="h-8 w-full rounded-md" />
      </div>
    </div>
  );
}

function RoleBadge({ role }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider',
      role === 'admin'
        ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
        : 'bg-muted/60 text-muted-foreground/80',
    )}>
      {role === 'admin' && <Shield className="size-2.5" strokeWidth={2.5} />}
      {role}
    </span>
  );
}

function RolePill({ role, canManage, onChange }) {
  if (!canManage) {
    return (
      <span className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider',
        role === 'admin'
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
          : 'bg-muted/60 text-muted-foreground/85',
      )}>
        {role === 'admin' && <Shield className="size-2.5" strokeWidth={2.5} />}
        {role}
      </span>
    );
  }
  return (
    <select
      value={role}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'rounded-md border border-border/50 bg-background px-2 py-1 text-[11.5px] font-medium',
        'transition-colors hover:border-foreground/25 focus:outline-none focus:ring-1 focus:ring-foreground/20',
      )}
    >
      <option value="member">member</option>
      <option value="admin">admin</option>
    </select>
  );
}

// Channel icons — where this teammate can be reached. Web is always available
// (everyone signs into the workspace); Telegram only when linked. The preferred
// surface gets a subtle accent so it reads as "primary".
function ChannelIcons({ entry }) {
  const linked  = !!entry.telegramChatId;
  const surface = entry.preferredSurface;
  const webPrimary = surface === 'web' || surface === 'both' || !linked;
  const tgPrimary  = linked && (surface === 'telegram' || surface === 'both');
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Globe
        className={cn('size-3', webPrimary ? 'text-foreground/55' : 'text-muted-foreground/40')}
        strokeWidth={1.75}
        aria-label="Web workspace"
        title="Web workspace"
      />
      {linked && (
        <Send
          className={cn('size-3', tgPrimary ? 'text-foreground/55' : 'text-muted-foreground/45')}
          strokeWidth={1.75}
          aria-label="Telegram linked"
          title={surface === 'both' ? 'Telegram linked · prefers web + telegram'
               : surface ? `Telegram linked · prefers ${surface}` : 'Telegram linked'}
        />
      )}
    </div>
  );
}

function Avatar({ email, avatarUrl, className }) {
  const initial = (email || '?').trim().charAt(0).toUpperCase();
  const palette = [
    'from-yellow-200 to-amber-300',
    'from-amber-200 to-orange-300',
    'from-orange-200 to-amber-300',
    'from-yellow-200 to-orange-300',
  ];
  const idx = (email || '').charCodeAt(0) % palette.length;
  return (
    <div className={cn(
      'flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br',
      'text-[22px] font-semibold text-foreground ring-1 ring-border/60',
      palette[idx],
      className,
    )}>
      {avatarUrl
        ? <img src={avatarUrl} alt="" className="size-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
        : initial}
    </div>
  );
}

// ─── Modals ───────────────────────────────────────────────────────────────

// Custom role selector - radio cards (not the native select), so the picker
// matches the rest of the polished UI. Disabled when the role can't change
// (editing yourself, or the last admin).
function RolePicker({ value, onChange, disabled }) {
  const options = [
    { value: 'member', label: 'Member', desc: 'Can sign in and use the workspace', icon: UserRound },
    { value: 'admin',  label: 'Admin',  desc: 'Can also invite and remove others', icon: Shield },
  ];
  return (
    <div className="grid gap-2">
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all',
              disabled && 'cursor-not-allowed opacity-60',
              active
                ? 'border-foreground/30 bg-muted/40 ring-1 ring-foreground/15'
                : 'border-border/55 hover:border-foreground/20 hover:bg-muted/25',
            )}
          >
            <div className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-md transition-colors',
              active ? 'bg-foreground text-background' : 'bg-muted/50 text-muted-foreground/70',
            )}>
              <Icon className="size-4" strokeWidth={1.75} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-foreground/90">{opt.label}</div>
              <div className="text-[11.5px] text-muted-foreground/65">{opt.desc}</div>
            </div>
            <div className={cn(
              'flex size-[18px] shrink-0 items-center justify-center rounded-full border transition-colors',
              active ? 'border-foreground bg-foreground' : 'border-border/70',
            )}>
              {active && <Check className="size-2.5 text-background" strokeWidth={3.5} />}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function EditMemberModal({ entry, isMe, isLastAdmin, onClose, onSuccess }) {
  const [role, setRole]       = useState(entry.role || 'member');
  const [chatId, setChatId]   = useState(entry.telegramChatId || '');
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);

  const name = entry.displayName || (entry.email || '').split('@')[0];
  const surface = entry.preferredSurface;
  const surfaceLabel = surface === 'both' ? 'web + telegram' : surface;
  const roleLocked = isMe || isLastAdmin;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const patch = {};
      if (!roleLocked && role !== entry.role) patch.role = role;
      const nextChat = chatId.trim();
      if (nextChat !== (entry.telegramChatId || '')) patch.telegramChatId = nextChat;
      if (Object.keys(patch).length === 0) { onClose(); return; }
      const resp = await fetch(`/api/team/${encodeURIComponent(entry.email)}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      onSuccess();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} ariaLabel="Edit team member">
      <form
        onSubmit={submit}
        className="w-full max-w-md overflow-hidden rounded-xl border border-border/60 bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <Avatar email={entry.email} avatarUrl={entry.avatarUrl} className="size-9 text-[14px]" />
            <div className="flex flex-col">
              <h2 className="text-[14px] font-semibold leading-tight text-foreground/90">{name}</h2>
              <span className="text-[12px] text-muted-foreground/65">{entry.email}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-2">
            <span className="text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground/75">
              Role
            </span>
            <RolePicker value={role} onChange={setRole} disabled={roleLocked} />
            {roleLocked && (
              <span className="text-[11.5px] text-muted-foreground/65">
                {isMe ? "You can't change your own role." : "This is the last admin, promote someone else first."}
              </span>
            )}
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground/75">
              Telegram chat id
            </span>
            <input
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="e.g. 123456789"
              inputMode="numeric"
              className="rounded-md border border-border/55 bg-background px-3 py-2 text-[13.5px] text-foreground/90 outline-none transition-colors focus:border-foreground/35"
            />
          </label>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition-colors hover:bg-foreground/85 disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function AddMemberModal({ onClose, onSuccess }) {
  const [email, setEmail] = useState('');
  const [role, setRole]   = useState('member');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const resp = await fetch('/api/team', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: email.trim(), role }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      onSuccess();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} ariaLabel="Invite team member">
      <form
        onSubmit={submit}
        className="w-full max-w-md overflow-hidden rounded-xl border border-border/60 bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <UserPlus className="size-4 text-foreground/75" strokeWidth={1.75} />
            <h2 className="text-[14px] font-semibold text-foreground/90">Invite team member</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground/75">
              Google email
            </span>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              className="rounded-md border border-border/55 bg-background px-3 py-2 text-[13.5px] text-foreground/90 outline-none transition-colors focus:border-foreground/35"
            />
            <span className="text-[11.5px] text-muted-foreground/70">
              They'll be able to sign in with this Google account once invited.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground/75">
              Role
            </span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="rounded-md border border-border/55 bg-background px-3 py-2 text-[13.5px] text-foreground/90 outline-none transition-colors focus:border-foreground/35"
            >
              <option value="member">Member — can sign in and use the workspace</option>
              <option value="admin">Admin — can also invite and remove others</option>
            </select>
          </label>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !email.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition-colors hover:bg-foreground/85 disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? 'Inviting…' : 'Invite'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function RemoveMemberModal({ entry, isLastAdmin, onClose, onSuccess }) {
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const resp = await fetch(`/api/team/${encodeURIComponent(entry.email)}`, { method: 'DELETE' });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      onSuccess();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} ariaLabel="Remove team member">
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-border/60 bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
          <h2 className="text-[14px] font-semibold text-foreground/90">Remove {entry.email}?</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-5 py-4 text-[13px] text-foreground/85">
          <p>
            They'll lose access to this workspace immediately. Their next page load will redirect to the login screen.
          </p>
          {isLastAdmin && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12.5px] text-amber-700 dark:text-amber-400">
              <Lock className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
              <span>This is the only remaining admin and cannot be removed.</span>
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || isLastAdmin}
            className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-[12.5px] font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function AddMemberTile({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full group flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 bg-muted/15 px-4 py-8 text-muted-foreground/70 transition-all hover:border-foreground/25 hover:bg-muted/30 hover:text-foreground/85"
    >
      <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-border/60 transition-colors group-hover:ring-foreground/20">
        <UserPlus className="size-5" strokeWidth={1.75} />
      </div>
      <div className="text-[13.5px] font-medium">Add member</div>
      <div className="text-[11.5px] text-muted-foreground/65">Invite a teammate</div>
    </button>
  );
}

function ModalShell({ children, onClose, ariaLabel }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-[3px] animate-[fade-in_0.12s_ease-out]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {children}
    </div>
  );
}

function formatRelative(date) {
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} days ago`;
  return date.toLocaleDateString();
}

import { useState, useEffect, useCallback } from 'react';
import { Users, Loader2, Trash2, UserPlus, Shield, AlertTriangle, X, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/AuthContext';
import EditorHeader from '../EditorHeader.jsx';
import { useApi, invalidate } from '@/lib/useApi';
import { SkeletonRow } from '@/components/ui/Skeleton';

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
  const [removing, setRemoving] = useState(null);

  const reload = useCallback(() => {
    invalidate('/api/team');
    return reloadApi();
  }, [reloadApi]);

  const isInitialLoad = loading && !data;
  const isAdmin    = data?.me?.isAdmin || user?.isAdmin || false;
  const myEmail    = (data?.me?.email || user?.email || '').toLowerCase();
  const entries    = data?.entries || [];
  const adminCount = entries.filter(e => e.role === 'admin').length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={Users} title="Team" sidebarOpen={sidebarOpen} />

      <div className="flex-1 overflow-auto">
        <div className="flex flex-col gap-5 px-6 pb-12 pt-2">
          <div className="flex items-start justify-between gap-4">
            <p className="max-w-2xl text-[13.5px] leading-relaxed text-muted-foreground/85">
              Anyone on this list can sign in to the workspace with their Google account.
              {isAdmin
                ? ' Admins can invite, promote, and remove team members.'
                : ' Only admins can invite or remove members.'}
            </p>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition-colors hover:bg-foreground/85"
              >
                <UserPlus className="size-3.5" strokeWidth={2} />
                Invite member
              </button>
            )}
          </div>

          {isInitialLoad && (
            <div className="overflow-hidden rounded-xl border border-border/60 bg-card divide-y divide-border/60">
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </div>
          )}

          {error && !data && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
              Couldn't load the team list: {error}
            </div>
          )}

          {data && entries.length === 0 && (
            <div className="rounded-xl border border-border/40 bg-muted/20 px-5 py-8 text-center text-[13px] text-muted-foreground">
              No one on the team yet. {isAdmin ? 'Invite the first member to get started.' : 'Ask an admin to invite you.'}
            </div>
          )}

          {data && entries.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
              {entries.map((entry, idx) => (
                <TeamRow
                  key={entry.email}
                  entry={entry}
                  isMe={entry.email === myEmail}
                  isLastAdmin={entry.role === 'admin' && adminCount === 1}
                  canManage={isAdmin}
                  isFirst={idx === 0}
                  onRemove={() => setRemoving(entry)}
                  onChangeRole={async (role) => {
                    try {
                      const resp = await fetch(`/api/team/${encodeURIComponent(entry.email)}`, {
                        method:  'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({ role }),
                      });
                      const data = await resp.json().catch(() => ({}));
                      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
                      reload();
                    } catch (err) {
                      alert(err.message);   // simple — admin operation, low frequency
                    }
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {adding && (
        <AddMemberModal
          onClose={() => setAdding(false)}
          onSuccess={() => { setAdding(false); reload(); }}
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
    </div>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────

function TeamRow({ entry, isMe, isLastAdmin, canManage, isFirst, onRemove, onChangeRole }) {
  const { email, role, addedAt, addedBy } = entry;
  return (
    <div className={cn(
      'group flex items-center gap-3 px-4 py-3 transition-colors',
      !isFirst && 'border-t border-border/40',
      'hover:bg-muted/25',
    )}>
      <Avatar email={email} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 truncate text-[13.5px] font-medium text-foreground/90">
          {email}
          {isMe && (
            <span className="rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/85">
              you
            </span>
          )}
        </div>
        {addedAt && (
          <div className="text-[11.5px] text-muted-foreground/65">
            invited {formatRelative(new Date(addedAt))}
            {addedBy && addedBy !== 'bootstrap' && ` by ${addedBy}`}
          </div>
        )}
      </div>

      <RolePill
        role={role}
        canManage={canManage && !isMe && !isLastAdmin}
        onChange={onChangeRole}
      />

      {canManage && !isMe && !isLastAdmin && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove member"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/55 opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
        >
          <Trash2 className="size-3.5" strokeWidth={1.75} />
        </button>
      )}
    </div>
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

function Avatar({ email }) {
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
      'flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br',
      'text-[12px] font-semibold text-foreground ring-1 ring-border/60',
      palette[idx],
    )}>
      {initial}
    </div>
  );
}

// ─── Modals ───────────────────────────────────────────────────────────────

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

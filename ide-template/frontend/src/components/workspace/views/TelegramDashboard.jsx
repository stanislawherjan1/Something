import { useState } from 'react';
import {
  Trash2, Plus, Check, Loader2, Users, User, Lock, X,
  Plug, CheckCircle2, AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import { useApi, invalidate } from '@/lib/useApi';
import useMe from '../useMe.js';
import { Skeleton } from '@/components/ui/Skeleton';
import { ActivateModal, RemoveDialog, ModalShell } from './IntegrationsDashboard.jsx';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const GROUPS_URL   = '/api/team/telegram-groups';
const TEAM_URL     = '/api/team';
const INTEG_URL    = '/api/integrations';

const labelCls = 'text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground/75';
const inputCls = cn(
  'w-full rounded border border-border/60 bg-background px-3 py-2 text-[13px] text-foreground outline-none',
  'transition-all focus:border-foreground/60 focus:ring-2 focus:ring-foreground/10',
);

/**
 * Telegram settings — the channel's home in AI Settings. Read-only for everyone;
 * only admins (server `canEdit`) can edit a group's language, remove/register a
 * group, or assign a teammate's Telegram. Consolidates what used to be scattered
 * across Integrations (token) and Team (per-user links), and gives the group
 * registry the UI it never had.
 */
export default function TelegramDashboard({ sidebarOpen, onSelect }) {
  // Telegram is an admin-only surface — members don't see the tile, but a
  // direct /telegram URL must be blocked too, so gate the whole screen here.
  const { me, loading: meLoading } = useMe();
  const isAdmin = !!me?.isAdmin;
  const { data, loading, reload } = useApi(GROUPS_URL);
  const integ = useApi(INTEG_URL);
  const roster = useApi(TEAM_URL);   // shared with People (deduped) — for member avatars
  const groups = data?.groups || [];
  const canEdit = !!data?.canEdit;
  const refresh = () => { invalidate(GROUPS_URL); reload(); };

  // Connection status lives in the top bar now (Active pill + token button)
  // rather than a separate card — the header already says "Telegram".
  const tg = (integ.data?.integrations || []).find(i => i.id === 'telegram');
  const connected = !!tg?.active;
  const [setup, setSetup] = useState(false);
  const [disconnect, setDisconnect] = useState(false);

  if (!isAdmin) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EditorHeader icon={TelegramIcon} title="Telegram" sidebarOpen={sidebarOpen} />
        <div className="flex-1 overflow-auto">{!meLoading && <AccessDenied />}</div>
      </div>
    );
  }

  // Group members render as profile pics — resolve a roster teammate's avatar
  // by their Telegram id; strangers fall back to a grey placeholder circle.
  const memberAvatars = {};
  for (const e of (roster.data?.entries || [])) {
    if (e.telegramChatId) memberAvatars[String(e.telegramChatId)] = e.avatarUrl;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader
        icon={TelegramIcon}
        title="Telegram"
        sidebarOpen={sidebarOpen}
        meta={
          <span className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider',
            connected
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
          )}>
            {connected
              ? <><CheckCircle2 className="size-2.5" strokeWidth={2.5} />Active</>
              : <><Plug className="size-2.5" strokeWidth={2.5} />Not connected</>}
          </span>
        }
      />

      <div className="flex-1 overflow-auto">
        <div className="flex max-w-2xl flex-col gap-6 px-6 pb-12 pt-2">

          {/* ── People ── */}
          <People canEdit={canEdit} />

          {/* ── Groups ── */}
          <section className="flex flex-col gap-2.5">
            <SectionHead title="Groups" lock={!canEdit} />

            {loading && !data ? (
              <><Skeleton className="h-20 rounded-xl" /><Skeleton className="h-20 rounded-xl" /></>
            ) : groups.length === 0 ? (
              <EmptyHint>No groups yet. A group appears here once a teammate adds the bot to it.</EmptyHint>
            ) : (
              groups.map(g => <GroupCard key={g.chatId} group={g} canEdit={canEdit} avatars={memberAvatars} onChanged={refresh} />)
            )}
          </section>

        </div>
      </div>

      {/* Bottom bar — token actions pinned to the panel footer */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-card/30 px-6 py-3">
        <span className="text-[12px] font-medium text-muted-foreground/70">Bot token</span>
        <div className="flex items-center gap-2">
          {tg && (
            <button type="button" onClick={() => setSetup(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/80 transition-colors hover:border-foreground/20 hover:text-foreground/90">
              {connected ? 'Manage token' : 'Set up'}
            </button>
          )}
          {connected && tg && (
            <button type="button" onClick={() => setDisconnect(true)}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium text-destructive transition-colors hover:bg-destructive/10">
              Disconnect
            </button>
          )}
        </div>
      </div>

      {setup && tg && (
        <ActivateModal
          integration={tg}
          onClose={() => setSetup(false)}
          onSuccess={() => { setSetup(false); invalidate(INTEG_URL); integ.reload(); }}
        />
      )}
      {disconnect && tg && (
        <RemoveDialog
          integration={tg}
          title="Disconnect Telegram?"
          body="This erases the stored bot token and takes the assistant off Telegram. Your registered groups and linked teammates are kept: reconnect any time by adding a token again."
          confirmLabel="Disconnect"
          busyLabel="Disconnecting…"
          doneLabel="Disconnected"
          onClose={() => setDisconnect(false)}
          onSuccess={() => { setDisconnect(false); invalidate(INTEG_URL); integ.reload(); }}
        />
      )}
    </div>
  );
}

/* ─── Shared bits ───────────────────────────────────────────────────────── */

// Shown to non-admins who reach /telegram directly (the tile is hidden for them).
function AccessDenied() {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted/50">
          <Lock className="size-5 text-muted-foreground/70" />
        </div>
        <div className="text-[15px] font-semibold text-foreground/90">Admins only</div>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground/70">
          Telegram settings are managed by workspace admins. Ask an admin if you
          need a group registered or your account linked.
        </p>
      </div>
    </div>
  );
}

function SectionHead({ icon: Icon, title, subtitle, lock, trailing }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        {Icon && <Icon className="size-4 text-muted-foreground/70" />}
        <span className="text-[14.5px] font-semibold text-foreground/90">{title}</span>
        {lock && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70">
            <Lock className="size-2.5" /> read-only
          </span>
        )}
        {trailing && <span className="ml-auto shrink-0">{trailing}</span>}
      </div>
      {subtitle && <div className="text-[12px] leading-relaxed text-muted-foreground/70">{subtitle}</div>}
    </div>
  );
}

function EmptyHint({ children }) {
  return <div className="rounded-xl border border-dashed border-border/60 px-4 py-7 text-center text-[12.5px] text-muted-foreground/70">{children}</div>;
}

/* ─── One registered group ──────────────────────────────────────────────── */

// Group avatar — circular disc with a group glyph, mirroring PersonAvatar's shape.
function GroupAvatar() {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted ring-1 ring-border/60">
      <Users className="size-4 text-muted-foreground/70" strokeWidth={1.75} />
    </span>
  );
}

// A face-pile of the members the bot has seen in a group. Roster teammates show
// their real avatar (matched by Telegram id); strangers get a grey placeholder.
function MemberAvatar({ name, avatar }) {
  const [errored, setErrored] = useState(false);
  return (
    <span title={name || undefined}
      className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted ring-2 ring-card">
      {avatar && !errored
        ? <img src={avatar} alt="" className="size-full object-cover" onError={() => setErrored(true)} />
        : <User className="size-3 text-muted-foreground/40" strokeWidth={2} />}
    </span>
  );
}

function MemberPile({ members, avatars }) {
  const shown = members.slice(0, 5);
  const extra = members.length - shown.length;
  return (
    <span className="flex items-center -space-x-1.5">
      {shown.map(([id, name]) => <MemberAvatar key={id} name={name} avatar={avatars?.[String(id)]} />)}
      {extra > 0 && (
        <span className="z-10 flex size-6 items-center justify-center rounded-full bg-muted text-[9.5px] font-semibold text-muted-foreground/70 ring-2 ring-card">
          +{extra}
        </span>
      )}
    </span>
  );
}

function GroupCard({ group, canEdit, avatars, onChanged }) {
  const [open, setOpen] = useState(false);
  const members = group.members && typeof group.members === 'object' ? Object.entries(group.members) : [];
  const title = group.title || 'Untitled group';

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <GroupAvatar />
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-medium text-foreground/90">{title}</div>
          <div className="mt-0.5 inline-flex items-center gap-2 text-[11.5px] text-muted-foreground/65">
            <span className="font-mono text-muted-foreground/80">{group.chatId}</span>
            <span className="text-muted-foreground/35">·</span>
            <span>{group.language || 'auto language'}</span>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {members.length > 0 && <MemberPile members={members} avatars={avatars} />}
        {canEdit && (
          <button type="button" onClick={() => setOpen(true)}
            className="rounded-md px-2.5 py-1 text-[12px] font-medium text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground/90">
            Edit
          </button>
        )}
      </div>

      {open && (
        <GroupModal
          group={group}
          avatars={avatars}
          onClose={() => setOpen(false)}
          onSaved={() => { setOpen(false); onChanged(); }}
        />
      )}
    </div>
  );
}

// Edit a group's reply language / remove it — same modal shell as the person link.
function GroupModal({ group, avatars, onClose, onSaved }) {
  const [lang, setLang] = useState(group.language || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirming, setConfirming] = useState(false);
  const title = group.title || 'Untitled group';
  const members = group.members && typeof group.members === 'object' ? Object.entries(group.members) : [];

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(GROUPS_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: group.chatId, language: lang.trim() }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  const remove = async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(`${GROUPS_URL}/${encodeURIComponent(group.chatId)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <>
    <ModalShell onClose={onClose} ariaLabel={`Settings for ${title}`}>
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border/60 bg-background shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <GroupAvatar />
            <div className="min-w-0">
              <h2 className="truncate text-[14px] font-semibold text-foreground/90">{title}</h2>
              <div className="font-mono text-[11px] text-muted-foreground/60">{group.chatId}</div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85">
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-5">
          <label className="flex flex-col gap-1.5">
            <span className={labelCls}>Reply language</span>
            <input value={lang} autoFocus onChange={e => setLang(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !busy) save(); }}
              placeholder="e.g. English (blank = auto)" spellCheck={false} autoComplete="off"
              className={cn(inputCls)} />
            <span className="text-[11.5px] text-muted-foreground/55">Blank = the bot mirrors whatever language the group speaks.</span>
          </label>

          {members.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className={labelCls}>Members the bot has seen</span>
              <MemberPile members={members} avatars={avatars} />
            </div>
          )}

          {err && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} /><span>{err}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
          <button type="button" onClick={remove} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50">
            <Trash2 className="size-3.5" strokeWidth={1.75} /> Remove
          </button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={busy}
              className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90 disabled:opacity-50">Cancel</button>
            <button type="button" onClick={save} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85 disabled:opacity-50">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" strokeWidth={2} />}
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
    {confirming && (
      <ConfirmDialog
        title="Remove group?"
        body={<>The bot stops replying in <span className="font-medium text-foreground/90">{title}</span>.</>}
        confirmLabel="Remove"
        busy={busy}
        error={err}
        onConfirm={remove}
        onClose={() => setConfirming(false)}
      />
    )}
    </>
  );
}

/* ─── Destructive confirm popup ─────────────────────────────────────────── */

// Generic "are you sure" modal for destructive actions (group removal). The
// caller owns the action + busy/error state; this is just the confirm layer.
function ConfirmDialog({ title, body, confirmLabel = 'Remove', busyLabel = 'Removing…', busy, error, onConfirm, onClose }) {
  return (
    <ModalShell onClose={onClose} ariaLabel={typeof title === 'string' ? title : 'Confirm'}>
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-border/60 bg-background shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-4 px-6 py-6">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-destructive/10">
            <Trash2 className="size-4 text-destructive" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-foreground">{title}</div>
            <div className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground/85">{body}</div>
            {error && (
              <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">{error}</div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/40 bg-muted/20 px-6 py-3.5">
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90 disabled:opacity-50">Cancel</button>
          <button type="button" onClick={onConfirm} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-4 py-1.5 text-[12.5px] font-medium text-white hover:opacity-95 disabled:opacity-50">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" strokeWidth={2} />}
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ─── People — per-user Telegram linking ────────────────────────────────── */

// Profile avatar for a teammate row (notifications-style). Falls back to the
// name's initial when there's no avatar or it fails to load.
function PersonAvatar({ name, avatar }) {
  const [errored, setErrored] = useState(false);
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[13px] font-semibold text-muted-foreground/80 ring-1 ring-border/60">
      {avatar && !errored
        ? <img src={avatar} alt="" className="size-full object-cover" onError={() => setErrored(true)} />
        : initial}
    </span>
  );
}

function People({ canEdit }) {
  const { data, loading, reload } = useApi(TEAM_URL);
  const entries = data?.entries || [];
  const refresh = () => { invalidate(TEAM_URL); reload(); };

  // Connected teammates float to the top; everyone still missing a link sits
  // below a subtle divider so "who do I still need to wire up" is obvious.
  const linked   = entries.filter(p => p.telegramChatId);
  const unlinked = entries.filter(p => !p.telegramChatId);

  return (
    <section className="flex flex-col gap-2.5">
      <SectionHead title="People" lock={!canEdit}
        trailing={entries.length ? (
          <span className="rounded-full bg-muted/60 px-2 py-0.5 text-[10.5px] font-medium tabular-nums text-muted-foreground/80">
            {linked.length}/{entries.length} linked
          </span>
        ) : null} />
      {loading && !data ? (
        <Skeleton className="h-16 rounded-xl" />
      ) : entries.length === 0 ? (
        <EmptyHint>No teammates yet.</EmptyHint>
      ) : (
        <div className="flex flex-col gap-2">
          {linked.map(p => <PersonRow key={p.email} person={p} canEdit={canEdit} onChanged={refresh} />)}
          {unlinked.map(p => <PersonRow key={p.email} person={p} canEdit={canEdit} onChanged={refresh} />)}
        </div>
      )}
    </section>
  );
}

function PersonRow({ person, canEdit, onChanged }) {
  const [open, setOpen] = useState(false);
  const linked = !!person.telegramChatId;
  const name   = person.displayName || person.slug || person.email;

  return (
    <div className={cn(
      'flex items-center justify-between gap-3 rounded-xl border px-4 py-3 transition-colors',
      linked ? 'border-border/60 bg-card' : 'border-dashed border-border/70 bg-muted/15',
    )}>
      <div className="flex min-w-0 items-center gap-3">
        {/* Avatar + connection badge — white disc with the Telegram logo,
            shown only when the teammate is actually linked. */}
        <div className="relative shrink-0">
          <PersonAvatar name={name} avatar={person.avatarUrl} />
          {linked && (
            <span className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-white ring-2 ring-card">
              <TelegramIcon className="size-3" />
            </span>
          )}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-medium text-foreground/90">{name}</div>
          <div className="mt-0.5 text-[11.5px]">
            {linked ? (
              <span className="text-muted-foreground/65">
                ID <span className="font-mono text-muted-foreground/85">{person.telegramChatId}</span>
              </span>
            ) : (
              <span className="text-muted-foreground/55">Not connected</span>
            )}
          </div>
        </div>
      </div>
      {canEdit && (
        linked ? (
          <button type="button" onClick={() => setOpen(true)}
            className="shrink-0 rounded-md px-2.5 py-1 text-[12px] font-medium text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground/90">
            Edit
          </button>
        ) : (
          <button type="button" onClick={() => setOpen(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 py-1 text-[12px] font-medium text-foreground/80 transition-colors hover:border-foreground/25 hover:bg-muted/40">
            <Plus className="size-3" strokeWidth={2} /> Link
          </button>
        )
      )}

      {open && (
        <LinkPersonModal
          person={person}
          onClose={() => setOpen(false)}
          onSaved={() => { setOpen(false); onChanged(); }}
        />
      )}
    </div>
  );
}

// Edit/Link a teammate's Telegram — same modal shell + footer rhythm as the
// Bot/Claude modals. Save sets the chat id; Unlink clears it.
function LinkPersonModal({ person, onClose, onSaved }) {
  const [chatId, setChatId] = useState(person.telegramChatId || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const linked = !!person.telegramChatId;
  const name = person.displayName || person.slug || person.email;

  const submit = async (clear = false) => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(`${TEAM_URL}/${encodeURIComponent(person.email)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegramChatId: clear ? '' : chatId.trim() }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <ModalShell onClose={onClose} ariaLabel={`Telegram link for ${name}`}>
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border/60 bg-background shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <PersonAvatar name={name} avatar={person.avatarUrl} />
            <div className="min-w-0">
              <h2 className="truncate text-[14px] font-semibold text-foreground/90">{name}</h2>
              <div className="text-[11.5px] text-muted-foreground/65">{linked ? 'Edit Telegram link' : 'Link to Telegram'}</div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85">
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-5 py-5">
          <label className="flex flex-col gap-1.5">
            <span className={labelCls}>Telegram chat id</span>
            <input value={chatId} autoFocus onChange={e => setChatId(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && chatId.trim() && !busy) submit(); }}
              placeholder="e.g. 123456789" spellCheck={false} autoComplete="off"
              className={cn(inputCls, 'font-mono')} />
            <span className="text-[11.5px] text-muted-foreground/55">The teammate sends /start to @userinfobot on Telegram to see their numeric id. Until linked here, the bot stays silent to them.</span>
          </label>
          {err && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} /><span>{err}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
          {linked && person.operatorPinned ? (
            <span className="text-[11.5px] text-muted-foreground/65">Operator id from the Telegram activation, can't be unlinked.</span>
          ) : linked ? (
            <button type="button" onClick={() => submit(true)} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50">
              <Trash2 className="size-3.5" strokeWidth={1.75} /> Unlink
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={busy}
              className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90 disabled:opacity-50">Cancel</button>
            <button type="button" onClick={() => submit()} disabled={busy || !chatId.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85 disabled:opacity-50">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" strokeWidth={2} />}
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

/* ─── Logo ──────────────────────────────────────────────────────────────── */

// Bare logo for the EditorHeader — sized by the className EditorHeader passes.
function TelegramIcon({ className }) {
  return <img src={`${BASE}/integrations/telegram.svg`} alt="" className={cn('object-contain', className)} />;
}

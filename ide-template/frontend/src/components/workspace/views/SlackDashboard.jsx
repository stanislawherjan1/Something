import { useState } from 'react';
import {
  Trash2, Check, Loader2, Users, User, Lock, X, Plug, CheckCircle2, AlertTriangle, RefreshCw, Plus, Hash,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import { useApi, invalidate } from '@/lib/useApi';
import useMe from '../useMe.js';
import { Skeleton } from '@/components/ui/Skeleton';
import { ActivateModal, RemoveDialog, ModalShell } from './IntegrationsDashboard.jsx';
import { TabBar } from './MemoryV4View.jsx';
import StatusTag from './StatusTag.jsx';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const CHANNELS_URL = '/api/team/channels?kind=slack';
const CHANNELS_API = '/api/team/channels';
const TEAM_URL     = '/api/team';
const INTEG_URL    = '/api/integrations';

const labelCls = 'text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground/75';

/**
 * Slack — the surface's home in AI Settings, the Telegram screen's twin.
 * Admins only: the channels the assistant was added to and waits for a yes
 * on, the channels it is in (with whether it answers only when addressed and
 * whether the room is paused because someone in it is not on the team), the
 * people linked by their Slack account, and the people who wrote to it on
 * Slack without being on the team.
 */
export default function SlackDashboard({ sidebarOpen }) {
  const { me, loading: meLoading } = useMe();
  const isAdmin = !!me?.isAdmin;
  const { data, loading, reload } = useApi(CHANNELS_URL);
  const integ = useApi(INTEG_URL);
  const roster = useApi(TEAM_URL);
  const groups = data?.groups || [];
  const pending = data?.pending || [];
  const pendingPeople = data?.pendingPeople || [];
  const canEdit = !!data?.canEdit;
  const refresh = () => { invalidate(CHANNELS_URL); reload(); };

  const sl = (integ.data?.integrations || []).find(i => i.id === 'slack');
  const connected = !!sl?.active;
  const listener = sl?.listener || null;
  const needsInstall = connected && !!sl?.install?.needed;
  const [tab, setTab] = useState(null);
  const [setup, setSetup] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
  // Until it is connected the only thing to do is on the Connection tab.
  const current = tab || 'channels';

  if (!isAdmin) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EditorHeader icon={SlackIcon} title="Slack" sidebarOpen={sidebarOpen} />
        <div className="flex-1 overflow-auto">{!meLoading && <AccessDenied />}</div>
      </div>
    );
  }

  const memberAvatars = {};
  for (const e of (roster.data?.entries || [])) {
    if (e.slackUserId) memberAvatars[String(e.slackUserId)] = e.avatarUrl;
  }
  const state = !connected ? 'off' : needsInstall ? 'install' : listener?.connected ? 'on' : listener?.error ? 'error' : 'connecting';
  const pill = {
    on: ['bg-emerald-500/10 text-emerald-700 dark:text-emerald-400', <><CheckCircle2 className="size-2.5" strokeWidth={2.5} />Listening</>],
    connecting: ['bg-amber-500/10 text-amber-700 dark:text-amber-400', <><Plug className="size-2.5" strokeWidth={2.5} />Connecting</>],
    install: ['bg-amber-500/10 text-amber-700 dark:text-amber-400', <><Plug className="size-2.5" strokeWidth={2.5} />Not installed</>],
    error: ['bg-amber-500/10 text-amber-700 dark:text-amber-400', <><Plug className="size-2.5" strokeWidth={2.5} />Not connected</>],
    off: ['bg-amber-500/10 text-amber-700 dark:text-amber-400', <><Plug className="size-2.5" strokeWidth={2.5} />Not connected</>],
  }[state];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader
        icon={SlackIcon}
        title="Slack"
        sidebarOpen={sidebarOpen}
        meta={<span title={pillTitle(listener)} className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider', pill[0])}>{pill[1]}</span>}
      />

      <div className="flex-1 overflow-auto">
        <div className="flex max-w-2xl flex-col gap-5 px-6 pb-12 pt-2">
          <TabBar value={current} onChange={setTab} tabs={[
            ['channels', 'Channels', pending.length],
            ['people', 'People', pendingPeople.length],
          ]} />

          {current === 'channels' && (
            <div className="flex flex-col gap-5">
              {pending.length > 0 && (
                <section className="flex flex-col gap-2">
                  <SectionHead title="Waiting for approval" subtitle="Silent until you approve; after a day it leaves." />
                  {pending.map(p => <PendingChannelCard key={p.chatId} entry={p} onChanged={refresh} />)}
                </section>
              )}
              <section className="flex flex-col gap-2">
                <div className="text-[12px] leading-relaxed text-muted-foreground/70">Invite the assistant to a channel in Slack; it joins in once you approve it here.</div>
                {loading && !data ? (
                  <><Skeleton className="h-16 rounded-[6px]" /><Skeleton className="h-16 rounded-[6px]" /></>
                ) : groups.length === 0 ? (
                  <EmptyHint>No channels yet.</EmptyHint>
                ) : (
                  groups.map(g => <ChannelCard key={g.chatId} group={g} canEdit={canEdit} avatars={memberAvatars} onChanged={refresh} />)
                )}
              </section>
            </div>
          )}

          {current === 'people' && (
            <People pendingPeople={pendingPeople} onChanged={() => { refresh(); invalidate(TEAM_URL); roster.reload(); }} />
          )}

        </div>
      </div>

      {/* Bottom bar — the app's state and its token actions, as on the Telegram screen. */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-card/30 px-6 py-3">
        <span className="min-w-0 truncate text-[12px] font-medium text-muted-foreground/70">{footerLine(connected, listener, needsInstall, sl)}</span>
        <div className="flex shrink-0 items-center gap-2">
          {needsInstall && sl?.install?.possible && (
            <a href="/api/integrations/slack/install" target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-[6px] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85">
              Install to your workspace
            </a>
          )}
          {sl && (
            <button type="button" onClick={() => setSetup(true)}
              className="inline-flex items-center gap-1.5 rounded-[6px] border border-border/60 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/80 transition-colors hover:border-foreground/20 hover:text-foreground/90">
              {connected ? 'Manage tokens' : 'Set up'}
            </button>
          )}
          {connected && sl && (
            <button type="button" onClick={() => setDisconnect(true)}
              className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-destructive transition-colors hover:bg-destructive/10">
              Disconnect
            </button>
          )}
        </div>
      </div>

      {setup && sl && (
        <ActivateModal integration={sl} onClose={() => setSetup(false)} onSuccess={() => { setSetup(false); invalidate(INTEG_URL); integ.reload(); }} />
      )}
      {disconnect && sl && (
        <RemoveDialog
          integration={sl}
          title="Disconnect Slack?"
          body="This erases the stored tokens and takes the assistant off Slack. Approved channels and linked people are kept: reconnect any time by adding the tokens again."
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

/* ─── Footer line ───────────────────────────────────────────────────────── */

// One sentence on the app's state, for the bottom bar: what it is doing, and
// the last drop when there was one.
// Since when, and the last drop, on hover of the status pill only.
function pillTitle(listener) {
  if (!listener?.connected) return undefined;
  const lost = listener.lost?.length ? listener.lost[listener.lost.length - 1] : null;
  return `Listening${listener.team ? ` in ${listener.team}` : ''} since ${formatWhen(listener.since)}${lost ? ` · last drop ${formatWhen(lost.from)}` : ''}`;
}

function footerLine(connected, listener, needsInstall, sl) {
  if (!connected) return 'Slack app';
  if (needsInstall) return sl?.install?.possible ? 'Not installed in your workspace yet' : 'No bot token yet';
  if (listener?.error && !listener.connected) return `Not connected: ${listener.error}`;
  return 'Slack app';
}

/* ─── Shared bits ───────────────────────────────────────────────────────── */

function formatWhen(iso) {
  if (!iso) return 'a while ago';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'a while ago' : d.toLocaleString();
}

function AccessDenied() {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted/50">
          <Lock className="size-5 text-muted-foreground/70" />
        </div>
        <div className="text-[15px] font-semibold text-foreground/90">Admins only</div>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground/70">
          Slack settings are managed by workspace admins. Ask an admin if you need a channel approved.
        </p>
      </div>
    </div>
  );
}

function SectionHead({ title, subtitle, lock, trailing }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
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
  return <div className="rounded-[6px] border border-dashed border-border/60 px-4 py-7 text-center text-[12.5px] text-muted-foreground/70">{children}</div>;
}

function ErrorLine({ err }) {
  if (!err) return null;
  return (
    <div className="flex items-start gap-2 rounded-[6px] border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} /><span>{err}</span>
    </div>
  );
}

async function call(url, init) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json().catch(() => ({}));
}

/* ─── A channel waiting for a yes ───────────────────────────────────────── */

function PendingChannelCard({ entry, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState('');
  const act = async (approve) => {
    setBusy(approve ? 'approve' : 'decline'); setErr('');
    try {
      if (approve) await call(CHANNELS_API, { method: 'POST', body: JSON.stringify({ chatId: entry.chatId }) });
      else await call(`${CHANNELS_API}/${encodeURIComponent(entry.chatId)}`, { method: 'DELETE' });
      onChanged();
    } catch (e) { setErr(e.message); setBusy(null); }
  };
  return (
    <div className="flex flex-col gap-2 rounded-[6px] border border-border/60 bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ChannelAvatar />
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium text-foreground/90">{entry.title || entry.chatId}</div>
            <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground/65">
              Added by {entry.inviterSlug ? <span className="text-foreground/80">{entry.inviterSlug}</span> : 'someone not on the team'}{entry.members ? ` · ${entry.members} members` : ''}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" disabled={!!busy} onClick={() => act(false)}
            className="rounded-[6px] px-2.5 py-1 text-[12px] font-medium text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground/90 disabled:opacity-50">
            {busy === 'decline' ? 'Leaving…' : 'Decline'}
          </button>
          <button type="button" disabled={!!busy} onClick={() => act(true)}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-foreground px-3 py-1 text-[12px] font-medium text-background hover:bg-foreground/85 disabled:opacity-50">
            {busy === 'approve' ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" strokeWidth={2} />}
            {busy === 'approve' ? 'Approving…' : 'Approve'}
          </button>
        </div>
      </div>
      <ErrorLine err={err} />
    </div>
  );
}

/* ─── One registered channel ────────────────────────────────────────────── */

function ChannelAvatar() {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted ring-1 ring-border/60">
      <Hash className="size-4 text-muted-foreground/70" strokeWidth={1.75} />
    </span>
  );
}

function MemberAvatar({ name, avatar }) {
  const [errored, setErrored] = useState(false);
  return (
    <span title={name || undefined} className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted ring-2 ring-card">
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
        <span className="z-10 flex size-6 items-center justify-center rounded-full bg-muted text-[9.5px] font-semibold text-muted-foreground/70 ring-2 ring-card">+{extra}</span>
      )}
    </span>
  );
}

function ChannelCard({ group, canEdit, avatars, onChanged }) {
  const [open, setOpen] = useState(false);
  const members = group.members && typeof group.members === 'object' ? Object.entries(group.members) : [];
  const title = group.title || group.chatId;
  const outsiders = group.audience?.outsiders?.length || 0;

  return (
    <div className="flex items-center justify-between gap-3 rounded-[6px] border border-border/60 bg-card px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <ChannelAvatar />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-medium text-foreground/90">{title}</span>
            {group.paused && <StatusTag tone="paused">Paused</StatusTag>}
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground/65">
            {group.paused
              ? (group.audience?.shared ? 'Shared with another organisation' : `${outsiders} ${outsiders === 1 ? 'person' : 'people'} not on the team`)
              : group.openAudience ? 'Open audience · answers when addressed' : group.requireMention ? 'Answers when addressed' : 'Ambient'}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {members.length > 0 && <MemberPile members={members} avatars={avatars} />}
        {canEdit && (
          <button type="button" onClick={() => setOpen(true)}
            className="rounded-[6px] px-2.5 py-1 text-[12px] font-medium text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground/90">
            Edit
          </button>
        )}
      </div>
      {open && <ChannelModal group={group} avatars={avatars} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onChanged(); }} />}
    </div>
  );
}

function ChannelModal({ group, avatars, onClose, onSaved }) {
  const [lang, setLang] = useState(group.language || '');
  const [ambient, setAmbient] = useState(!group.requireMention);
  const [openAudience, setOpenAudience] = useState(!!group.openAudience);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState('');
  const title = group.title || group.chatId;
  const members = group.members && typeof group.members === 'object' ? Object.entries(group.members) : [];

  const run = async (what, fn) => {
    setBusy(what); setErr('');
    try { await fn(); onSaved(); } catch (e) { setErr(e.message); setBusy(null); }
  };
  const save = () => run('save', () => call(CHANNELS_API, { method: 'POST', body: JSON.stringify({ chatId: group.chatId, language: lang.trim(), requireMention: !ambient, openAudience }) }));
  const remove = () => run('remove', () => call(`${CHANNELS_API}/${encodeURIComponent(group.chatId)}`, { method: 'DELETE' }));
  const recheck = () => run('recheck', () => call(`${CHANNELS_API}/${encodeURIComponent(group.chatId)}/recheck`, { method: 'POST' }));

  return (
    <ModalShell onClose={onClose} ariaLabel={`Settings for ${title}`}>
      <div className="w-full max-w-md overflow-hidden modal-panel" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <ChannelAvatar />
            <div className="min-w-0">
              <h2 className="truncate text-[14px] font-semibold text-foreground/90">{title}</h2>
              <div className="font-mono text-[11px] text-muted-foreground/60">{group.chatId}</div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85">
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className={labelCls}>Ambient</div>
              <div className="text-[11.5px] text-muted-foreground/55">Off: answers only when addressed. On: follows the channel and chimes in when it can help.</div>
            </div>
            <button type="button" role="switch" aria-checked={ambient} onClick={() => setAmbient(v => !v)}
              className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', ambient ? 'bg-foreground' : 'bg-muted-foreground/30')}>
              <span className={cn('absolute top-0.5 size-4 rounded-full bg-background transition-all', ambient ? 'left-[18px]' : 'left-0.5')} />
            </button>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className={labelCls}>Open audience</div>
              <div className="text-[11.5px] text-muted-foreground/55">Off: the room is paused while someone not on the team is in it. On: the assistant stays, but with this channel's own memory only — nothing the team keeps elsewhere.</div>
            </div>
            <button type="button" role="switch" aria-checked={openAudience} onClick={() => setOpenAudience(v => !v)}
              className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', openAudience ? 'bg-foreground' : 'bg-muted-foreground/30')}>
              <span className={cn('absolute top-0.5 size-4 rounded-full bg-background transition-all', openAudience ? 'left-[18px]' : 'left-0.5')} />
            </button>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className={labelCls}>Reply language</span>
            <input value={lang} onChange={e => setLang(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !busy) save(); }}
              placeholder="e.g. English (blank = auto)" spellCheck={false} autoComplete="off"
              className="w-full rounded border border-border/60 bg-background px-3 py-2 text-[13px] text-foreground outline-none transition-all focus:border-foreground/60 focus:ring-2 focus:ring-foreground/10" />
          </label>
          {group.audience && (
            <div className="flex items-center justify-between gap-3 rounded-[6px] border border-border/50 bg-muted/20 px-3 py-2">
              <div className="text-[12px] text-muted-foreground/80">
                {group.audience.ok
                  ? <>Everyone in the room is on the team ({group.audience.members}).</>
                  : group.audience.shared
                    ? <>Shared with another organisation — paused.</>
                    : <>{group.audience.outsiders.length} not on the team — paused.</>}
                <span className="text-muted-foreground/50"> Checked {formatWhen(group.audience.checkedAt)}.</span>
              </div>
              <button type="button" onClick={recheck} disabled={!!busy}
                className="inline-flex shrink-0 items-center gap-1 rounded-[6px] px-2 py-1 text-[11.5px] font-medium text-muted-foreground/75 hover:bg-muted/50 hover:text-foreground/90 disabled:opacity-50">
                <RefreshCw className={cn('size-3', busy === 'recheck' && 'animate-spin')} strokeWidth={2} /> Check again
              </button>
            </div>
          )}
          {members.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className={labelCls}>Members the assistant has seen</span>
              <MemberPile members={members} avatars={avatars} />
            </div>
          )}
          <ErrorLine err={err} />
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
          <button type="button" onClick={remove} disabled={!!busy}
            className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50">
            <Trash2 className="size-3.5" strokeWidth={1.75} /> {busy === 'remove' ? 'Leaving…' : 'Leave channel'}
          </button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={!!busy}
              className="rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90 disabled:opacity-50">Cancel</button>
            <button type="button" onClick={save} disabled={!!busy}
              className="inline-flex items-center gap-1.5 rounded-[6px] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85 disabled:opacity-50">
              {busy === 'save' ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" strokeWidth={2} />}
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

/* ─── People ────────────────────────────────────────────────────────────── */

function PersonAvatar({ name, avatar }) {
  const [errored, setErrored] = useState(false);
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[13px] font-semibold text-muted-foreground/80 ring-1 ring-border/60">
      {avatar && !errored ? <img src={avatar} alt="" className="size-full object-cover" onError={() => setErrored(true)} /> : initial}
    </span>
  );
}

function People({ pendingPeople, onChanged }) {
  const { data, loading } = useApi(TEAM_URL);
  const entries = data?.entries || [];
  const linked = entries.filter(p => p.slackUserId);
  const unlinked = entries.filter(p => !p.slackUserId);

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] leading-relaxed text-muted-foreground/70">Linked by the email on their Slack account, the first time they write.</div>
        {entries.length > 0 && <span className="shrink-0 rounded-full bg-muted/60 px-2 py-0.5 text-[10.5px] font-medium tabular-nums text-muted-foreground/80">{linked.length}/{entries.length} linked</span>}
      </div>
      {pendingPeople.length > 0 && (
        <div className="flex flex-col gap-2">
          {pendingPeople.map(p => <PendingPersonRow key={p.id} person={p} onChanged={onChanged} />)}
        </div>
      )}
      {loading && !data ? (
        <Skeleton className="h-16 rounded-[6px]" />
      ) : entries.length === 0 ? (
        <EmptyHint>No teammates yet.</EmptyHint>
      ) : (
        <div className="flex flex-col gap-2">
          {[...linked, ...unlinked].map(p => (
            <div key={p.email} className="flex items-center justify-between gap-3 rounded-[6px] border border-border/60 bg-card px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="relative shrink-0">
                  <PersonAvatar name={p.displayName || p.slug || p.email} avatar={p.avatarUrl} />
                  {p.slackUserId && (
                    <span className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-white ring-2 ring-card">
                      <SlackIcon className="size-3" />
                    </span>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-[13.5px] font-medium text-foreground/90">{p.displayName || p.slug || p.email}</div>
                  <div className="mt-0.5 text-[11.5px]">
                    {p.slackUserId
                      ? <span className="text-muted-foreground/65">Linked <span className="font-mono text-muted-foreground/85">{p.slackUserId}</span></span>
                      : <span className="text-muted-foreground/55">Not seen on Slack yet</span>}
                  </div>
                </div>
              </div>
              <LinkButton person={p} onChanged={onChanged} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// An admin links (or unlinks) a person's Slack account by its id — for the
// case where the email on their Slack account is not the roster one and the
// automatic link never happens. Not a self-service control.
function LinkButton({ person, onChanged }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState(person.slackUserId || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (clear = false) => {
    setBusy(true); setErr('');
    try {
      await call(`${TEAM_URL}/${encodeURIComponent(person.email)}`, { method: 'PATCH', body: JSON.stringify({ slackUserId: clear ? '' : id.trim() }) });
      setOpen(false); onChanged();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <>
      <button type="button" onClick={() => { setId(person.slackUserId || ''); setOpen(true); }}
        className={cn('shrink-0 rounded-[6px] px-2.5 py-1 text-[12px] font-medium', person.slackUserId
          ? 'text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground/90'
          : 'inline-flex items-center gap-1.5 border border-border/60 bg-background text-foreground/80 transition-colors hover:border-foreground/25 hover:bg-muted/40')}>
        {person.slackUserId ? 'Edit' : <><Plus className="size-3" strokeWidth={2} /> Link</>}
      </button>
      {open && (
        <ModalShell onClose={() => setOpen(false)} ariaLabel={`Slack link for ${person.displayName || person.email}`}>
          <div className="w-full max-w-md overflow-hidden modal-panel" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
              <div className="min-w-0">
                <h2 className="truncate text-[14px] font-semibold text-foreground/90">{person.displayName || person.email}</h2>
                <div className="text-[11.5px] text-muted-foreground/65">{person.slackUserId ? 'Edit Slack link' : 'Link to Slack by id'}</div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85"><X className="size-3.5" strokeWidth={1.75} /></button>
            </div>
            <div className="flex flex-col gap-3 px-5 py-5">
              <label className="flex flex-col gap-1.5">
                <span className={labelCls}>Slack member id</span>
                <input value={id} autoFocus onChange={e => setId(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && id.trim() && !busy) submit(); }}
                  placeholder="e.g. U0123ABCD" spellCheck={false} autoComplete="off"
                  className="w-full rounded border border-border/60 bg-background px-3 py-2 font-mono text-[13px] text-foreground outline-none transition-all focus:border-foreground/60 focus:ring-2 focus:ring-foreground/10" />
                <span className="text-[11.5px] text-muted-foreground/55">Normally not needed: a person is linked by email the first time they write. Use this when the email on their Slack account differs. In Slack: their profile → ⋯ → Copy member ID.</span>
              </label>
              <ErrorLine err={err} />
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
              {person.slackUserId ? (
                <button type="button" onClick={() => submit(true)} disabled={busy} className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"><Trash2 className="size-3.5" strokeWidth={1.75} /> Unlink</button>
              ) : <span />}
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setOpen(false)} disabled={busy} className="rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90 disabled:opacity-50">Cancel</button>
                <button type="button" onClick={() => submit()} disabled={busy || !id.trim()} className="inline-flex items-center gap-1.5 rounded-[6px] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85 disabled:opacity-50">
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" strokeWidth={2} />}{busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </ModalShell>
      )}
    </>
  );
}

// Someone wrote to the assistant on Slack but is not on the team: add them
// (their email joins the roster, as from the Team page) or forget the request.
function PendingPersonRow({ person, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState('');
  const add = async () => {
    setBusy('add'); setErr('');
    try {
      await call(TEAM_URL, { method: 'POST', body: JSON.stringify({ email: person.email, role: 'member' }) });
      await call(`${CHANNELS_API}/pending-people/${encodeURIComponent(person.id)}`, { method: 'DELETE' });
      onChanged();
    } catch (e) { setErr(e.message); setBusy(null); }
  };
  const forget = async () => {
    setBusy('forget'); setErr('');
    try { await call(`${CHANNELS_API}/pending-people/${encodeURIComponent(person.id)}`, { method: 'DELETE' }); onChanged(); }
    catch (e) { setErr(e.message); setBusy(null); }
  };
  return (
    <div className="flex flex-col gap-2 rounded-[6px] border border-border/60 bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <PersonAvatar name={person.name || person.email || person.id} />
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium text-foreground/90">{person.name || person.email || person.id}</div>
            <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground/65">Not on the team · {person.email || 'no email on their Slack account'}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" disabled={!!busy} onClick={forget}
            className="rounded-[6px] px-2.5 py-1 text-[12px] font-medium text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground/90 disabled:opacity-50">Forget</button>
          {person.email && (
            <button type="button" disabled={!!busy} onClick={add}
              className="inline-flex items-center gap-1.5 rounded-[6px] border border-border/60 bg-background px-2.5 py-1 text-[12px] font-medium text-foreground/80 transition-colors hover:border-foreground/25 hover:bg-muted/40 disabled:opacity-50">
              {busy === 'add' ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" strokeWidth={2} />} Add to the team
            </button>
          )}
        </div>
      </div>
      <ErrorLine err={err} />
    </div>
  );
}

/* ─── Logo ──────────────────────────────────────────────────────────────── */

function SlackIcon({ className }) {
  return <img src={`${BASE}/integrations/slack.svg`} alt="" className={cn('object-contain', className)} />;
}

import { useState } from 'react';
import { Check, Plug, CheckCircle2, Plus, Hash } from 'lucide-react';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import { useApi, invalidate } from '@/lib/useApi';
import useMe from '../useMe.js';
import { Skeleton } from '@/components/ui/Skeleton';
import { ActivateModal, RemoveDialog } from './IntegrationsDashboard.jsx';
import { TabBar } from './MemoryV4View.jsx';
import { AddMemberModal } from './TeamDashboard.jsx';
import StatusTag from './StatusTag.jsx';
import useOpenSetupOnce from './useOpenSetupOnce.js';
import { TEAM_URL, call, formatWhen, barBtn, barDanger, primaryBtn, quietBtn, outlineBtn } from './surface-screen-helpers.js';
import {
  StatePill, BottomBar, AccessDenied, NotConnected, GridList, Line, Name, EditButton, RoomAvatar, PersonAvatar, MemberPile, RoomPile, ModalRow, Switch, SettingsModal, LinkIdButton,
} from './surface-screen.jsx';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const CHANNELS_URL = '/api/team/channels?kind=slack';
const CHANNELS_API = '/api/team/channels';
const INTEG_URL    = '/api/integrations';

/**
 * Slack — the surface's home in AI Settings, the Telegram screen's twin:
 * the channels (the ones waiting for a yes first), the people, the app's
 * tokens in the bottom bar. Admins only.
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
  const [tab, setTab] = useState('channels');
  const [setup, setSetup] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
  useOpenSetupOnce({ ready: isAdmin && !!integ.data && !!sl, connected, open: () => setSetup(true) });

  if (!isAdmin) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EditorHeader icon={SlackIcon} title="Slack" sidebarOpen={sidebarOpen} />
        <div className="flex-1 overflow-auto">{!meLoading && <AccessDenied text="Slack settings are managed by workspace admins. Ask an admin if you need a channel approved." />}</div>
      </div>
    );
  }

  const entries = roster.data?.entries || [];
  const avatars = {};
  // A teammate in a room is named as the roster names them, whatever the room recorded.
  const names = {};
  for (const e of entries) if (e.slackUserId) { avatars[String(e.slackUserId)] = e.avatarUrl; names[String(e.slackUserId)] = e.displayName || e.slug || e.email; }
  const onPeopleChanged = () => { refresh(); invalidate(TEAM_URL); roster.reload(); };
  const up = connected && !needsInstall && !!listener?.connected;
  const pillText = !connected ? 'Not connected' : needsInstall ? 'Not installed' : listener?.connected ? 'Listening' : listener?.error ? 'Not connected' : 'Connecting';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={SlackIcon} title="Slack" sidebarOpen={sidebarOpen}
        meta={<StatePill ok={up} icon={up ? CheckCircle2 : Plug} title={pillTitle(listener)}>{pillText}</StatePill>} />

      <div className="flex-1 overflow-auto">
        {sl && !connected ? (
          <NotConnected mark={`${BASE}/integrations/slack.svg`} name="Slack" onSetUp={() => setSetup(true)}
            text="Connect your own Slack app: people can then write to the assistant there, and channels you approve get it too. It takes a few minutes." />
        ) : (
        <div className="flex max-w-2xl flex-col gap-5 px-6 pb-12 pt-2">
          <TabBar value={tab} onChange={setTab} tabs={[['channels', 'Channels', pending.length], ['people', 'People', pendingPeople.length]]} />
          {tab === 'channels' ? (
            loading && !data ? <><Skeleton className="h-10 rounded-[6px]" /><Skeleton className="h-10 rounded-[6px]" /></> : (
              <GridList>
                {pending.map(p => <PendingLine key={p.chatId} entry={p} onChanged={refresh} />)}
                {groups.map(g => <ChannelLine key={g.chatId} group={g} canEdit={canEdit} avatars={avatars} names={names} onChanged={refresh} />)}
              </GridList>
            )
          ) : (
            <GridList>
              {pendingPeople.map(p => <StrangerLine key={p.id} person={p} onChanged={onPeopleChanged} />)}
              {entries.map(p => <PersonLine key={p.email} person={p} onChanged={onPeopleChanged} />)}
            </GridList>
          )}
        </div>
        )}
      </div>

      <BottomBar label={!connected ? 'Slack app' : needsInstall ? (sl?.install?.possible ? 'Not installed in your workspace yet' : 'No bot token yet') : listener?.error && !listener.connected ? `Not connected: ${listener.error}` : 'Slack app'}>
        {needsInstall && sl?.install?.possible && (
          <a href="/api/integrations/slack/install" target="_blank" rel="noreferrer" className={cn(primaryBtn, 'px-3 py-1.5 text-[12.5px]')}>Install to your workspace</a>
        )}
        {sl && <button type="button" onClick={() => setSetup(true)} className={barBtn}>{connected ? 'Manage tokens' : 'Set up'}</button>}
        {connected && sl && <button type="button" onClick={() => setDisconnect(true)} className={barDanger}>Disconnect</button>}
      </BottomBar>

      {setup && sl && (
        <ActivateModal integration={sl} onClose={() => setSetup(false)} onSuccess={() => { setSetup(false); invalidate(INTEG_URL); integ.reload(); }} />
      )}
      {disconnect && sl && (
        <RemoveDialog integration={sl} title="Disconnect Slack?"
          body="This erases the stored tokens and takes the assistant off Slack. Approved channels and linked people are kept: reconnect any time by adding the tokens again."
          confirmLabel="Disconnect" busyLabel="Disconnecting…" doneLabel="Disconnected"
          onClose={() => setDisconnect(false)} onSuccess={() => { setDisconnect(false); invalidate(INTEG_URL); integ.reload(); }} />
      )}
    </div>
  );
}

// Since when, and the last drop, on hover of the status pill only.
function pillTitle(listener) {
  if (!listener?.connected) return undefined;
  const lost = listener.lost?.length ? listener.lost[listener.lost.length - 1] : null;
  return `Listening${listener.team ? ` in ${listener.team}` : ''} since ${formatWhen(listener.since)}${lost ? ` · last drop ${formatWhen(lost.from)}` : ''}`;
}

/* ─── channels ──────────────────────────────────────────────────────────── */

// One line on how the assistant behaves in the room.
function stateLine(g) {
  const outsiders = g.audience?.outsiders?.length || 0;
  if (g.paused) return g.audience?.shared ? 'Shared with another organisation' : `${outsiders} ${outsiders === 1 ? 'person' : 'people'} not on the team`;
  const how = g.requireMention ? 'Replies when mentioned' : 'Joins in on its own';
  return g.openAudience ? `${how} · open to outsiders` : how;
}

function ChannelLine({ group, canEdit, avatars, names, onChanged }) {
  const [open, setOpen] = useState(false);
  const members = group.members && typeof group.members === 'object' ? Object.entries(group.members).map(([id, n]) => [id, names?.[String(id)] || n]) : [];
  return (
    <Line
      who={<><RoomAvatar icon={Hash} /><Name>{group.title || group.chatId}</Name></>}
      state={group.paused ? <StatusTag tone="paused">Paused</StatusTag> : <StatusTag tone="active">Active</StatusTag>}
      text={stateLine(group)}
      pile={members.length > 0 && <MemberPile members={members} avatars={avatars} />}
      actions={<>
        {canEdit && <EditButton onClick={() => setOpen(true)} />}
        {open && <ChannelModal group={group} avatars={avatars} names={names} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onChanged(); }} />}
      </>}
    />
  );
}

function PendingLine({ entry, onChanged }) {
  const [busy, setBusy] = useState(null);
  const act = async (approve) => {
    setBusy(approve ? 'approve' : 'decline');
    try {
      if (approve) await call(CHANNELS_API, { method: 'POST', body: JSON.stringify({ chatId: entry.chatId }) });
      else await call(`${CHANNELS_API}/${encodeURIComponent(entry.chatId)}`, { method: 'DELETE' });
      onChanged();
    } catch { setBusy(null); }
  };
  return (
    <Line
      who={<><RoomAvatar icon={Hash} /><Name>{entry.title || entry.chatId}</Name></>}
      state={<StatusTag tone="soon">Waiting</StatusTag>}
      text={`Added by ${entry.inviterSlug || 'someone not on the team'}${entry.members ? ` · ${entry.members} members` : ''}`}
      actions={<span className="inline-flex items-center gap-2 whitespace-nowrap">
        <button type="button" disabled={!!busy} onClick={() => act(false)} className={quietBtn}>Decline</button>
        <button type="button" disabled={!!busy} onClick={() => act(true)} className={primaryBtn}><Check className="size-3.5" strokeWidth={2} />Approve</button>
      </span>}
    />
  );
}

function ChannelModal({ group, avatars, names, onClose, onSaved }) {
  const [ambient, setAmbient] = useState(!group.requireMention);
  const [openAudience, setOpenAudience] = useState(!!group.openAudience);
  const [mine, setMine] = useState(group.privateAnswers !== 'off');
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState('');
  const members = group.members && typeof group.members === 'object' ? Object.entries(group.members).map(([id, n]) => [id, names?.[String(id)] || n]) : [];
  const run = async (what, fn) => { setBusy(what); setErr(''); try { await fn(); onSaved(); } catch (e) { setErr(e.message); setBusy(null); } };
  return (
    <SettingsModal avatar={<RoomAvatar icon={Hash} />} title={group.title || group.chatId} sub={group.chatId} onClose={onClose}
      onSave={() => run('save', () => call(CHANNELS_API, { method: 'POST', body: JSON.stringify({ chatId: group.chatId, requireMention: !ambient, openAudience, privateAnswers: mine ? 'team' : 'off' }) }))}
      saving={busy === 'save'} busy={busy} err={err}
      danger dangerLabel="Leave channel" dangerBusyLabel="Leaving…" onDanger={() => run('danger', () => call(`${CHANNELS_API}/${encodeURIComponent(group.chatId)}`, { method: 'DELETE' }))}>
      <ModalRow label="Joins in on its own" tip="Whether the assistant follows the conversation and chimes in when it can help, or only answers when someone mentions it.">
        <Switch on={ambient} onToggle={() => setAmbient(v => !v)} />
      </ModalRow>
      <ModalRow label="Open to outsiders" tip="Whether the assistant keeps working when someone outside the team is in the room. It then uses this channel's own memory only, never the team's.">
        <Switch on={openAudience} onToggle={() => setOpenAudience(v => !v)} />
      </ModalRow>
      <ModalRow label="Answers from the asker's own memory" tip="Whether a teammate who asks about their own matters here gets an answer from what they told the assistant in their own conversations, said in this channel. Only while everyone in the room is on the team; never anyone else's memory.">
        <Switch on={mine} onToggle={() => setMine(v => !v)} />
      </ModalRow>
      <ModalRow label="In the room" tip="Who is in the room. Someone outside the team pauses the assistant here, unless the channel is open to outsiders.">
        <RoomPile members={members} outsiders={group.audience?.outsiders || []} avatars={avatars} />
      </ModalRow>
    </SettingsModal>
  );
}

/* ─── people ────────────────────────────────────────────────────────────── */

function PersonLine({ person, onChanged }) {
  const name = person.displayName || person.slug || person.email;
  return (
    <Line
      who={<><PersonAvatar name={name} avatar={person.avatarUrl} /><Name>{name}</Name></>}
      state={person.slackUserId ? <StatusTag tone="active">Linked</StatusTag> : <StatusTag tone="soon">Not seen yet</StatusTag>}
      text={{ mono: true, value: person.slackUserId || '' }}
      actions={<LinkIdButton person={person} field="slackUserId" value={person.slackUserId} what="Slack link" onChanged={onChanged}
        placeholder={{ label: 'Slack member id', example: 'e.g. U0123ABCD' }}
        hint="Normally not needed: a person is linked by email the first time they write. Use this when the email on their Slack account differs. In Slack: their profile → ⋯ → Copy member ID." />}
    />
  );
}

// Someone who wrote to the assistant on Slack without being on the team: Add
// opens the Team page's invite with the email prefilled; once they are on the
// roster their Slack account is linked at once — we know its id.
function StrangerLine({ person, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [adding, setAdding] = useState(false);
  const name = person.name || person.email || person.id;
  const added = async (email) => {
    setAdding(false);
    try {
      await call(`${TEAM_URL}/${encodeURIComponent(email)}`, { method: 'PATCH', body: JSON.stringify({ slackUserId: person.id }) });
      await call(`${CHANNELS_API}/pending-people/${encodeURIComponent(person.id)}`, { method: 'DELETE' });
    } catch { /* on the team already; the link happens on their next message */ }
    onChanged();
  };
  const forget = async () => { setBusy('forget'); try { await call(`${CHANNELS_API}/pending-people/${encodeURIComponent(person.id)}`, { method: 'DELETE' }); onChanged(); } catch { setBusy(null); } };
  return (
    <Line
      who={<><PersonAvatar name={name} /><Name>{name}</Name></>}
      state={<StatusTag tone="soon">Not on the team</StatusTag>}
      text={person.email || 'no email on their Slack account'}
      actions={<span className="inline-flex items-center gap-2 whitespace-nowrap">
        <button type="button" disabled={!!busy} onClick={forget} className={quietBtn}>Forget</button>
        <button type="button" disabled={!!busy} onClick={() => setAdding(true)} className={outlineBtn}><Plus className="size-3" strokeWidth={2} /> Add</button>
        {adding && <AddMemberModal initialEmail={person.email || ''} onClose={() => setAdding(false)} onSuccess={added} />}
      </span>}
    />
  );
}

function SlackIcon({ className }) {
  return <img src={`${BASE}/integrations/slack.svg`} alt="" className={cn('object-contain', className)} />;
}

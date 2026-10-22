import { useState } from 'react';
import { Users, Plug, CheckCircle2, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import { useApi, invalidate } from '@/lib/useApi';
import useMe from '../useMe.js';
import { Skeleton } from '@/components/ui/Skeleton';
import { ActivateModal, RemoveDialog } from './IntegrationsDashboard.jsx';
import { TabBar } from './MemoryV4View.jsx';
import StatusTag from './StatusTag.jsx';
import useOpenSetupOnce from './useOpenSetupOnce.js';
import { TEAM_URL, call, formatWhen, barBtn, barDanger, primaryBtn } from './surface-screen-helpers.js';
import {
  StatePill, BottomBar, AccessDenied, NotConnected, GridList, Line, Name, EditButton, RoomAvatar, PersonAvatar, MemberPile, RoomPile, ModalRow, SettingsModal, LinkIdButton, Switch,
} from './surface-screen.jsx';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const GROUPS_URL  = '/api/team/telegram-groups';
const PENDING_URL = '/api/team/telegram-groups/pending';
const INTEG_URL   = '/api/integrations';

/**
 * Telegram — the surface's home in AI Settings, the Slack screen's twin:
 * the groups (the ones the bot is in but nobody registered first), the
 * people, the bot token in the bottom bar. Admins only.
 */
export default function TelegramDashboard({ sidebarOpen }) {
  const { me, loading: meLoading } = useMe();
  const isAdmin = !!me?.isAdmin;
  const { data, loading, reload } = useApi(GROUPS_URL);
  const pendingQ = useApi(isAdmin ? PENDING_URL : null);
  const integ = useApi(INTEG_URL);
  const roster = useApi(TEAM_URL);
  const groups = data?.groups || [];
  const pending = pendingQ.data?.pending || [];
  const canEdit = !!data?.canEdit;
  const refresh = () => { invalidate(GROUPS_URL); invalidate(PENDING_URL); reload(); pendingQ.reload(); };

  const tg = (integ.data?.integrations || []).find(i => i.id === 'telegram');
  const connected = !!tg?.active;
  const [tab, setTab] = useState('groups');
  const [setup, setSetup] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
  useOpenSetupOnce({ ready: isAdmin && !!integ.data && !!tg, connected, open: () => setSetup(true) });

  if (!isAdmin) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EditorHeader icon={TelegramIcon} title="Telegram" sidebarOpen={sidebarOpen} />
        <div className="flex-1 overflow-auto">{!meLoading && <AccessDenied text="Telegram settings are managed by workspace admins. Ask an admin if you need a group registered or your account linked." />}</div>
      </div>
    );
  }

  const entries = roster.data?.entries || [];
  const avatars = {};
  for (const e of entries) if (e.telegramChatId) avatars[String(e.telegramChatId)] = e.avatarUrl;
  const onPeopleChanged = () => { invalidate(TEAM_URL); roster.reload(); };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={TelegramIcon} title="Telegram" sidebarOpen={sidebarOpen}
        meta={<StatePill ok={connected} icon={connected ? CheckCircle2 : Plug} title={connected && tg?.activatedAt ? `Connected since ${formatWhen(tg.activatedAt)}` : undefined}>{connected ? 'Active' : 'Not connected'}</StatePill>} />

      <div className="flex-1 overflow-auto">
        {tg && !connected ? (
          <NotConnected mark={`${BASE}/integrations/telegram.svg`} name="Telegram" onSetUp={() => setSetup(true)}
            text="Add your Telegram bot's token: the team can then write to the assistant there, and team groups get it too." />
        ) : (
        <div className="flex max-w-2xl flex-col gap-5 px-6 pb-12 pt-2">
          <TabBar value={tab} onChange={setTab} tabs={[['groups', 'Groups', pending.length], ['people', 'People', entries.filter(p => !p.telegramChatId).length]]} />
          {tab === 'groups' ? (
            loading && !data ? <><Skeleton className="h-10 rounded-[6px]" /><Skeleton className="h-10 rounded-[6px]" /></> : (
              <GridList>
                {pending.map(p => <PendingLine key={p.chatId} entry={p} onChanged={refresh} />)}
                {groups.map(g => <GroupLine key={g.chatId} group={g} canEdit={canEdit} avatars={avatars} onChanged={refresh} />)}
              </GridList>
            )
          ) : (
            <GridList>
              {[...entries.filter(p => p.telegramChatId), ...entries.filter(p => !p.telegramChatId)].map(p => <PersonLine key={p.email} person={p} onChanged={onPeopleChanged} />)}
            </GridList>
          )}
        </div>
        )}
      </div>

      <BottomBar label="Bot token">
        {tg && <button type="button" onClick={() => setSetup(true)} className={barBtn}>{connected ? 'Manage token' : 'Set up'}</button>}
        {connected && tg && <button type="button" onClick={() => setDisconnect(true)} className={barDanger}>Disconnect</button>}
      </BottomBar>

      {setup && tg && (
        <ActivateModal integration={tg} onClose={() => setSetup(false)} onSuccess={() => { setSetup(false); invalidate(INTEG_URL); integ.reload(); }} />
      )}
      {disconnect && tg && (
        <RemoveDialog integration={tg} title="Disconnect Telegram?"
          body="This erases the stored bot token and takes the assistant off Telegram. Your registered groups and linked teammates are kept: reconnect any time by adding a token again."
          confirmLabel="Disconnect" busyLabel="Disconnecting…" doneLabel="Disconnected"
          onClose={() => setDisconnect(false)} onSuccess={() => { setDisconnect(false); invalidate(INTEG_URL); integ.reload(); }} />
      )}
    </div>
  );
}

/* ─── groups ────────────────────────────────────────────────────────────── */

function GroupLine({ group, canEdit, avatars, onChanged }) {
  const [open, setOpen] = useState(false);
  const members = group.members && typeof group.members === 'object' ? Object.entries(group.members) : [];
  return (
    <Line
      who={<><RoomAvatar icon={Users} /><Name>{group.title || 'Untitled group'}</Name></>}
      state={<StatusTag tone="active">Active</StatusTag>}
      text={group.language || 'auto language'}
      pile={members.length > 0 && <MemberPile members={members} avatars={avatars} />}
      actions={<>
        {canEdit && <EditButton onClick={() => setOpen(true)} />}
        {open && <GroupModal group={group} avatars={avatars} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onChanged(); }} />}
      </>}
    />
  );
}

// A group the bot is in that nobody registered (its creator was not on the
// roster, or the join was missed): one click registers it.
function PendingLine({ entry, onChanged }) {
  const [busy, setBusy] = useState(false);
  const register = async () => {
    setBusy(true);
    try { await call(GROUPS_URL, { method: 'POST', body: JSON.stringify({ chatId: entry.chatId, title: entry.title }) }); onChanged(); }
    catch { setBusy(false); }
  };
  return (
    <Line
      who={<><RoomAvatar icon={Users} /><Name>{entry.title || entry.chatId}</Name></>}
      state={<StatusTag tone="soon">Waiting</StatusTag>}
      text={`Last message ${formatWhen(entry.lastSeen)}`}
      actions={<button type="button" disabled={busy} onClick={register} className={primaryBtn}><Plus className="size-3.5" strokeWidth={2} />Register</button>}
    />
  );
}

function GroupModal({ group, avatars, onClose, onSaved }) {
  const [lang, setLang] = useState(group.language || '');
  const [mine, setMine] = useState(group.privateAnswers !== 'off');
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState('');
  const members = group.members && typeof group.members === 'object' ? Object.entries(group.members) : [];
  const run = async (what, fn) => { setBusy(what); setErr(''); try { await fn(); onSaved(); } catch (e) { setErr(e.message); setBusy(null); } };
  return (
    <SettingsModal avatar={<RoomAvatar icon={Users} />} title={group.title || 'Untitled group'} sub={group.chatId} onClose={onClose}
      onSave={() => run('save', () => call(GROUPS_URL, { method: 'POST', body: JSON.stringify({ chatId: group.chatId, language: lang.trim(), privateAnswers: mine ? 'team' : 'off' }) }))}
      saving={busy === 'save'} busy={busy} err={err}
      danger dangerLabel="Remove group" dangerBusyLabel="Removing…" onDanger={() => run('danger', () => call(`${GROUPS_URL}/${encodeURIComponent(group.chatId)}`, { method: 'DELETE' }))}>
      <ModalRow label="Reply language" tip="The language the assistant writes in this group, whatever language a message is in. Blank: the language of each message.">
        <input value={lang} onChange={e => setLang(e.target.value)} placeholder="auto" spellCheck={false} autoComplete="off"
          className="w-[150px] rounded-[6px] border border-border/60 bg-background px-2.5 py-1.5 text-[13px] text-foreground outline-none transition-colors focus:border-foreground/35" />
      </ModalRow>
      <ModalRow label="Answers from the asker's own memory" tip="Whether a teammate who asks about their own matters here gets an answer from what they told the assistant in their own conversations, said in this group. Only while everyone in the group is on the team; never anyone else's memory.">
        <Switch on={mine} onToggle={() => setMine(v => !v)} />
      </ModalRow>
      <ModalRow label="In the group" tip="People the assistant has seen write in this group. Teammates show their face; anyone else is a grey one.">
        <RoomPile members={members} avatars={avatars} />
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
      state={person.telegramChatId ? <StatusTag tone="active">Linked</StatusTag> : <StatusTag tone="soon">Not linked</StatusTag>}
      text={{ mono: true, value: person.telegramChatId || '' }}
      actions={<LinkIdButton person={person} field="telegramChatId" value={person.telegramChatId} what="Telegram link" onChanged={onChanged}
        placeholder={{ label: 'Telegram chat id', example: 'e.g. 123456789' }}
        hint="The teammate sends /start to @userinfobot on Telegram to see their numeric id. Until linked, the bot stays silent to them."
        pinned={person.operatorPinned ? "This id comes from the Telegram activation: the bot always answers the operator, so it can't be changed here. To change it, rotate the Telegram integration." : null} />}
    />
  );
}

function TelegramIcon({ className }) {
  return <img src={`${BASE}/integrations/telegram.svg`} alt="" className={cn('object-contain', className)} />;
}

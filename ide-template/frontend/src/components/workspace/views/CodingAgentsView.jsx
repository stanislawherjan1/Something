import { useState } from 'react';
import { Cable, Terminal, Check, Copy, Trash2, Loader2, Info } from 'lucide-react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import EditorHeader from '../EditorHeader.jsx';
import { useBranding } from '../identity.jsx';
import BotPicture from '../BotPicture.jsx';
import { useApi } from '@/lib/useApi';
import useMe from '../useMe.js';
import { Avatar } from './TeamDashboard.jsx';
import { cn } from '@/lib/utils';

/**
 * Context MCP — the workspace as a context layer for Claude Code, Codex and
 * Cursor. Minimal: one command per client (tabs), the agents connected as this person with a Disconnect, and
 * for an admin who on the team connected what. The rest is in the docs.
 */
// Public assets sit under the app's base in dev ('/app/'); nginx serves them at both in production.
const asset = (p) => `${(import.meta.env.BASE_URL || '/').replace(/\/+$/, '')}${p}`;
// The server carries the bot's name, so the agent's tools read "Aria: get_context"
// and the person says "ask Aria". One command: add it and sign in.
// What each client needs, nothing else (each checked with the real CLI against
// a live workspace): Claude Code adds, then signs in; Codex signs in as part of
// `add`. (Cursor is left out until its install link is checked with the app.)
// `lines` are joined with && into the one command the card copies.
// Codex is often only the editor extension, which keeps its own `codex` out of
// the PATH: the command finds the CLI or else the extension's copy (VS Code,
// Insiders, Cursor, Windsurf) — with find, since zsh aborts a whole command on
// a glob that matches nothing — and says "command not found: codex" if neither.
const CODEX_BIN = '"$(command -v codex || find ~/.vscode/extensions ~/.vscode-insiders/extensions ~/.cursor/extensions ~/.windsurf/extensions -path "*openai.chatgpt-*/bin/*/codex" -type f 2>/dev/null | sort | tail -1 | grep . || echo codex)"';
const CLIENTS = [
  { id: 'claude', label: 'Claude Code', logo: asset('/integrations/claude.svg'), scoped: true,
    lines: (url, name, all) => [`claude mcp add${all ? ' --scope user' : ''} --transport http ${name} ${url}`, `claude mcp login ${name}`],
    then: 'Your browser opens: sign in and allow, then start a new conversation.', where: 'conversation' },
  { id: 'codex', label: 'Codex', logo: asset('/integrations/openai.svg'), scoped: false,
    lines: (url, name) => [`${CODEX_BIN} mcp add ${name} --url ${url}`],
    then: 'Your browser opens: sign in and allow, then start a new session.' },
];
const claudeMdLine = (bot) => `Before working, ask ${bot} for the company context: call get_context with this project's name.`;

export default function CodingAgentsView({ sidebarOpen }) {
  const { title, botDisplayName, botName } = useBranding();
  const bot = botDisplayName || botName || 'Something';
  const serverName = bot.replace(/[^\p{L}\p{N}]+/gu, '') || 'Something';
  const host = typeof window !== 'undefined' ? window.location.host : '';
  const url = `https://${host}/mcp`;
  const [client, setClient] = useState(CLIENTS[0]);
  const [tab, setTab] = useState('connect');
  // Only this project by default; every project when they switch it.
  const [everywhere, setEverywhere] = useState(false);
  const { data: raw, loading, error, reload } = useApi('/auth/agents?team=1');
  // Who a connection belongs to, shown as on the Team page: picture and name.
  const { me } = useMe();
  const { data: teamData } = useApi('/api/team');
  const people = new Map(((teamData && teamData.members) || []).map(m => [String(m.email).toLowerCase(), m]));
  const personOf = (email) => { const e = String(email || me?.email || '').toLowerCase(); const m = people.get(e); return { email: e, name: m?.displayName || (e ? e.split('@')[0] : ''), avatarUrl: m?.avatarUrl || null, you: !email || e === String(me?.email || '').toLowerCase() }; };
  const data = loading ? undefined : (error || !raw ? null : raw);
  const [busy, setBusy] = useState(null);

  const revoke = async (id) => {
    setBusy(id);
    try { await fetch(`/auth/agents/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' }); } catch { /* the reload shows the truth */ }
    setBusy(null);
    reload();
  };

  const grants = data?.grants || [];
  const team = data?.team || null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={Cable} title="Context MCP" sidebarOpen={sidebarOpen} />

      <div className="flex-1 overflow-auto">
        <div className="flex max-w-2xl flex-col gap-5 px-6 pb-12 pt-2">
          <div className="flex gap-4 border-b border-border/60">
            {[['connect', 'Connect'], ['connected', `Connected${grants.length + (team?.length || 0) ? ` · ${grants.length + (team?.length || 0)}` : ''}`]].map(([id, label]) => (
              <button key={id} type="button" onClick={() => setTab(id)}
                className={cn('-mb-px border-b-2 px-0.5 pb-2 text-[13px] font-medium outline-none transition-colors', tab === id ? 'border-foreground text-foreground' : 'border-transparent text-foreground/55 hover:text-foreground/85')}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'connect' ? (
            <section className="flex flex-col gap-3">
              <EditorMock bot={bot} />
              <p className="text-[13px] leading-relaxed text-muted-foreground/85">
                Your coding agent, connected to {title}, knows the company the way you do — the rules, the team, what was agreed, your tasks, your files — and checks before it assumes.
              </p>
              <div className="mt-10 flex flex-wrap items-center gap-1">
                {CLIENTS.map(c => (
                  <button key={c.id} type="button" onClick={() => setClient(c)}
                    className={cn('inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[12.5px] font-medium transition-colors', client.id === c.id ? 'bg-muted text-foreground' : 'text-foreground/65 hover:bg-muted/50 hover:text-foreground/90')}>
                    {c.logo ? <img src={c.logo} alt="" className="size-3.5" /> : <Terminal className="size-3.5" strokeWidth={1.75} />}
                    {c.label}
                  </button>
                ))}
                <TooltipPrimitive.Provider delayDuration={200}>
                  <div className="ml-auto flex items-center gap-1.5">
                    <Tip label={client.id === 'claude'
                      ? `Choose whether to add ${bot} to just one project or to all your projects on this computer.`
                      : `Codex adds ${bot} to all your projects on this computer.`}>
                      <span className="inline-flex cursor-help text-muted-foreground/60 hover:text-foreground/80"><Info className="size-3.5" strokeWidth={1.75} /></span>
                    </Tip>
                    {client.scoped ? (
                      <div className="flex items-center gap-0.5 rounded-[6px] bg-foreground/[0.04] p-0.5">
                        {[[false, 'One project'], [true, 'All your projects']].map(([v, label]) => (
                          <button key={label} type="button" onClick={() => setEverywhere(v)}
                            className={cn('rounded-[5px] px-2 py-1 text-[12px] font-medium outline-none transition-colors', everywhere === v ? 'bg-background text-foreground shadow-[0_0_0_1px_rgb(0_0_0/0.06)]' : 'text-foreground/55 hover:text-foreground/85')}>
                            {label}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[12px] font-medium text-foreground/55">All your projects</span>
                    )}
                  </div>
                </TooltipPrimitive.Provider>
              </div>
              <CommandCard lines={client.lines(url, serverName, everywhere)} />
              <p className="text-[12.5px] leading-relaxed text-muted-foreground/75">
                Paste it in a terminal{client.scoped && !everywhere ? ' in your project\'s folder' : ''}. {client.then}
                {' '}Add <CopyInline text={claudeMdLine(bot)}>one line</CopyInline> to the project&apos;s {client.id === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'} so it asks {bot} first.
              </p>
            </section>
          ) : (
            <section className="flex flex-col gap-3">
              {data === undefined ? (
                <div className="flex items-center gap-2 text-[13px] text-muted-foreground/70"><Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} /> Loading…</div>
              ) : data === null ? (
                <p className="text-[13px] text-muted-foreground/75">Could not load your connections. Reload the page.</p>
              ) : !grants.length && !(team && team.length) ? (
                <p className="text-[13px] text-muted-foreground/75">Nothing yet.</p>
              ) : (
                <TooltipPrimitive.Provider delayDuration={200} skipDelayDuration={400}>
                <ul className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center">
                  {grants.map(g => <GrantRow key={g.id} g={g} person={personOf(null)} busy={busy === g.id} onRevoke={() => revoke(g.id)} />)}
                  {(team || []).map(g => <GrantRow key={g.id} g={g} person={personOf(g.email)} busy={busy === g.id} onRevoke={() => revoke(g.id)} />)}
                </ul>
                </TooltipPrimitive.Provider>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

const CLIENT_LOGO = { 'Claude Code': asset('/integrations/claude.svg'), 'Codex': asset('/integrations/openai.svg'), 'Codex CLI': asset('/integrations/openai.svg'), 'Cursor': asset('/integrations/cursor.svg') };
// One connection as a row of the same grid the Team page uses: the client
// with its logo, whose it is, what it may do, when it was last used, the bin.
function GrantRow({ g, person, busy, onRevoke }) {
  const logo = CLIENT_LOGO[g.client];
  const cell = 'flex h-full items-center border-b border-border/60 py-2.5 pr-10';
  return (
    <li className="contents">
      <div className={cn(cell, 'gap-3 pl-1')}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-muted/50 ring-1 ring-inset ring-foreground/[0.08]">
          {logo ? <img src={logo} alt="" className="size-4" /> : <Terminal className="size-4 text-foreground/60" strokeWidth={1.75} />}
        </span>
        <span className="whitespace-nowrap text-[14px] text-foreground/90">{g.client}</span>
      </div>
      <div className={cell}>
        <Tip label={person.you ? 'You' : person.name}>
          <span className="inline-flex"><Avatar name={person.name} email={person.email} avatarUrl={person.avatarUrl} className="size-6 text-[10px]" /></span>
        </Tip>
      </div>
      <div className={cell}><span className="whitespace-nowrap text-[12.5px] text-muted-foreground/60">{g.lastUsedAt ? `used ${day(g.lastUsedAt)}` : `since ${day(g.createdAt)}`}</span></div>
      <div className={cn(cell, 'justify-end pr-1')}>
        <button type="button" disabled={busy} onClick={onRevoke} title="Disconnect" aria-label={`Disconnect ${g.client}`}
          className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive disabled:opacity-60">
          {busy ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} /> : <Trash2 className="size-3.5" strokeWidth={1.75} />}
        </button>
      </div>
    </li>
  );
}
function day(iso) { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); } catch { return ''; } }

function useCopy(text) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* selectable anyway */ }
  };
  return [copied, copy];
}
function CopyBlock({ text }) {
  const [copied, copy] = useCopy(text);
  return (
    <div className="flex w-full items-start gap-2 rounded-[6px] bg-muted/50 px-2.5 py-2">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-foreground/85">{text}</pre>
      <button type="button" onClick={copy} title="Copy" className={cn('shrink-0 rounded p-1 text-foreground/60 hover:bg-muted hover:text-foreground/85', copied && 'text-foreground/85')}>
        {copied ? <Check className="size-3.5" strokeWidth={2} /> : <Copy className="size-3.5" strokeWidth={1.75} />}
      </button>
    </div>
  );
}
// The command as it is pasted: one line per step, one quiet copy button —
// and, for a client that has the choice, where it applies, in the same pill
// style as the client tabs above.
// One line, cut with an ellipsis: the command is pasted, not read.
function CommandCard({ lines }) {
  const command = lines.join(' && ');
  const [copied, copy] = useCopy(command);
  return (
    <div className="flex flex-col gap-2.5 rounded-[6px] bg-muted/50 px-3.5 py-3">
      <div className="flex items-center gap-3">
        <code title={command} className="min-w-0 flex-1 truncate font-mono text-[12.5px] leading-relaxed text-foreground/90">{command}</code>
        <button type="button" onClick={copy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border border-border/70 bg-background px-2.5 py-1.5 text-[12.5px] font-medium text-foreground/75 transition-colors hover:bg-muted/40 hover:text-foreground/90">
          {copied ? <Check className="size-3.5" strokeWidth={2.5} /> : <Copy className="size-3.5" strokeWidth={1.75} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function CopyInline({ text, children }) {
  const [copied, copy] = useCopy(text);
  return (
    <button type="button" onClick={copy} title={text} className="underline decoration-foreground/30 underline-offset-2 hover:text-foreground/90">
      {copied ? 'copied' : children}
    </button>
  );
}



// An illustration, not a screenshot — the same family as the Browser agent's
// mock: an editor with the file being written, and the agent's panel beside
// it reaching for the workspace's context before it writes.
function EditorMock({ bot }) {
  const bar = 'rounded bg-foreground/[0.07] animate-pulse';
  const code = [['w-1/3', 0], ['w-2/3', 1], ['w-1/2', 2], ['w-3/5', 2], ['w-1/4', 1], ['w-1/2', 1], ['w-2/5', 0]];
  return (
    <div className="overflow-hidden rounded-[6px] border border-border/70 bg-card">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-foreground/15" />
          <span className="size-2.5 rounded-full bg-foreground/15" />
          <span className="size-2.5 rounded-full bg-foreground/15" />
        </span>
        <span className="ml-2 rounded bg-muted/60 px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground/70">landing-page</span>
      </div>
      <div className="flex min-h-[200px]">
        <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
          {code.map(([w, indent], i) => (
            <div key={i} className="flex items-center gap-2" style={{ paddingLeft: indent * 14 }}>
              <div className={cn(bar, 'h-2', w, i === 3 && 'bg-foreground/[0.14]')} />
              {i === 3 && <span className="h-3 w-px bg-foreground/60" />}
            </div>
          ))}
        </div>
        <div className="flex w-[44%] max-w-[240px] shrink-0 flex-col border-l border-border/60 bg-background">
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
            <img src={CLIENTS[0].logo} alt="" className="size-4" />
            <span className="truncate text-[12px] font-semibold text-foreground/90">Claude Code</span>
          </div>
          <div className="flex flex-1 flex-col gap-2 p-3">
            <div className="self-end rounded-[6px] border border-border/60 bg-card px-2.5 py-1.5 text-[11px] text-foreground/85">
              Add our pricing tiers to the landing page
            </div>
            <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-muted/60 py-0.5 pl-0.5 pr-2 text-[10px] text-muted-foreground/85">
              <BotPicture className="size-4 rounded-full ring-1 ring-foreground/10" />
              Asking {bot} for help
            </span>
            <div className={cn(bar, 'h-1.5 w-11/12')} />
            <div className={cn(bar, 'h-1.5 w-4/5')} />
            <div className={cn(bar, 'h-1.5 w-3/5')} />
          </div>
        </div>
      </div>
    </div>
  );
}

// The board's tooltip, the same look.
function Tip({ label, children, side = 'top' }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} sideOffset={6} collisionPadding={10}
          className="z-50 max-w-[18rem] rounded-[6px] border border-border/60 bg-popover px-2.5 py-1.5 text-[11.5px] leading-snug text-popover-foreground shadow-md">
          {label}
          <TooltipPrimitive.Arrow className="fill-popover" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

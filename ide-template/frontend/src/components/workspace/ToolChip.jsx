import { useState, useMemo } from 'react';
import { useApi } from '@/lib/useApi';
import {
  Check, ChevronRight,
  Bell, Image as ImageIcon, Globe, FileText, FileEdit, Search, Terminal,
  Sparkles, ListChecks, Eye, MousePointerClick, Wrench, BookOpen, Plug,
  Brain, Send, Repeat, Settings2, MessageSquare,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The assistant's tool use in chat: one quiet line for what it is doing now,
 * folding into a collapsed "Used N tools" that stays with the reply (and in
 * history). Reads like activity, not like a function call: no raw tool ids.
 * Integration tools (mcp__<integration>__…) show that integration's small logo
 * instead of a generic glyph, so it reads as a brand.
 */

// Integration MCP server → logo file under /app/integrations/. Presence here is
// what makes a tool render with a brand logo (vs a neutral glyph). Reminders /
// tasks / built-ins are intentionally absent — they're not integrations.
const INTEGRATION_LOGOS = {
  email: 'email.svg',
  shopify: 'shopify.svg',
  meta: 'meta.svg',
  google_ads: 'google-ads.svg',
  trello: 'trello.svg',
  signwell: 'signwell.jpg.png',
  grok: 'grok.svg',
  github: 'github.svg',
  gdocs: 'gdocs.svg',
  gsheets: 'gsheets.svg',
  gslides: 'gslides.svg',
  gcalendar: 'gcalendar.svg',
  gtasks: 'gtasks.svg',
  gdrive: 'gdrive.svg',
  ga4: 'ga4.svg',
  gemini: 'gemini.svg',
  gemini_chat: 'gemini-chat.svg',
  seedream: 'seedream.svg',
  telegram: 'telegram.svg',
  x: 'x.svg',
  openai: 'openai.svg',
  docs_comments: 'docs-comments.svg',
};

// Friendly labels + a neutral glyph for the non-integration tools (built-ins,
// reminders, tasks, image gen). Integration tools get their label from the
// fallback humaniser below + the brand logo.
const TOOL_DISPLAY = {
  'mcp__reminders__set_reminder':    { label: 'Setting a reminder',   Icon: Bell },
  'mcp__reminders__list_reminders':  { label: 'Checking reminders',   Icon: Bell },
  'mcp__reminders__cancel_reminder': { label: 'Cancelling a reminder', Icon: Bell },

  'mcp__tasks__list_tasks':          { label: 'Checking the board',   Icon: ListChecks },
  'mcp__tasks__add_task':            { label: 'Adding a task',        Icon: ListChecks },
  'mcp__tasks__update_task':         { label: 'Updating a task',      Icon: ListChecks },
  'mcp__tasks__move_task':           { label: 'Moving a task',        Icon: ListChecks },

  // The user's browser tab, from the Chrome side panel.
  'mcp__workspace-api__tab_screenshot': { label: 'Looking at the tab',  Icon: Eye },
  'mcp__workspace-api__tab_snapshot':   { label: 'Reading the page',    Icon: Eye },
  'mcp__workspace-api__tab_act':        { label: 'Working in the tab',  Icon: MousePointerClick },
  'mcp__workspace-api__use_integrations': { label: 'Using your integrations', Icon: Plug },

  // Memory and the person's own settings — what the bot did, in plain words.
  'mcp__workspace-api__memory_search':   { label: 'Searching my memory',       Icon: Brain },
  'mcp__workspace-api__memory_timeline': { label: 'Thinking back',            Icon: Brain },
  'mcp__workspace-api__memory_now':      { label: "Checking what's going on", Icon: Brain },
  'mcp__workspace-api__memory_note':     { label: 'Making a note',             Icon: Brain },
  'mcp__workspace-api__memory_write':    { label: 'Updating memory',         Icon: Brain },
  'mcp__workspace-api__memory_forget':   { label: 'Forgetting',              Icon: Brain },
  'mcp__workspace-api__memory_grep':     { label: 'Searching my memory',       Icon: Brain },
  'mcp__workspace-api__memory_log':      { label: 'Thinking back',            Icon: Brain },
  'mcp__workspace-api__memory_import':   { label: 'Making a note',             Icon: Brain },
  'mcp__workspace-api__recent_messages': { label: 'Reading recent messages', Icon: MessageSquare },
  'mcp__workspace-api__web_send_message': { label: 'Sending a message',      Icon: Send },
  'mcp__workspace-api__fix_sent_message': { label: 'Fixing a message',       Icon: Send },
  'mcp__workspace-api__add_routine':     { label: 'Adding a routine',        Icon: Repeat },
  'mcp__workspace-api__set_my_settings': { label: 'Updating your settings',  Icon: Settings2 },
  'mcp__web-channel__web_send_message':  { label: 'Sending a message',       Icon: Send },
  'mcp__web-channel__group_send_message': { label: 'Posting to the group',  Icon: Send },

  'mcp__seedream__generate':         { label: 'Creating an image',    Icon: ImageIcon },
  'mcp__nano_banana__generate':      { label: 'Creating an image',    Icon: ImageIcon },

  WebFetch:  { label: 'Reading a web page', Icon: Globe },
  WebSearch: { label: 'Searching the web',  Icon: Globe },
  Read:      { label: 'Reading a file',     Icon: FileText },
  Write:     { label: 'Writing a file',     Icon: FileEdit },
  Edit:      { label: 'Editing a file',     Icon: FileEdit },
  Grep:      { label: 'Searching files',    Icon: Search },
  Glob:      { label: 'Finding files',      Icon: Search },
  Bash:      { label: 'Working on it',      Icon: Terminal },

  // Claude Code's own plumbing: loading a tool's definition, a skill, its to-do list.
  ToolSearch: { label: 'Picking the right tool',    Icon: Wrench },
  Skill:      { label: 'Looking up how to do it',   Icon: BookOpen },
  TodoWrite:  { label: 'Planning the steps',   Icon: ListChecks },
};

const LOGO_BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '') + '/integrations/';

// Every integration's servers, from the catalog: the name it goes by and its
// logo. The hand-kept map above only knew a dozen; the catalog knows all, so
// a step in DeepL shows DeepL's logo and name. Filled by useServerCatalog in
// the components that show steps (the list is cached and shared).
let SERVERS = {};
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
function useServerCatalog() {
  const { data } = useApi('/api/integrations');
  return useMemo(() => {
    const m = {};
    for (const e of data?.integrations || []) {
      const logo = e.logo ? (/^https?:/.test(e.logo) ? e.logo : BASE + e.logo) : null;
      if (e.mcp?.name) m[e.mcp.name] = { label: e.label, logo };
      for (const svc of e.mcp?.services || []) if (svc?.name && !m[svc.name]) m[svc.name] = { label: svc.label || e.label, logo: null };
    }
    SERVERS = m;
    return m;
  }, [data]);
}

// A tool with no label of its own reads as activity, never as its id: the
// verb its name starts with, what it acts on, and where — "add_task" on
// Todoist → "Adding a task in Todoist", "list_orders" → "Checking orders".
const VERBS = [
  [/^(search|find|query|lookup)$/, 'Searching'],
  [/^(list|check)$/, 'Checking'],
  [/^(navigate|open|visit|click|type|scroll|browse)$/, 'Browsing'],
  [/^(get|read|fetch|retrieve|view|show|download|export)$/, 'Reading'],
  [/^(add|create|insert|upload|import|schedule|book)$/, 'Adding'],
  [/^(update|edit|set|patch|modify|rename|change|reschedule)$/, 'Updating'],
  [/^(delete|remove|archive|cancel|clear)$/, 'Removing'],
  [/^(send|post|reply|publish|share|comment)$/, 'Sending'],
  [/^(complete|close|finish|resolve|done)$/, 'Completing'],
  [/^(move|assign|transfer)$/, 'Moving'],
  [/^(generate|make|draw|render|draft|write)$/, 'Creating'],
  [/^(run|execute|trigger|start|sync)$/, 'Running'],
];
// Built-in servers are not places to name; integrations are.
const SERVER_NAMES = { 'google-workspace': 'Google', google_workspace: 'Google', 'workspace-api': null, 'web-channel': null, playwright: null, pdf: null, reminders: null, tasks: null, 'mini-apps': null, openai: 'OpenAI', x: 'X' };
function serverName(server) {
  if (!server) return null;
  if (server in SERVER_NAMES) return SERVER_NAMES[server];
  if (SERVERS[server]?.label) return SERVERS[server].label;
  return server.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function humanise(name) {
  const m = /^mcp__([\w-]+?)__(.+)$/.exec(name);
  const where = m ? serverName(m[1].replace(/-mine$/, '')) : null;
  const server = m ? m[1].replace(/-mine$/, '') : '';
  // The server's own name repeated in its tools ("notion-search") says nothing.
  const words = (m ? m[2] : name).split(/[-_\s]+/).filter(Boolean).map((w) => w.toLowerCase())
    .filter((w, i, all) => !(i === 0 && all.length > 1 && server.split(/[-_]/).includes(w)))
    .filter((w, i, all) => !(w === 'browser' && all.length > 1))
    .map((w) => (/^(pdf|csv|url|api|seo|crm)$/.test(w) ? w.toUpperCase() : w));
  const at = words.findIndex((w) => VERBS.some(([re]) => re.test(w)));
  const verb = at >= 0 ? VERBS.find(([re]) => re.test(words[at]))[1] : null;
  let what = (verb ? words.filter((_, i) => i !== at) : words).join(' ').replace(/^web$/, 'the web');
  if (verb && what && !what.endsWith('s') && !what.startsWith('the ')) what = `a ${what}`;
  const phrase = verb ? (what ? `${verb} ${what}` : verb) : (where ? 'Working' : (what ? what.charAt(0).toUpperCase() + what.slice(1) : 'Working on it'));
  return where ? `${phrase} in ${where}` : phrase;
}

// Resolve a tool name → { label, Icon, logo }. `logo` (a URL) wins over Icon.
function displayFor(name) {
  const preset = TOOL_DISPLAY[name];
  const mcp = /^mcp__([a-z0-9_-]+?)__/.exec(name);
  const server = mcp?.[1]?.replace(/-mine$/, '');
  const logoFile = server && (INTEGRATION_LOGOS[server] || INTEGRATION_LOGOS[server.replace(/-/g, '_')]);
  const catalogLogo = server ? SERVERS[server]?.logo : null;
  return {
    label: preset?.label || humanise(name),
    Icon: preset?.Icon || Sparkles,
    logo: logoFile ? LOGO_BASE + logoFile : catalogLogo,
  };
}

function LeadingVisual({ logo, Icon, muted }) {
  const [errored, setErrored] = useState(false);
  if (logo && !errored) {
    return (
      <span className="flex size-[15px] shrink-0 items-center justify-center overflow-hidden rounded-[3px] bg-white ring-1 ring-black/[0.06]">
        <img src={logo} alt="" className="size-[11px] object-contain" onError={() => setErrored(true)} />
      </span>
    );
  }
  return <Icon className={cn('size-[13px] shrink-0', muted && 'text-muted-foreground/70')} strokeWidth={1.75} />;
}

// ── What the assistant is doing, and what it did ────────────────────────────
//
// A reply carries `tools`: [{ id?, name, at, ok, error? }] — `at` is the offset
// in its text where they ran, `ok` is null while a tool is still running.
// While the assistant works, one line shows the current action (ToolLine);
// once it moves on, the group folds into a collapsed "Used N tools"
// (ToolSummary), which is also what history shows after a reload.

// Split a reply into text and tool groups, in order. Tools with no text between
// them form one group.
export function toolSegments(text, tools) {
  const out = [];
  let pos = 0;
  const sorted = [...tools].sort((a, b) => a.at - b.at);
  for (const t of sorted) {
    const at = Math.max(pos, Math.min(t.at, text.length));
    if (at > pos) {
      const chunk = text.slice(pos, at);
      if (chunk.trim()) out.push({ type: 'text', text: chunk });
      pos = at;
    }
    const last = out[out.length - 1];
    if (last?.type === 'tools') last.tools.push(t);
    else out.push({ type: 'tools', tools: [t] });
  }
  const rest = text.slice(pos);
  if (rest.trim()) out.push({ type: 'text', text: rest });
  return out;
}

function StepLabel({ tool, live }) {
  const { label } = displayFor(tool.name);
  return <span className={cn('shrink-0 whitespace-nowrap', live && tool.ok == null && 'shimmer-text')}>{label}</span>;
}

// A failure worth showing is an integration that did not work (its MCP call
// failed). Everything else that comes back as an error is normal work: a
// built-in step the model retries (a wrong tool name or argument, a path that
// is not there), a tab action refused by design (Act off, page still loading),
// the workspace's own housekeeping. Those read as ordinary steps; the reason
// stays in the tooltip for diagnosis.
function realFailure(tool) {
  if (tool.ok !== false) return false;
  const name = String(tool.name || '');
  if (!name.startsWith('mcp__')) return false;
  if (name.startsWith('mcp__workspace-api__') && name !== 'mcp__workspace-api__use_integrations') return false;
  return !/tool_use_error|No such tool available/i.test(String(tool.error || ''));
}

// The current action, replaced in place as the next one starts.
export function ToolLine({ tools, still = false }) {
  useServerCatalog();
  const tool = tools[tools.length - 1];
  const { Icon, logo } = displayFor(tool.name);
  const failed = realFailure(tool);
  return (
    <div className="relative h-[22px] w-full min-w-0 overflow-hidden" title={tool.ok === false && !failed ? tool.error || undefined : undefined}>
      <div
        key={tool.id || `${tool.name}-${tools.length}`}
        className={cn(
          'flex items-center gap-1.5 whitespace-nowrap text-[12.5px] leading-[22px]',
          !still && 'animate-[tool-roll-in_0.2s_ease-out_both]',
          failed ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        <LeadingVisual logo={logo} Icon={Icon} muted={!failed} />
        <StepLabel tool={tool} live />
        {tool.ok === true && <Check className="size-3 shrink-0 opacity-70" strokeWidth={2.25} />}
        {failed && <span className="min-w-0 truncate text-destructive/80" title={tool.error || undefined}>— {tool.error || 'failed'}</span>}
      </div>
    </div>
  );
}

// "Used N tools · k failed", collapsed; a click lists the steps.
export function ToolSummary({ tools, animate = false }) {
  useServerCatalog();
  const [open, setOpen] = useState(false);
  const failed = tools.filter(realFailure).length;
  return (
    <div className={cn('flex w-full min-w-0 flex-col items-start', animate && 'animate-[tool-land_0.22s_ease-out_0.17s_both]')}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[12.5px] leading-[22px] text-muted-foreground transition-colors hover:text-foreground/85"
      >
        <ChevronRight className={cn('size-3 shrink-0 transition-transform duration-200', open && 'rotate-90')} strokeWidth={2} />
        <span>Used {tools.length} {tools.length === 1 ? 'tool' : 'tools'}</span>
        {failed > 0 && <><span>·</span><span className="text-destructive">{failed} failed</span></>}
      </button>
      <div className={cn('grid w-full transition-[grid-template-rows] duration-200 ease-out', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="flex min-h-0 flex-col gap-[3px] overflow-hidden pl-[18px]">
          {tools.map((t, i) => {
            const { Icon, logo } = displayFor(t.name);
            const bad = realFailure(t);
            return (
              <span
                key={t.id || i}
                title={t.ok === false && !bad ? t.error || undefined : undefined}
                style={{ transitionDelay: open ? `${i * 35}ms` : '0ms' }}
                className={cn(
                  'flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap text-[12px] transition-[opacity,transform] duration-150',
                  i === 0 && 'mt-1',
                  open ? 'translate-y-0 opacity-100' : '-translate-y-[3px] opacity-0',
                  bad ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                <LeadingVisual logo={logo} Icon={Icon} muted={!bad} />
                <StepLabel tool={t} />
                {bad && t.error && <span className="min-w-0 truncate text-destructive/80" title={t.error}>— {t.error}</span>}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// One group of tools in a reply. While it is the current step: the live line.
// Once the assistant moves on: the line fades out in place and the collapsed
// summary appears where it was (only animated in a reply written just now).
export function ToolGroup({ tools, live, animate = false }) {
  if (live) return <ToolLine tools={tools} />;
  return (
    <div className="relative">
      {animate && (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 animate-[tool-leave_0.17s_ease-out_both]">
          <ToolLine tools={tools} still />
        </div>
      )}
      <ToolSummary tools={tools} animate={animate} />
    </div>
  );
}

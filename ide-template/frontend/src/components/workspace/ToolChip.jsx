import { useState } from 'react';
import {
  Check, ChevronRight,
  Bell, Image as ImageIcon, Globe, FileText, FileEdit, Search, Terminal,
  Sparkles, ListChecks, Eye, MousePointerClick, Wrench, BookOpen, Zap,
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
  substack: 'substack.svg',
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
  'mcp__workspace-api__tab_autopilot':  { label: 'Autopilot',           Icon: Zap },

  'mcp__seedream__generate':         { label: 'Creating an image',    Icon: ImageIcon },
  'mcp__nano_banana__generate':      { label: 'Creating an image',    Icon: ImageIcon },

  WebFetch:  { label: 'Reading a web page', Icon: Globe },
  WebSearch: { label: 'Searching the web',  Icon: Globe },
  Read:      { label: 'Reading a file',     Icon: FileText },
  Write:     { label: 'Writing a file',     Icon: FileEdit },
  Edit:      { label: 'Editing a file',     Icon: FileEdit },
  Grep:      { label: 'Searching files',    Icon: Search },
  Glob:      { label: 'Finding files',      Icon: Search },
  Bash:      { label: 'Running a command',  Icon: Terminal },

  // Claude Code's own plumbing: loading a tool's definition, a skill, its to-do list.
  ToolSearch: { label: 'Getting a tool ready', Icon: Wrench },
  Skill:      { label: 'Using a skill',        Icon: BookOpen },
  TodoWrite:  { label: 'Planning the steps',   Icon: ListChecks },
};

const LOGO_BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '') + '/integrations/';

// Title-case a humanised verb phrase: "list orders" → "Listing orders" is too
// clever; keep it simple and sentence-cased — "List orders".
function humanise(name) {
  const bare = name.replace(/^mcp__\w+__/, '').replace(/_/g, ' ').trim();
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : 'Working';
}

// Resolve a tool name → { label, Icon, logo }. `logo` (a URL) wins over Icon.
function displayFor(name) {
  const preset = TOOL_DISPLAY[name];
  const mcp = /^mcp__([a-z0-9_]+)__/.exec(name);
  const server = mcp?.[1];
  const logoFile = server && INTEGRATION_LOGOS[server];
  return {
    label: preset?.label || humanise(name),
    Icon: preset?.Icon || Sparkles,
    logo: logoFile ? LOGO_BASE + logoFile : null,
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

// Verbs for the autopilot's own steps (the kind of each action it takes).
const STEP_VERB = { click: 'Clicking', fill: 'Typing into', select: 'Choosing', scroll: 'Scrolling', wait: 'Waiting' };

function StepLabel({ tool, live }) {
  const { label } = displayFor(tool.name);
  // While the autopilot runs, its line reads "Autopilot · Clicking "Search"".
  const step = live && tool.ok == null && tool.progress
    ? ` · ${STEP_VERB[tool.progress.kind] || 'Working on'} “${String(tool.progress.label).slice(0, 60)}”`
    : '';
  return <span className={cn('shrink-0 whitespace-nowrap', live && tool.ok == null && 'shimmer-text')}>{label}{step}</span>;
}

// The current action, replaced in place as the next one starts.
export function ToolLine({ tools, still = false }) {
  const tool = tools[tools.length - 1];
  const { Icon, logo } = displayFor(tool.name);
  const failed = tool.ok === false;
  return (
    <div className="relative h-[22px] w-full min-w-0 overflow-hidden">
      <div
        key={`${tool.id || `${tool.name}-${tools.length}`}-${tool.progress?.n ?? ''}`}   // each autopilot step rolls in too
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
  const [open, setOpen] = useState(false);
  const failed = tools.filter(t => t.ok === false).length;
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
            const bad = t.ok === false;
            return (
              <span
                key={t.id || i}
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

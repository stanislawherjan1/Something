import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Loader2, Check, AlertCircle,
  Bell, Image as ImageIcon, Globe, FileText, FileEdit, Search, Terminal,
  Sparkles, ListChecks,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * ToolChip — a calm "the assistant is doing X" pill shown in chat while a tool
 * runs, flipping to a subtle ✓ on success / ⚠ on error, then fading out.
 *
 * Design goals: read like activity, not like a function call. No raw tool ids,
 * no heavy borders. Integration tools (mcp__<integration>__…) show that
 * integration's small logo instead of a generic glyph, so it reads as a brand.
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

export default function ToolChip({ chip }) {
  const { label, Icon, logo } = displayFor(chip.name);
  const ok    = chip.status === 'done';
  const error = chip.status === 'error';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -4, scale: 0.96 }}
      animate={{ opacity: 1, y:  0, scale: 1 }}
      exit={{    opacity: 0, y: -4, scale: 0.96 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11.5px] font-medium transition-colors duration-200',
        ok    && 'bg-emerald-500/[0.09] text-emerald-700 dark:text-emerald-400',
        error && 'bg-destructive/[0.08] text-destructive',
        !ok && !error && 'bg-muted/60 text-foreground/70',
      )}
      title={error ? (chip.error || 'tool failed') : undefined}
    >
      <LeadingVisual logo={logo} Icon={Icon} muted={!ok && !error} />
      <span className="leading-none">{label}</span>
      {error ? (
        <AlertCircle className="size-[12px] shrink-0" strokeWidth={2} />
      ) : ok ? (
        <Check className="size-[12px] shrink-0" strokeWidth={2.25} />
      ) : (
        <Loader2 className="size-[12px] shrink-0 animate-spin text-muted-foreground/55" strokeWidth={2} />
      )}
    </motion.div>
  );
}

export function ToolChipRow({ chips }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      <AnimatePresence initial={false}>
        {chips.map(c => <ToolChip key={c.id} chip={c} />)}
      </AnimatePresence>
    </div>
  );
}

import { motion, AnimatePresence } from 'framer-motion';
import {
  Loader2, Check, AlertCircle,
  Mail, ShoppingBag, Megaphone, BarChart3, Bell, Image as ImageIcon,
  Globe, FileText, FileEdit, Search, Terminal, Cog,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * ToolChip — small "the assistant is doing X" pill that appears in the chat while
 * a tool is running, flips to ✓ on success / ⚠ on error, then fades out.
 *
 * The chip lives in the chat above the in-flight assistant bubble. We keep
 * it transient — once the turn ends, all chips fade so the chat history
 * stays clean. (A future "transcript mode" toggle can persist them.)
 */

// Map tool names to a friendly label + icon. Anything not listed falls back
// to a generic "running <name>" with a Cog icon.
const TOOL_DISPLAY = {
  // email-mcp
  'mcp__email__list_recent':         { label: 'Reading inbox',      Icon: Mail },
  'mcp__email__search':              { label: 'Searching mail',     Icon: Mail },
  'mcp__email__read_message':        { label: 'Reading email',      Icon: Mail },
  'mcp__email__list_accounts':       { label: 'Listing accounts',   Icon: Mail },
  'mcp__email__download_attachment': { label: 'Downloading attachment', Icon: Mail },

  // shopify-mcp
  'mcp__shopify__list_orders':       { label: 'Fetching orders',    Icon: ShoppingBag },
  'mcp__shopify__get_order':         { label: 'Reading order',      Icon: ShoppingBag },
  'mcp__shopify__list_products':     { label: 'Fetching products',  Icon: ShoppingBag },
  'mcp__shopify__update_product':    { label: 'Updating product',   Icon: ShoppingBag },
  'mcp__shopify__update_inventory':  { label: 'Updating inventory', Icon: ShoppingBag },

  // meta + ads
  'mcp__meta__list_campaigns':       { label: 'Reading Meta ads',   Icon: Megaphone },
  'mcp__meta__update_campaign':      { label: 'Updating Meta ad',   Icon: Megaphone },
  'mcp__google_ads__list_campaigns': { label: 'Reading Google Ads', Icon: BarChart3 },
  'mcp__google_ads__update_campaign':{ label: 'Updating Google Ad', Icon: BarChart3 },

  // image gen
  'mcp__seedream__generate':         { label: 'Generating image',   Icon: ImageIcon },
  'mcp__nano_banana__generate':      { label: 'Generating image',   Icon: ImageIcon },

  // reminders
  'mcp__reminders__set_reminder':    { label: 'Setting reminder',   Icon: Bell },
  'mcp__reminders__list_reminders':  { label: 'Listing reminders',  Icon: Bell },
  'mcp__reminders__cancel_reminder': { label: 'Cancelling reminder',Icon: Bell },

  // built-ins (kept subtle — these fire constantly during normal work)
  'WebFetch':   { label: 'Fetching web page', Icon: Globe },
  'WebSearch':  { label: 'Searching web',     Icon: Globe },
  'Read':       { label: 'Reading file',      Icon: FileText },
  'Write':      { label: 'Writing file',      Icon: FileEdit },
  'Edit':       { label: 'Editing file',      Icon: FileEdit },
  'Grep':       { label: 'Searching code',    Icon: Search },
  'Glob':       { label: 'Finding files',     Icon: Search },
  'Bash':       { label: 'Running command',   Icon: Terminal },
};

function displayFor(name) {
  return TOOL_DISPLAY[name] || { label: name.replace(/^mcp__\w+__/, '').replace(/_/g, ' '), Icon: Cog };
}

export default function ToolChip({ chip }) {
  const { label, Icon } = displayFor(chip.name);
  const ok    = chip.status === 'done';
  const error = chip.status === 'error';
  const StatusIcon = error ? AlertCircle : ok ? Check : Loader2;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -4, scale: 0.96 }}
      animate={{ opacity: 1, y:  0, scale: 1 }}
      exit={{    opacity: 0, y: -4, scale: 0.96 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[11.5px] font-medium',
        'transition-colors duration-150',
        ok    && 'border-emerald-600/25 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-400',
        error && 'border-destructive/30 bg-destructive/5 text-destructive',
        !ok && !error && 'border-border bg-muted/55 text-muted-foreground',
      )}
      title={error ? chip.error || 'tool failed' : undefined}
    >
      <Icon
        className={cn(
          'size-[12px] shrink-0',
          !ok && !error && 'text-muted-foreground/75',
        )}
        strokeWidth={1.75}
      />
      <span className="leading-none">{label}</span>
      <StatusIcon
        className={cn(
          'size-[12px] shrink-0',
          !ok && !error && 'animate-spin text-muted-foreground/55',
        )}
        strokeWidth={2}
      />
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

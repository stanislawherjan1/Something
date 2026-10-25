#!/usr/bin/env node
// The operator's limit notice, for the Telegram brain (bot/bot.sh). The tmux
// session's CLI prints the spent plan on its screen ("You've hit your weekly
// limit · resets 6pm (UTC)") and the person on Telegram heard nothing; the
// bot's watch loop passes that line here (env LINE) and sends what this
// prints. The same sentence every surface uses (lib/usage-limit.js), in the
// operator's language and clock. Prints nothing when the line is no limit.
import { isUsageLimit, limitNotice, noticeLang, resetInstant } from '../lib/usage-limit.js';
import { primaryAdminSlug, effectiveTimezone, getDefaultTimezone, list } from '../lib/team.js';
import { resolve as resolveBranding } from '../lib/branding.js';

const line = String(process.env.LINE || '');
if (!isUsageLimit(line)) process.exit(0);
let who = '';
try { const b = resolveBranding(); who = b.botDisplayName || b.botName || ''; } catch { /* unnamed */ }
let tz = null, lang = 'en';
try {
  const op = primaryAdminSlug();
  tz = op ? effectiveTimezone(op) : getDefaultTimezone();
  lang = noticeLang(list().find(m => m.slug === op)?.preferredLanguage);
} catch { /* the workspace default below */ }
if (!tz) { try { tz = getDefaultTimezone(); } catch { tz = null; } }
process.stdout.write(limitNotice(resetInstant(line), who, { tz, lang }));

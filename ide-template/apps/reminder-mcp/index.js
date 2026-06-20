#!/usr/bin/env node
/**
 * Reminder MCP — persistent reminders stored in ~/project/.reminders.json
 * Survives container restarts via Google Drive sync.
 * Tools: set_reminder, list_reminders, cancel_reminder
 *
 * Paired with reminder-monitor.sh (PM2 process) which fires bot-notify.sh
 * when a reminder becomes due.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import recur from './recur.cjs';

const REMINDERS_FILE =
  process.env.REMINDERS_FILE ||
  path.join(process.env.HOME || '/home/coder', 'project', '.reminders.json');

async function readReminders() {
  try {
    const data = await fs.readFile(REMINDERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function writeReminders(reminders) {
  const dir = path.dirname(REMINDERS_FILE);
  await fs.mkdir(dir, { recursive: true });
  const tmp = REMINDERS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(reminders, null, 2));
  await fs.rename(tmp, REMINDERS_FILE); // atomic swap — prevents corruption on crash
}

// ─── Team-mode recipient resolution ──────────────────────────────────────────
// In team mode the spawning env carries the actor — claude.js (web) and bot.sh
// (Telegram) export IDE_ACTOR_SLUG + IDE_ACTOR_IS_ADMIN. Absent → SOLO: no
// per-recipient logic at all; reminders keep the exact pre-feature shape (no
// setBy / recipients fields), so the monitor + UI behave byte-for-byte as today.
const WSAPI_PORT = process.env.WORKSPACE_API_PORT || '3001';
const EVERYONE = '*everyone*';                       // late-bound team-wide sentinel (outside the slug alphabet)
const SELF_WORDS     = new Set(['me', 'myself', 'self', 'siebie', 'mnie', 'sobie']);
const EVERYONE_WORDS = new Set(['everyone', 'everybody', 'all', 'team', 'all of us', 'whole team', 'wszyscy', 'wszystkim', 'zespol', 'zespół']);

function actorSlug()    { const s = (process.env.IDE_ACTOR_SLUG || '').trim(); return /^[a-z0-9-]+$/.test(s) ? s : ''; }
function actorIsAdmin() { return process.env.IDE_ACTOR_IS_ADMIN === '1'; }

// Roster for set-time name→slug resolution + validation. The MCP is a separate
// process with no in-process team.js, so it fetches the same loopback endpoint
// bot.sh uses for /internal/operator-identity. Null on failure (caller errors).
async function fetchRoster() {
  try {
    const r = await fetch(`http://127.0.0.1:${WSAPI_PORT}/api/internal/roster`);
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j?.members) ? j.members : null;
  } catch { return null; }
}

// Resolve the AI-filled `recipient` arg (string | string[] | undefined) to a
// normalized slug array, or the EVERYONE sentinel. Returns {recipients} or
// {error}. Names resolve against the roster by slug, full displayName, or first
// name; "me/self" → the setter; "everyone/all/team" → the sentinel.
function resolveRecipients(rawArg, roster, setter) {
  const tokens = (Array.isArray(rawArg) ? rawArg : [rawArg])
    .filter(v => typeof v === 'string')
    .flatMap(v => v.split(/[,;]+/))
    .map(v => v.trim()).filter(Boolean);
  if (!tokens.length) return { recipients: [setter] };                 // default: the asker
  if (tokens.some(t => EVERYONE_WORDS.has(t.toLowerCase()))) return { recipients: [EVERYONE] };
  const out = new Set();
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if (SELF_WORDS.has(low)) { out.add(setter); continue; }
    if (/^[a-z0-9-]+$/.test(low) && roster.some(m => m.slug === low)) { out.add(low); continue; }
    const byName = roster.find(m => {
      const dn = String(m.displayName || '').toLowerCase();
      return dn === low || dn.split(/\s+/)[0] === low;
    });
    if (byName) { out.add(byName.slug); continue; }
    return { error: `I don't recognise "${tok}" as a teammate — who do you mean?` };
  }
  return { recipients: [...out] };
}

/**
 * Parse a human-readable due time into a Date.
 * Accepts:
 *   - ISO 8601: "2026-04-17T15:00:00Z"
 *   - Relative:  "in 2 hours", "in 30 minutes", "in 3 days"
 *   - Named:     "tomorrow at 10:00", "tomorrow at 9am"
 *   - Fallback:  native Date parsing
 */
function parseDue(input) {
  const s = input.trim();

  // ISO 8601
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(s);

  const now = new Date();

  // "in N unit"
  const inMatch = s.match(/^in\s+(\d+)\s+(minute|hour|day|week)s?$/i);
  if (inMatch) {
    const n = parseInt(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    const d = new Date(now);
    if (unit === 'minute') d.setMinutes(d.getMinutes() + n);
    else if (unit === 'hour') d.setHours(d.getHours() + n);
    else if (unit === 'day') d.setDate(d.getDate() + n);
    else if (unit === 'week') d.setDate(d.getDate() + n * 7);
    return d;
  }

  // "tomorrow [at HH:MM / at Xam/pm]"
  if (/^tomorrow/i.test(s)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    const t = s.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (t) {
      let h = parseInt(t[1]);
      const m = parseInt(t[2] || '0');
      const ap = t[3]?.toLowerCase();
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      d.setHours(h, m, 0, 0);
    } else {
      d.setHours(9, 0, 0, 0);
    }
    return d;
  }

  // Native fallback
  return new Date(s);
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'reminder-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'set_reminder',
      description:
        'Set a persistent reminder. Stored in ~/project/.reminders.json and ' +
        'sent via Telegram when due, even across container restarts. Prefer ' +
        'the structured form (title + optional description) — title shows as ' +
        'the row heading in the dashboard, description as a muted second line. ' +
        'Use plain `message` only for one-line reminders without context.',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description:
              'Short imperative heading (≤ ~60 chars). Examples: ' +
              '"Send Q3 report to acme", "Call John about the contract", ' +
              '"Pay invoice INV-1042". This is the line the user reads first.',
          },
          description: {
            type: 'string',
            description:
              'Optional context, paragraph form. Why it matters, who is waiting, ' +
              'what to include. Skip when the title is self-explanatory.',
          },
          message: {
            type: 'string',
            description:
              'Legacy single-string form. If you set this without title/description, ' +
              'the dashboard renders it as a single-line reminder. Multi-line strings ' +
              'are auto-split: first line becomes the title, rest the description.',
          },
          due: {
            type: 'string',
            description:
              'When to fire the reminder. ISO 8601 (e.g. "2026-04-17T15:00:00Z") ' +
              'or human-readable: "in 2 hours", "in 30 minutes", "tomorrow at 10:00", "tomorrow at 9am"',
          },
          repeat: {
            type: 'string',
            enum: ['none', 'hourly', 'daily', 'weekly', 'monthly'],
            description:
              'Simple recurrence shortcut. none (default) / hourly / daily / ' +
              'weekly / monthly. Time-of-day and day-of-month come from `due`. ' +
              'For anything more specific (every N units, certain weekdays, ' +
              'bounded repeats) use `recur` instead — it overrides this.',
          },
          recur: {
            type: 'object',
            description:
              'Advanced recurrence (overrides `repeat`). All times UTC. Shapes:\n' +
              '• Interval: {"type":"interval","every":N,"unit":"minutes|hours|days|weeks"} ' +
              '— e.g. every 2 hours. The time-of-day comes from `due`.\n' +
              '• Weekly:  {"type":"weekly","days":["mon","wed","fri"],"at":"09:00"}.\n' +
              '• Monthly: {"type":"monthly","day":1,"at":"08:00"} (day 1..31 or "last").\n' +
              'Optional bounds on any shape: "until":"<ISO>" and/or "count":N (max fires). ' +
              'For weekly/monthly just pass a near-future `due` (e.g. "in 1 minute") — ' +
              'the first fire snaps to the next matching slot automatically.',
            properties: {
              type:  { type: 'string', enum: ['interval', 'weekly', 'monthly'] },
              every: { type: 'integer', description: 'interval: repeat every N units (≥ 1)' },
              unit:  { type: 'string', enum: ['minutes', 'hours', 'days', 'weeks'], description: 'interval unit' },
              days:  { type: 'array', items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }, description: 'weekly: weekdays to fire on' },
              day:   { description: 'monthly: day of month 1..31, or the string "last"' },
              at:    { type: 'string', description: 'weekly/monthly: time of day as "HH:MM" (UTC)' },
              until: { type: 'string', description: 'optional bound: stop after this ISO date/time' },
              count: { type: 'integer', description: 'optional bound: stop after N total fires' },
            },
          },
          channel: {
            type: 'string',
            enum: ['telegram', 'web', 'all'],
            description:
              'Which surface the user wants this reminder delivered on. ' +
              '"telegram" — bot replies via Telegram only (mirror covers web ' +
              'if the user has it open). "web" — bot replies via ' +
              'web_send_message; nothing goes to Telegram. "all" — bot picks ' +
              'whichever channels are wired and replies through them. ' +
              'Default: read from REMINDER_DEFAULT_CHANNEL env var (set at ' +
              'bot startup based on the channel the prompt came in on); ' +
              'falls back to "all" if not set. Override explicitly when the ' +
              "user's intent disagrees with the default — e.g. they're " +
              'chatting via web but say "ping me on Telegram tomorrow".',
          },
          recipient: {
            type: ['string', 'array'],
            items: { type: 'string' },
            description:
              'WHO this reminder is for (team mode). Infer it from the user\'s wording, ' +
              'exactly as you resolve relay recipients. DEFAULT = the person asking — ' +
              'OMIT this arg (or pass "me") for a normal self-reminder ("remind me to call ' +
              'Cass"). When they name people ("remind Jan and Kasia about the deadline"), ' +
              'resolve each NAME to that teammate\'s roster SLUG and pass the array of slugs ' +
              '(["jan","kasia"]) — never display names, never emails. When they say ' +
              '"everyone"/"all"/"the team", pass the single string "everyone". Resolve names ' +
              'to slugs from the team roster in your context; ask ONLY when genuinely ambiguous, ' +
              'never guess a wrong target. Permissions still apply (only an admin can target ' +
              '"everyone" or other people) — if the tool refuses, relay that and offer to remind ' +
              'just the asker. Omit entirely in a solo workspace.',
          },
        },
        required: ['due'],
      },
    },
    {
      name: 'list_reminders',
      description: 'List all pending reminders with their IDs, due times, and messages.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'cancel_reminder',
      description: 'Cancel a reminder by its ID (from list_reminders).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Reminder ID, e.g. "r_a1b2c3d4"' },
        },
        required: ['id'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── set_reminder ───────────────────────────────────────────────────────────
  if (name === 'set_reminder') {
    const dueDate = parseDue(args.due);

    if (isNaN(dueDate.getTime())) {
      return {
        content: [{
          type: 'text',
          text: `Could not parse due time: "${args.due}".\nUse ISO format (2026-04-17T15:00:00Z) or relative time like "in 2 hours", "tomorrow at 10:00".`,
        }],
        isError: true,
      };
    }

    // Three input shapes accepted:
    //   { title, description?, due }   ← preferred, structured
    //   { message, due }                ← legacy single-string
    //   { title, message, due }         ← message-as-description with explicit title
    // Reject if neither title nor message is supplied.
    const titleIn       = typeof args.title       === 'string' ? args.title.trim()       : '';
    const descriptionIn = typeof args.description === 'string' ? args.description.trim() : '';
    const messageIn     = typeof args.message     === 'string' ? args.message.trim()     : '';
    if (!titleIn && !messageIn) {
      return {
        content: [{ type: 'text', text: 'Provide either `title` (preferred) or `message`.' }],
        isError: true,
      };
    }

    // Resolve recurrence: an explicit `recur` object wins, else the `repeat`
    // shortcut is mapped to one. Validation failures come back as a tool error
    // so the agent can correct the call instead of writing a broken reminder.
    const rr = recur.buildRecur(args, dueDate.getTime());
    if (!rr.ok) {
      return { content: [{ type: 'text', text: `Reminder NOT set — ${rr.error}.` }], isError: true };
    }
    const recurrence = rr.recur; // canonical recur object, or null for one-shot
    // First fire: interval honors the explicit `due`; weekly/monthly snap to
    // the next matching slot so the first ping lands on a real occurrence.
    const firstDueMs = recur.computeFirstDue(recurrence, dueDate.getTime(), Date.now());

    // Team-mode recipient resolution + authorization (solo → both omitted).
    // Inference proposes (the AI fills `recipient`); permissions dispose here,
    // against the TRUSTED env actor, never the AI's claim.
    const setter = actorSlug();
    let setBy;
    let recipients;                     // undefined in solo → field omitted entirely
    if (setter) {
      setBy = setter;
      const isAdmin = actorIsAdmin();
      const hasArg = args.recipient != null
        && !(typeof args.recipient === 'string' && !args.recipient.trim())
        && !(Array.isArray(args.recipient) && !args.recipient.length);
      if (!hasArg) {
        recipients = [setter];          // default: the asker
      } else {
        const roster = await fetchRoster();
        if (!roster) {
          return { content: [{ type: 'text', text: 'Could not reach the team roster to resolve who this is for — try again in a moment.' }], isError: true };
        }
        const res = resolveRecipients(args.recipient, roster, setter);
        if (res.error) return { content: [{ type: 'text', text: res.error }], isError: true };
        recipients = res.recipients;
        if (recipients.length === 1 && recipients[0] === EVERYONE) {
          if (!isAdmin) {
            return { content: [{ type: 'text', text: 'Only an admin can set a team-wide reminder. I can remind just you instead?' }], isError: true };
          }
        } else if (recipients.some(s => s !== setter)) {
          // Targeting other teammates: admins always; members gated by the
          // REMINDER_CROSS_MEMBER flag (default ON, relay-parity).
          const crossAllowed = isAdmin || process.env.REMINDER_CROSS_MEMBER !== 'false';
          if (!crossAllowed) {
            return { content: [{ type: 'text', text: 'You can only set reminders for yourself here. Want me to remind you instead?' }], isError: true };
          }
        }
      }
    }

    const reminders = await readReminders();
    const reminder = {
      id: `r_${randomUUID().slice(0, 8)}`,
      // kind is always "user" for reminders set via this tool. System
      // reminders (kind: "system") are seeded by bootstrap-project.sh and
      // never created through MCP — they're protected from cancel_reminder
      // below so the bot can't accidentally tear down baseline rituals.
      kind: 'user',
      // Normalise to the structured shape on disk. Keep `message` mirroring
      // title (and description joined with " — ") so consumers that haven't
      // upgraded to title/description (reminder-monitor, older UI) keep
      // working unchanged.
      title: titleIn || messageIn,
      description: descriptionIn || (titleIn ? '' : ''),
      message: titleIn
        ? (descriptionIn ? `${titleIn} — ${descriptionIn}` : titleIn)
        : messageIn,
      due: new Date(firstDueMs).toISOString(),
      // Canonical recurrence object (omitted entirely for one-shot). `repeat`
      // stays as a coarse legacy mirror ('daily'/'weekly'/'custom'/'none') so
      // pre-recur readers still show a badge; reminder-monitor.sh and the new
      // dashboard read `recur`.
      repeat: recur.legacyRepeatToken(recurrence),
      ...(recurrence ? { recur: recurrence } : {}),
      // Channel routing: explicit tool arg wins, then the per-process default
      // env var (set by bot.sh based on the inbound prompt channel), then 'all'
      // as the safe both-ways fallback. reminder-monitor.sh reads this field
      // when it fires.
      channel: (typeof args.channel === 'string' && ['telegram', 'web', 'all'].includes(args.channel))
        ? args.channel
        : (process.env.REMINDER_DEFAULT_CHANNEL || 'all'),
      created: new Date().toISOString(),
      status: 'pending',
      // Team mode: who set it + who it's for. Both omitted in solo (setter='')
      // → the record is byte-identical to pre-feature, and the monitor's
      // empty-recipients branch reproduces today's operator-only delivery.
      ...(setBy ? { setBy } : {}),
      ...(recipients ? { recipients } : {}),
    };

    reminders.push(reminder);
    await writeReminders(reminders);

    const dueStr = reminder.due.slice(0, 16).replace('T', ' ') + ' UTC';
    const forLabel = recipients
      ? (recipients[0] === EVERYONE ? 'the whole team'
         : (recipients.length === 1 && recipients[0] === setter) ? null    // self — implied
         : recipients.join(', '))
      : null;
    return {
      content: [{
        type: 'text',
        text: `Reminder set.\nID: ${reminder.id}\nTitle: ${reminder.title}` +
              (reminder.description ? `\nDescription: ${reminder.description}` : '') +
              (forLabel ? `\nFor: ${forLabel}` : '') +
              `\nNext fire: ${dueStr}\nRepeat: ${recur.humanizeRecur(recurrence)}`,
      }],
    };
  }

  // ── list_reminders ─────────────────────────────────────────────────────────
  if (name === 'list_reminders') {
    const reminders = await readReminders();
    // Team mode: a member sees only reminders they set, are a recipient of, or
    // that target everyone; admin/operator sees all. Solo (no actor) → all.
    const me = actorSlug();
    const isAdmin = actorIsAdmin();
    const visibleTo = (r) => {
      if (!me || isAdmin) return true;
      if ((r.setBy || '') === me) return true;
      const rc = Array.isArray(r.recipients) ? r.recipients : null;
      return !!rc && (rc.includes(me) || rc.includes(EVERYONE));
    };
    const pending = reminders.filter((r) => r.status === 'pending' && visibleTo(r));

    if (pending.length === 0) {
      return { content: [{ type: 'text', text: 'No pending reminders.' }] };
    }

    const now = Date.now();
    const fmt = (r) => {
      const due = new Date(r.due);
      const diff = due.getTime() - now;
      const overdue = diff < 0 ? ' (OVERDUE)' : '';
      const abs = Math.abs(diff);
      const diffStr =
        abs < 60_000 ? 'now' :
        abs < 3_600_000 ? `${Math.round(abs / 60_000)}m` :
        abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h` :
        `${Math.round(abs / 86_400_000)}d`;
      const sign = diff < 0 ? '-' : '+';
      const rec = recur.resolveRecur(r);
      const repeatStr = rec ? ` [${recur.humanizeRecur(rec)}]` : '';
      return `${r.id} | ${due.toISOString().slice(0, 16).replace('T', ' ')} UTC${overdue} (${sign}${diffStr}) | ${r.message}${repeatStr}`;
    };

    // Group: user reminders first (the ones the user actually cares to
    // review/cancel), then system reminders (baseline rituals — listed for
    // transparency, but tagged so the bot knows not to offer cancellation).
    const userReminders   = pending.filter(r => (r.kind || 'user') !== 'system').sort((a, b) => new Date(a.due) - new Date(b.due));
    const systemReminders = pending.filter(r => r.kind === 'system').sort((a, b) => new Date(a.due) - new Date(b.due));

    const sections = [];
    if (userReminders.length) {
      sections.push(`User reminders (${userReminders.length}):\n${userReminders.map(fmt).join('\n')}`);
    }
    if (systemReminders.length) {
      sections.push(`System reminders (${systemReminders.length}) — baseline rituals; cannot be cancelled via MCP, manage via UI:\n${systemReminders.map(fmt).join('\n')}`);
    }

    return {
      content: [{
        type: 'text',
        text: sections.join('\n\n'),
      }],
    };
  }

  // ── cancel_reminder ────────────────────────────────────────────────────────
  if (name === 'cancel_reminder') {
    const reminders = await readReminders();
    const idx = reminders.findIndex((r) => r.id === args.id);

    if (idx === -1) {
      return {
        content: [{ type: 'text', text: `Reminder ${args.id} not found.` }],
        isError: true,
      };
    }

    // Refuse to delete system reminders. They're baseline rituals seeded by
    // bootstrap and intended to keep the workspace healthy. If the user
    // really wants one off, they can disable it via the Reminders UI toggle
    // (which sets status: 'disabled' instead of removing the entry — so a
    // future redeploy doesn't silently re-seed it).
    if (reminders[idx].kind === 'system') {
      return {
        content: [{
          type: 'text',
          text: `Cannot cancel ${args.id} — this is a system reminder (baseline ritual). To turn it off, use the Reminders panel in the workspace UI; the user can toggle it off there. Don't try to delete the file directly either; bootstrap will re-seed it.`,
        }],
        isError: true,
      };
    }

    // Team mode: a member may cancel only what THEY set; admin/operator cancels
    // anything. Solo (no actor) → unrestricted, as before.
    const me = actorSlug();
    if (me && !actorIsAdmin() && (reminders[idx].setBy || '') !== me) {
      return {
        content: [{ type: 'text', text: `That reminder isn't yours to cancel — only the person who set it (or an admin) can.` }],
        isError: true,
      };
    }

    const [removed] = reminders.splice(idx, 1);
    await writeReminders(reminders);

    return {
      content: [{
        type: 'text',
        text: `Cancelled: "${removed.message}" (was due ${removed.due})`,
      }],
    };
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

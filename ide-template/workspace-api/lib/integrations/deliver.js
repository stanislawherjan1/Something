/**
 * One message to one person, on one surface — the leg every proactive path
 * (a reminder, a relay, a finished run) sends after the web record is written.
 *
 * Telegram: the person's linked chat id, over the Bot API. Slack: the person's
 * linked user id, into their DM with the bot (opened on demand). A surface is
 * only "linked" when the person has an id for it AND the integration is
 * connected and not paused — a preference for a surface that is off is not a
 * delivery. Tests swap the senders with `__setSenders`.
 */
import * as store from './store.js';
import { prefers } from '../surfaces.js';

const senders = {
  telegram: async (member, text) => (await import('./telegram-sync.js')).sendTelegramMessage(member.telegramChatId, text),
  slack: async (member, text) => {
    const listener = await import('./slack-listener.js');
    const api = await import('./slack-api.js');
    const channel = await listener.dmChannelOf(member);
    if (!channel) return { ok: false, error: 'no Slack DM channel' };
    const ts = await api.postMessage({ channel, text });
    return { ok: ts.length > 0, messageId: ts[ts.length - 1] || null, channel };
  },
};
export function __setSenders(over) { Object.assign(senders, over); }

function usable(id) { try { return store.isUsable(id); } catch { return false; } }

/** The surfaces this person can be reached on right now, besides the web. */
export function linkedSurfaces(member) {
  const out = [];
  if (member?.telegramChatId && usable('telegram')) out.push('telegram');
  if (member?.slackUserId && usable('slack')) out.push('slack');
  return out;
}

/**
 * Which surfaces a delivery should go to. `channel` is what the sender asked
 * for ('telegram' | 'slack' | 'web' | 'all'); a named surface is honoured when
 * the person is linked there, 'all' follows their preference. 'web' is never
 * in the answer — the web record is always written by the caller.
 */
export function surfacesFor(member, channel = 'all') {
  const linked = linkedSurfaces(member);
  if (channel === 'web') return [];
  if (channel === 'telegram' || channel === 'slack') return linked.includes(channel) ? [channel] : [];
  return linked.filter(s => prefers(member, s));
}

/** Send on one surface. Returns { ok, messageId, error }; never throws. */
export async function sendToPerson(member, text, surface) {
  const send = senders[surface];
  if (!send) return { ok: false, error: `no such surface: ${surface}` };
  if (!linkedSurfaces(member).includes(surface)) return { ok: false, error: `${surface} not linked` };
  try { const r = await send(member, text); return r && r.ok ? { ok: true, messageId: r.messageId ?? null, channel: r.channel ?? null } : { ok: false, error: r?.error || 'send failed' }; }
  catch (err) { return { ok: false, error: err.message }; }
}

/**
 * Send on every surface `surfacesFor` names and say what happened:
 * { telegram: bool, slack: bool, tgMessageId, slackChannel }.
 */
export async function deliver(member, text, channel = 'all') {
  const out = { telegram: false, slack: false, tgMessageId: null, slackChannel: null, sent: [] };
  for (const s of surfacesFor(member, channel)) {
    const r = await sendToPerson(member, text, s);
    if (!r.ok) { process.stderr.write(`[deliver] ${member.slug}: ${s} leg failed: ${r.error}\n`); continue; }
    out[s] = true;
    out.sent.push(s);
    if (s === 'telegram') out.tgMessageId = r.messageId != null ? String(r.messageId) : null;
    if (s === 'slack') out.slackChannel = r.channel || null;
  }
  return out;
}

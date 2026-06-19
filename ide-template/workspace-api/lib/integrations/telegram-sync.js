/**
 * telegram-sync — bridges the TEAM store to the Telegram integration so that:
 *
 *   1. The chat ids allowed to DM the bot track the team roster. Previously
 *      TELEGRAM_ALLOWED_IDS was only set during activation, so adding a member
 *      later left them locked out. syncTelegramAllowedIds() recomputes the list
 *      from team.telegramAllowedIds(), writes it into the integration field,
 *      flushes integrations.env, and restarts the bot to pick it up.
 *
 *   2. A relay can reach a teammate on Telegram (not just the web thread).
 *      sendTelegramMessage() sends to an arbitrary chat id straight from wsapi
 *      via the Bot API — api.telegram.org is on the egress base allowlist, and
 *      the bot token is read from the (encrypted) integration store.
 *
 * Both no-op cleanly when Telegram isn't active, so solo / Telegram-less
 * workspaces are unaffected.
 */

import * as store from './store.js';
import * as runtime from './runtime.js';
import { telegramAllowedIds } from '../team.js';

function telegramActive() {
  try { return store.isActive('telegram'); } catch { return false; }
}

/**
 * Push the team-derived allow-list into the Telegram integration + restart the
 * bot. Fire-and-forget from team routes (the caller shouldn't block its HTTP
 * response on a bot restart). Returns a small status object.
 *
 * Revoke correctness: store.update() silently skips empty-string values, so when
 * the LAST linked member is removed the field can't be blanked directly — and a
 * removed teammate would keep bot DM access. We avoid that by writing a sentinel
 * "0" (no real Telegram user id) when the list is empty: it OVERWRITES the old
 * ids (revoking them) and matches nobody. The admin keeps access via the
 * separate TELEGRAM_ADMIN_CHAT_ID that bot.sh unions in.
 */
const NO_IDS_SENTINEL = '0';

export async function syncTelegramAllowedIds() {
  if (!telegramActive()) return { skipped: 'telegram not active' };
  try {
    const ids = telegramAllowedIds();
    const joined = ids.join(',') || NO_IDS_SENTINEL;
    store.update('telegram', { fields: { TELEGRAM_ALLOWED_IDS: joined } });
    runtime.applyFiles('telegram');           // → {home}/.{bot}/integrations.env
    const restartOk = await runtime.restartBot();
    return { ok: true, count: ids.length, restartOk };
  } catch (err) {
    process.stderr.write(`[telegram-sync] allowed-ids sync failed: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
}

/**
 * Send a plain-text message to a specific Telegram chat id from wsapi. Used by
 * the cross-surface relay to ping a teammate where they prefer to be reached.
 * Returns { ok, messageId } or { ok:false, error }. Never throws.
 */
export async function sendTelegramMessage(chatId, text) {
  if (!telegramActive()) return { ok: false, error: 'telegram not active' };
  const id = String(chatId == null ? '' : chatId).trim();
  if (!/^-?\d{4,20}$/.test(id)) return { ok: false, error: 'invalid chat id' };
  const body = String(text == null ? '' : text).trim();
  if (!body) return { ok: false, error: 'empty text' };

  let token = null;
  try { token = store.decryptFor('telegram')?.TELEGRAM_BOT_TOKEN || null; } catch { token = null; }
  if (!token) return { ok: false, error: 'no bot token' };

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: id, text: body, disable_web_page_preview: true }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.ok) {
      return { ok: false, error: `telegram ${resp.status}: ${JSON.stringify(json).slice(0, 180)}` };
    }
    return { ok: true, messageId: json.result?.message_id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

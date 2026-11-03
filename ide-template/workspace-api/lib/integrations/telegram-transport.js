/**
 * Which process talks to Telegram: the channel plugin inside the bot's tmux
 * session (`plugin`, the default), or workspace-api's own listener (`wsapi`,
 * lib/integrations/telegram-listener.js). One flag, read here and nowhere
 * else, so every path that differs between the two asks the same question.
 * bot.sh and reminder-monitor.sh learn it from /internal/operator-identity.
 */
export function telegramTransport() {
  return String(process.env.TELEGRAM_TRANSPORT || '').trim().toLowerCase() === 'wsapi' ? 'wsapi' : 'plugin';
}
export const wsapiTransport = () => telegramTransport() === 'wsapi';

/**
 * Which process talks to Telegram: workspace-api's own listener (`wsapi`, the
 * default, lib/integrations/telegram-listener.js), or the channel plugin inside
 * the bot's tmux session (`plugin`, only when set; it needs the 2.1.150 CLI). One flag, read here and nowhere
 * else, so every path that differs between the two asks the same question.
 * bot.sh and reminder-monitor.sh learn it from /internal/operator-identity.
 */
export function telegramTransport() {
  return String(process.env.TELEGRAM_TRANSPORT || '').trim().toLowerCase() === 'plugin' ? 'plugin' : 'wsapi';
}
export const wsapiTransport = () => telegramTransport() === 'wsapi';

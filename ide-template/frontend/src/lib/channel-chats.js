// The chats a messenger writes into: workspace-api records each person's
// Telegram / Slack direct messages in one chat titled after the surface
// (lib/integrations/member-dm.js finds it by that title). The web shows them
// to read; the conversation itself goes on in the messenger, whose turn does
// not see what is written here.
export const CHANNEL_NAMES = { telegram: 'Telegram', slack: 'Slack' };
const BY_TITLE = { Telegram: 'telegram', Slack: 'slack' };
export const channelOf = (session) => BY_TITLE[session?.title] || null;

const ICON_BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
export const channelIconMask = (id) => {
  const mask = `url(${ICON_BASE}/integrations/${id}.svg) center / contain no-repeat`;
  return { WebkitMask: mask, mask };
};

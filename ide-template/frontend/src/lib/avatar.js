/**
 * Is the bot wearing one of the stock pictures? Those are drawn in the
 * dot-grid halftone; a picture someone uploaded is shown as it is — it was
 * chosen to be seen, and in halftone a photo became a field of dots.
 *
 * The server copies a chosen preset into the same file an upload goes to and
 * says which preset it is (`botAvatarPreset`); the demo serves the presets
 * by their own path (avatars/N.png). A deployment with no picture of its own
 * falls back to the stock look too (/bot.png).
 */
export const isStockAvatar = (url) => !url || /(^|\/)avatars\/\d+\.png(?:[?#]|$)/.test(String(url)) || /^\/bot\.png(?:[?#]|$)/.test(String(url));
export const wearsStockPicture = ({ botAvatarUrl, botAvatarPreset } = {}) => botAvatarPreset != null || isStockAvatar(botAvatarUrl);

/**
 * One of the stock pictures (avatars/N.png)? Those are drawn in the dot-grid
 * halftone; a picture someone uploaded is shown as it is — it was chosen to
 * be seen, and in halftone a photo became a field of dots.
 */
export const isStockAvatar = (url) => !url || /(^|\/)avatars\/\d+\.png(?:[?#]|$)/.test(String(url));

// The browser extension frames /app/?embed=extension in its side panel. The
// parent must be an extension page (Caddy's frame-ancestors decides which).
export const PARENT_ORIGIN = (() => {
  const o = typeof window !== 'undefined' && window.location.ancestorOrigins?.[0];
  return typeof o === 'string' && o.startsWith('chrome-extension://') ? o : null;
})();

export function isExtensionEmbed() {
  return typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('embed') === 'extension'
    && !!PARENT_ORIGIN;
}

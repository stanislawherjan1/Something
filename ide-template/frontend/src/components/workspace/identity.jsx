/**
 * Branding context — single source of truth for org name, bot identity,
 * avatar URL. Hydrated once from `GET /api/branding` and exposed via the
 * `useBranding()` hook.
 *
 * Build-time `VITE_*` env vars still feed the *server* (workspace-api reads
 * them as fallback when the user hasn't customised yet), but the frontend
 * itself no longer reads them — the API resolves the merged result.
 *
 * Until the first fetch lands the hook returns inert defaults so consumers
 * can render something instead of `undefined`.
 *
 * Side-effect: when iconUrl resolves we patch <link rel="icon"> in the
 * document head so the browser tab favicon picks up the runtime upload (or
 * build-time override) instead of the build-baked /favicon.svg. Browsers
 * cache favicons aggressively so a hard refresh is sometimes needed before
 * the change is visible.
 */

import { createContext, useContext, useEffect, useState, useCallback } from 'react';

/**
 * Neutral org-branding fallback (workspace-logo.svg). Used for logoUrl /
 * iconUrl when the per-client / runtime asset is missing. NOT used for the
 * bot avatar — see BOT_FALLBACK for that.
 *
 * Path is BASE_URL-prefixed (`/app/workspace-logo.svg` in our setup) because
 * the SPA mounts under `/app/` in both dev (Vite base) and prod (Caddy
 * routes `/app/*` → frontend nginx). A root-relative `/workspace-logo.svg`
 * would 404 in both environments.
 */
const BASE = import.meta.env.BASE_URL || '/';
const join = (p) => `${BASE}${p}`.replace(/\/{2,}/g, '/');

export const NEUTRAL_FALLBACK = join('workspace-logo.svg');
/** Generic bot avatar fallback — first preset from the 16 wizard avatars. */
export const BOT_FALLBACK     = join('avatars/1.png');

/**
 * Drop-in <img> wrapper that falls back to a static asset when the source
 * 404s. Default fallback is the org logo (workspace-logo.svg); pass
 * `fallback={BOT_FALLBACK}` for bot avatars. Use anywhere we render
 * branding.{botAvatarUrl,logoUrl,iconUrl}.
 */
export function BrandedImage({ src, alt = '', className, style, fallback = NEUTRAL_FALLBACK, ...rest }) {
  return (
    <img
      src={src || fallback}
      alt={alt}
      className={className}
      style={style}
      onError={(e) => {
        if (e.currentTarget.src.endsWith(fallback)) return;
        e.currentTarget.src = fallback;
      }}
      {...rest}
    />
  );
}

const DEFAULTS = {
  title:          'Workspace',
  botName:        'assistant',
  botDisplayName: 'Assistant',
  hideIdeText:    false,
  // Pre-fetch defaults: point to the appropriate static fallback so the
  // first paint shows a valid image instead of a broken-image icon. Once
  // /api/branding resolves these are replaced with the real URLs.
  botAvatarUrl:   BOT_FALLBACK,
  logoUrl:        NEUTRAL_FALLBACK,
  iconUrl:        NEUTRAL_FALLBACK,
  legacyMode:     false,    // when true, hide UI affordances that edit branding
  loaded:         false,
  reload:         () => {},
};

const BrandingContext = createContext(DEFAULTS);

export function BrandingProvider({ children }) {
  const [state, setState] = useState(DEFAULTS);

  const reload = useCallback(async () => {
    try {
      const resp = await fetch('/api/branding', { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setState(prev => ({
        ...prev,
        title:          data.title          ?? DEFAULTS.title,
        botName:        data.botName        ?? DEFAULTS.botName,
        botDisplayName: data.botDisplayName ?? DEFAULTS.botDisplayName,
        hideIdeText:    !!data.hideIdeText,
        botAvatarUrl:   data.botAvatarUrl   ?? DEFAULTS.botAvatarUrl,
        logoUrl:        data.logoUrl        ?? DEFAULTS.logoUrl,
        iconUrl:        data.iconUrl        ?? DEFAULTS.iconUrl,
        legacyMode:     !!data.legacyMode,
        loaded:         true,
      }));
    } catch {
      // Network blip on first load — leave defaults; UserMenu / chat will
      // still render. A subsequent reload() (e.g. after the wizard saves)
      // can recover.
      setState(prev => ({ ...prev, loaded: true }));
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Dynamic favicon — keep <link rel="icon"> in sync with the runtime icon.
  // Probes the URL with HEAD; if it 404s (per-client overrides missing) we
  // fall back to NEUTRAL_FALLBACK so the tab doesn't show a broken-image
  // sad-face. Runs whenever iconUrl changes (initial load, wizard upload,
  // settings rotation).
  useEffect(() => {
    if (!state.loaded || typeof document === 'undefined') return;
    const target = state.iconUrl || NEUTRAL_FALLBACK;
    const apply = (href) => {
      let link = document.querySelector("link[rel='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      // Only mutate if it actually changed — avoids a needless re-fetch by
      // the browser on every BrandingProvider state update.
      if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    };
    // Probe — HEAD is cheap (~50ms). If it 404s, swap to neutral SVG.
    fetch(target, { method: 'HEAD' })
      .then(r => apply(r.ok ? target : NEUTRAL_FALLBACK))
      .catch(() => apply(NEUTRAL_FALLBACK));
  }, [state.iconUrl, state.loaded]);

  return (
    <BrandingContext.Provider value={{ ...state, reload }}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding() {
  return useContext(BrandingContext);
}

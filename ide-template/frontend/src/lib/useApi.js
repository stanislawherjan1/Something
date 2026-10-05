/**
 * useApi — minimal SWR-style hook with a module-level cache.
 *
 * Why this exists:
 *   - Each dashboard tab (AI Settings, Integrations, Skills, Team, Reminders)
 *     mounts a fresh component on every navigation. Without a cache, every
 *     tab switch triggers a fresh fetch + a flash of placeholder/skeleton.
 *   - Branding already has its own provider (BrandingProvider), but the
 *     other endpoints (/api/integrations, /api/skills, /api/team, ...) were
 *     re-fetched on every mount.
 *
 * Strategy:
 *   - Module-level Map keyed by URL (or any cache key).
 *   - First mount with cache miss → loading=true, fetch, populate cache.
 *   - Subsequent mounts → instantly return cached data, kick off a
 *     background revalidate; on refresh, swap in fresh data without showing
 *     a loading state.
 *   - `invalidate(url)` and `mutate(url, data)` let mutations push fresh
 *     data into the cache so the UI stays in sync without a refetch
 *     round-trip (optimistic updates).
 *
 * Limits:
 *   - Cache is in-memory, per-tab. Closes when the tab closes. No cross-tab
 *     sync. Refresh = empty cache, loading=true again.
 *   - No focus revalidation, no polling. Add if needed; explicit `reload()`
 *     covers most cases.
 *   - No request dedup beyond "same URL fetched twice in flight" (handled
 *     via `inflight` map). Different URLs run independently.
 */

import { useEffect, useState, useCallback, useRef } from 'react';

// URL → { data, error, ts } — last successful fetch
const cache = new Map();
// URL → Promise — in-flight requests, so concurrent mounts share one fetch
const inflight = new Map();
// URL → Set<setter> — subscribers; mutations notify all mounted hooks
const subscribers = new Map();

function notify(key, payload) {
  const subs = subscribers.get(key);
  if (!subs) return;
  for (const fn of subs) fn(payload);
}

function subscribe(key, fn) {
  let subs = subscribers.get(key);
  if (!subs) { subs = new Set(); subscribers.set(key, subs); }
  subs.add(fn);
  return () => {
    subs.delete(fn);
    if (subs.size === 0) subscribers.delete(key);
  };
}

async function doFetch(url, init) {
  // Dedup concurrent mounts of the same URL.
  if (inflight.has(url)) return inflight.get(url);

  const promise = (async () => {
    try {
      const resp = await fetch(url, { credentials: 'include', ...init });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      cache.set(url, { data, error: null, ts: Date.now() });
      notify(url, { data, error: null, loading: false });
      return data;
    } catch (err) {
      // Keep stale data if any; only update the error.
      const prev = cache.get(url);
      cache.set(url, { data: prev?.data ?? null, error: err.message, ts: Date.now() });
      notify(url, { data: prev?.data ?? null, error: err.message, loading: false });
      throw err;
    } finally {
      inflight.delete(url);
    }
  })();

  inflight.set(url, promise);
  return promise;
}

/**
 * Hook — returns `{ data, error, loading, reload }`.
 *
 * On mount with a cache hit, returns cached data immediately (`loading=false`)
 * and revalidates in the background. On cache miss, `loading=true` until
 * the first fetch resolves.
 *
 * Pass `null` as the URL to skip the fetch (e.g. conditional based on auth).
 */
export function useApi(url, init) {
  // Stable init reference — re-running on every render would defeat the cache.
  const initRef = useRef(init);
  initRef.current = init;

  const cached = url ? cache.get(url) : null;
  const [state, setState] = useState(() => ({
    data:    cached?.data ?? null,
    error:   cached?.error ?? null,
    loading: !cached && !!url,
  }));

  // Subscribe so cache writes from other mounts / mutate() flow through.
  useEffect(() => {
    if (!url) return;
    return subscribe(url, (payload) => setState(payload));
  }, [url]);

  // Fetch on mount if needed; revalidate even on cache hit so background data
  // stays fresh.
  useEffect(() => {
    if (!url) return;
    if (cache.has(url)) {
      // Cache hit: revalidate silently. Don't flip loading=true — UI stays put.
      doFetch(url, initRef.current).catch(() => {});
    } else {
      setState(s => ({ ...s, loading: true }));
      doFetch(url, initRef.current).catch(() => {});
    }
  }, [url]);

  const reload = useCallback(() => {
    if (!url) return Promise.resolve(null);
    // A reload means "something changed since": a fetch already in flight may
    // have read the old state, so wait for it and fetch again rather than
    // sharing its (possibly stale) answer.
    const pending = inflight.get(url);
    const run = () => doFetch(url, initRef.current).catch(() => null);
    return pending ? pending.catch(() => null).then(run) : run();
  }, [url]);

  return { ...state, reload };
}

/** Drop a key from the cache. Next mount will refetch with `loading=true`. */
export function invalidate(url) {
  cache.delete(url);
  notify(url, { data: null, error: null, loading: true });
}

/**
 * Refetch a key now and push the result to every mounted hook.
 *
 * `invalidate` drops the cache and marks mounted hooks `loading` — which is
 * right before a remount, but on its own leaves a mounted view spinning,
 * because nothing re-runs the fetch while the URL is unchanged. This is for
 * "the server told us this changed": fetch, cache, notify.
 */
export function refetch(url) {
  if (!url) return Promise.resolve(null);
  // Same rule as reload(): never settle for a fetch that started before the change.
  const pending = inflight.get(url);
  const run = () => doFetch(url, undefined).catch(() => null);
  return pending ? pending.catch(() => null).then(run) : run();
}

/**
 * Imperatively set the cached value (e.g. after an optimistic mutation).
 * All mounted `useApi(url)` hooks update synchronously.
 */
export function mutate(url, data) {
  cache.set(url, { data, error: null, ts: Date.now() });
  notify(url, { data, error: null, loading: false });
}

/**
 * Global fetch interceptor — emits `auth:expired` when the session cookie
 * expires while the user is still on a workspace screen.
 *
 * Why this exists: 42+ raw `fetch('/api/...')` callsites in the codebase, plus
 * useApi.js. Without this, every callsite would need its own 401 detection +
 * logout dispatch. With it, ONE shim catches all of them.
 *
 * What it catches:
 *   - HTTP 401 from any /api/* response. After the nginx fix, expired sessions
 *     hit this path cleanly. (Before the fix, nginx returned 302 → /app/ and
 *     fetch auto-followed → HTML body → JSON.parse crash with "did not match
 *     the expected pattern". This shim also handles the legacy case: if a
 *     /api/* response was redirected to a non-/api/* URL, treat it as expired.)
 *
 * What it does NOT catch:
 *   - 401 from /auth/* — that endpoint legitimately returns 401 for "not
 *     logged in" during AuthContext's bootstrap, and dispatching an event
 *     there would cause re-entry / infinite loop.
 *   - Non-/api/* responses generally — only paths gated by the workspace
 *     session cookie are routed here.
 *
 * AuthContext.jsx listens for the event and flips `user` to null, which makes
 * App.jsx render LoginPage instantly without a manual refresh.
 */

let installed = false;

export function installAuthFetchInterceptor() {
  if (installed) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const resp = await originalFetch(input, init);

    // Resolve the request URL to a string we can inspect. `input` can be a
    // string, URL, or Request.
    let requestUrl = '';
    if (typeof input === 'string') requestUrl = input;
    else if (input instanceof URL) requestUrl = input.toString();
    else if (input instanceof Request) requestUrl = input.url;

    const isApiCall = requestUrl.includes('/api/');
    const isAuthCall = requestUrl.includes('/auth/');

    // Only react to /api/* paths. /auth/me etc. legitimately 401 during
    // the bootstrap and must not trigger logout-on-logout.
    if (isApiCall && !isAuthCall) {
      // After nginx fix: clean 401 on expired session.
      if (resp.status === 401) {
        window.dispatchEvent(new CustomEvent('auth:expired'));
      }
      // Legacy / partial-deploy: if nginx still 302's expired /api/* to /app/,
      // fetch auto-follows and resp.url ends up on the login page. Detect
      // and treat as expired so users on stale nginx don't get the cryptic
      // JSON-parse error.
      else if (resp.redirected && !resp.url.includes('/api/')) {
        window.dispatchEvent(new CustomEvent('auth:expired'));
      }
    }

    return resp;
  };
}

/**
 * Shared OAuth 2.0 helper for every Google Workspace MCP.
 *
 *   import { createGoogleApiClient } from '../_shared/google-oauth.js';
 *
 *   const api = createGoogleApiClient({
 *     clientId:     process.env.GDOCS_CLIENT_ID,
 *     clientSecret: process.env.GDOCS_CLIENT_SECRET,
 *     refreshToken: process.env.GDOCS_REFRESH_TOKEN,
 *   });
 *
 *   const data = await api.get('https://sheets.googleapis.com/v4/spreadsheets/abc/values/A1:B10');
 *   await api.post('https://sheets.googleapis.com/v4/spreadsheets/abc:batchUpdate', { requests: [...] });
 *   const bytes = await api.getRaw('https://www.googleapis.com/drive/v3/files/abc?alt=media');
 *
 * Behaviour:
 *   - Access token cached in-memory per-client until ~1 minute before expiry.
 *   - One automatic retry on 401 with a freshly minted token (handles the
 *     race where a token aged out between two consecutive calls).
 *   - 403 with `insufficient` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT` keyword is
 *     surfaced with a clear hint, since that's the failure mode when a user
 *     activated Sheets/Calendar/etc. without re-running OAuth Playground
 *     against the extended scope set.
 *   - JSON request/response by default; `getRaw()` returns a Buffer for binary
 *     downloads (Drive media, Gmail attachments).
 *   - No external deps — vanilla `fetch` (Node 18+).
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function createGoogleApiClient({ clientId, clientSecret, refreshToken }) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('createGoogleApiClient: clientId / clientSecret / refreshToken are required');
  }

  let cachedToken    = null;
  let tokenExpiresAt = 0;

  async function getAccessToken({ force = false } = {}) {
    const now = Date.now();
    if (!force && cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;

    const body = new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    });
    const res = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 400 invalid_grant means the refresh token was revoked (user removed
      // app access in Google Account → Security, or the integration was
      // re-issued). Caller can't recover from this except by re-running
      // OAuth Playground.
      throw new Error(`OAuth refresh failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    cachedToken    = data.access_token;
    tokenExpiresAt = now + (Number(data.expires_in) || 3600) * 1000;
    return cachedToken;
  }

  // Internal: build URL with optional ?query, fire request, handle JSON-or-text.
  async function request(method, url, opts = {}) {
    const { query, body, headers: extraHeaders, raw = false, retried = false } = opts;

    const u = url instanceof URL ? url : new URL(url);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          for (const item of v) u.searchParams.append(k, String(item));
        } else {
          u.searchParams.set(k, String(v));
        }
      }
    }

    const token = await getAccessToken();
    const reqHeaders = {
      Authorization: `Bearer ${token}`,
      Accept:        raw ? '*/*' : 'application/json',
      ...(extraHeaders || {}),
    };
    const init = { method, headers: reqHeaders };
    if (body !== undefined) {
      if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) {
        // Caller supplied a pre-serialised body (multipart, raw RFC 822, etc).
        // Don't override Content-Type — they should set it via extraHeaders.
        init.body = body;
      } else {
        reqHeaders['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }

    const res = await fetch(u.toString(), init);

    // Auto-retry on 401: cached token aged out between calls. Force-refresh
    // and try once more. Only one retry — if it still 401s, surface the error.
    if (res.status === 401 && !retried) {
      await getAccessToken({ force: true });
      return request(method, url, { ...opts, retried: true });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Surface scope-mismatch errors with an actionable hint, since this
      // is the failure mode when a user activated a Workspace integration
      // without re-running OAuth Playground after we widened scopes.
      const isScopeError = res.status === 403 &&
        /insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text);
      const hint = isScopeError
        ? '\n\nHint: your Google refresh token is missing the scope this API needs. ' +
          'Open Integrations → Google Docs → Remove, then Activate again ' +
          '(re-runs OAuth Playground with the full Workspace scope set).'
        : '';
      const apiErr = new Error(`Google API ${method} ${u.pathname} → ${res.status}: ${text}${hint}`);
      // Attach the HTTP status so callers can branch on it (e.g. 404 → "not
      // found" graceful handling) without string-matching the message.
      apiErr.status = res.status;
      throw apiErr;
    }

    if (raw) {
      const buf = await res.arrayBuffer();
      return Buffer.from(buf);
    }
    const ct = res.headers.get('content-type') ?? '';
    if (res.status === 204 || res.headers.get('content-length') === '0') return null;
    return ct.includes('application/json') ? res.json() : res.text();
  }

  return {
    get:    (url, opts) => request('GET',    url, opts),
    post:   (url, body, opts) => request('POST',   url, { ...opts, body }),
    put:    (url, body, opts) => request('PUT',    url, { ...opts, body }),
    patch:  (url, body, opts) => request('PATCH',  url, { ...opts, body }),
    delete: (url, opts) => request('DELETE', url, opts),
    /** Binary GET — returns a Buffer. Used for Drive media + Gmail attachments. */
    getRaw: (url, opts) => request('GET',    url, { ...opts, raw: true }),
    /** Force-refresh exposed for tests / debug. */
    refreshAccessToken: () => getAccessToken({ force: true }),
  };
}

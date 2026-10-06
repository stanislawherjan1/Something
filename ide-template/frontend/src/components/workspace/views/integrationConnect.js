// How an integration is switched on from a click — shared by the Integrations
// screen and the Routines Marketplace's Connect, so both take the same path.

// Remote-MCP OAuth integrations (catalog `mcp.type: "http"` + a
// remote-mcp-oauth field) activate via a provider consent popup instead of
// the credentials modal. Open remote servers (http type, no oauth field,
// e.g. Microsoft Learn) activate through the normal zero-field modal.
export const isRemoteMcpOauth = (integration) =>
  (integration?.fields || []).some(f => f.type === 'remote-mcp-oauth');

// A provider without open dynamic client registration (catalog
// `mcp.oauthClient`) needs a client the admin registered with the provider:
// its ID and secret are saved through the credentials modal first, then the
// same consent popup runs. Until the sign-in completes the server reports
// `oauthPending`, and the tile offers Connect again.
export const needsOwnOAuthClient = (integration) => !!integration?.mcp?.oauthClient;

// Whether a click should go straight to the consent popup (true) or open the
// credentials modal (false).
export const connectsByPopup = (integration) =>
  isRemoteMcpOauth(integration) && (!needsOwnOAuthClient(integration) || !!integration?.active);

// Open (no-auth) MCP servers: hosted, no OAuth, no fields — activate directly.
export const isOpenServer = (integration) =>
  integration?.mcp?.type === 'http' &&
  !isRemoteMcpOauth(integration) &&
  !((integration?.fields || []).length);

const oauthStartUrl = (integration) =>
  `/api/integrations/${encodeURIComponent(integration.id)}/oauth/start`;
const POPUP_FEATURES = 'popup,width=560,height=720';

/**
 * The provider's consent popup for a remote-MCP OAuth integration — the whole
 * activation (routes/integrations.js finishes it server-side and postMessages
 * `integration-oauth` back). Must be called synchronously inside the click
 * handler or popup blockers eat it. `onClosed` runs once when the popup closes,
 * the fallback for when it can't reach the opener. Shared by Integrations and
 * the Routines Marketplace's Connect.
 */
export function openOAuthPopup(integration, onClosed) {
  const popup = window.open(oauthStartUrl(integration), `oauth-${integration.id}`, POPUP_FEATURES);
  watchPopup(popup, onClosed);
  return !!popup;
}

/**
 * For a flow that must save something before the consent page: open an empty
 * popup synchronously inside the click (so blockers allow it), then send it
 * to the consent page with startOAuthIn() once the save has finished.
 */
export function openBlankOAuthPopup(integration) {
  return window.open('', `oauth-${integration.id}`, POPUP_FEATURES);
}

export function startOAuthIn(popup, integration, onClosed) {
  if (!popup || popup.closed) return false;
  popup.location.href = oauthStartUrl(integration);
  watchPopup(popup, onClosed);
  return true;
}

function watchPopup(popup, onClosed) {
  if (popup && onClosed) {
    const timer = setInterval(() => {
      if (popup.closed) { clearInterval(timer); onClosed(); }
    }, 700);
    setTimeout(() => clearInterval(timer), 300_000);
  }
}

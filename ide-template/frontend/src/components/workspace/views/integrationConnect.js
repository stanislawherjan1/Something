// How an integration is switched on from a click — shared by the Integrations
// screen and the Routines Marketplace's Connect, so both take the same path.

// Remote-MCP OAuth integrations (catalog `mcp.type: "http"` + a
// remote-mcp-oauth field) activate via a provider consent popup instead of
// the credentials modal. Open remote servers (http type, no oauth field,
// e.g. Microsoft Learn) activate through the normal zero-field modal.
export const isRemoteMcpOauth = (integration) =>
  (integration?.fields || []).some(f => f.type === 'remote-mcp-oauth');

// Open (no-auth) MCP servers: hosted, no OAuth, no fields — activate directly.
export const isOpenServer = (integration) =>
  integration?.mcp?.type === 'http' &&
  !isRemoteMcpOauth(integration) &&
  !((integration?.fields || []).length);

/**
 * The provider's consent popup for a remote-MCP OAuth integration — the whole
 * activation (routes/integrations.js finishes it server-side and postMessages
 * `integration-oauth` back). Must be called synchronously inside the click
 * handler or popup blockers eat it. `onClosed` runs once when the popup closes,
 * the fallback for when it can't reach the opener. Shared by Integrations and
 * the Routines Marketplace's Connect.
 */
export function openOAuthPopup(integration, onClosed) {
  const popup = window.open(
    `/api/integrations/${encodeURIComponent(integration.id)}/oauth/start`,
    `oauth-${integration.id}`,
    'popup,width=560,height=720',
  );
  if (popup && onClosed) {
    const timer = setInterval(() => {
      if (popup.closed) { clearInterval(timer); onClosed(); }
    }, 700);
    setTimeout(() => clearInterval(timer), 300_000);
  }
  return !!popup;
}

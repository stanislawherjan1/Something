// Shared by the demo build's pieces and the few app components that change in
// it. No data in here: importing it from the app costs nothing in a real build.

export const IS_DEMO = import.meta.env.VITE_DEMO === '1';

// Who the visitor is looking through: the founder (admin) or Mara (member).
const VIEWER_KEY = 'demo:viewer';
export function getViewer() {
  try { return sessionStorage.getItem(VIEWER_KEY) === 'member' ? 'member' : 'admin'; } catch { return 'admin'; }
}
export function setViewer(v) {
  try { sessionStorage.setItem(VIEWER_KEY, v === 'member' ? 'member' : 'admin'); } catch { /* private window */ }
}

// Where "Deploy your own" goes: the landing page's install section.
export const DEPLOY_URL = '/#start';

// What Aria answers in the demo, to anything: there is no model behind it.
export const DEMO_REPLY = `This is a demo, so the chat is off. Read through the conversations, or [deploy your own](${typeof location === 'undefined' ? '' : location.origin}${DEPLOY_URL}) to talk to your coworker.`;

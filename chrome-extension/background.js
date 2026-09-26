// Open the side panel when the toolbar icon is clicked, and offer
// "Change workspace" on the icon's right-click menu. Everything else lives in
// the panel itself (sidepanel.js); the service worker keeps no state.
function setup() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'change-workspace', title: 'Change workspace', contexts: ['action'] });
  });
}
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'change-workspace') return;
  // Open first: Chrome only allows it directly inside the user's click.
  if (tab?.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  // An open panel reacts to this change; a panel opening now reads it on boot.
  chrome.storage.local.set({ changeWorkspace: Date.now() });
});

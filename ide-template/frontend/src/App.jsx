import { useState, useEffect, useCallback } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AuthProvider, useAuth } from './context/AuthContext';
import TopBar from './components/TopBar';
import IdeFrame from './components/IdeFrame';
import MobileTabBar from './components/MobileTabBar';
import LoginPage from './components/LoginPage';
import AccessDenied from './components/AccessDenied';
import SetupWizard from './components/SetupWizard';
import OnboardingPreview from './components/onboarding/OnboardingPreview.jsx';
import Onboarding from './components/onboarding/Onboarding.jsx';
import WorkspacePage from './components/workspace/WorkspacePage';
import ExtensionChat from './components/workspace/ExtensionChat';
import { isExtensionEmbed } from './lib/extensionEmbed';
import { BrandingProvider, useBranding } from './components/workspace/identity';
import SharedFileView from './components/SharedFileView.jsx';

// Workspace is the default view. The legacy code-server iframe is still
// reachable via ?view=legacy (linked from UserMenu → "Open legacy IDE")
// for power users who want a terminal or VS Code editor.
const isLegacyView = () =>
  typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('view') === 'legacy';

import { useMobile } from './lib/useMobile';

function AppContent() {
  const { session, isAllowed, isLoading } = useAuth();
  const branding = useBranding();
  const isMobile = useMobile();
  const [activeTab, setActiveTab] = useState('files');

  // Setup wizard gate — fetches /api/setup/status once the user is authed.
  // While `setup === undefined` we render a spinner instead of bouncing into
  // the workspace and then blinking back into the wizard a second later.
  const [setup, setSetup] = useState(undefined);
  // Onboarding: whether this person goes through it (a fresh install's admin, or
  // someone added after onboarding existed); null when the endpoint isn't there.
  const [onb, setOnb] = useState(undefined);
  const refreshSetup = useCallback(async () => {
    try {
      const o = await fetch('/api/onboarding', { credentials: 'include' });
      setOnb(o.ok ? await o.json() : null);
    } catch { setOnb(null); }
    try {
      const resp = await fetch('/api/setup/status', { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setSetup(await resp.json());
    } catch {
      // If the endpoint is unavailable (server-side bug, transient 502) we
      // err on the side of letting the user into the workspace rather than
      // locking them out behind a wizard that itself can't load.
      setSetup({ complete: true, missing: [], state: {} });
    }
  }, []);
  useEffect(() => {
    if (!session) return;
    refreshSetup();
  }, [session, refreshSetup]);

  // Browser tab title — driven by the runtime branding store. Skip the
  // duplicate when the brand fell back to plain "Workspace" itself.
  useEffect(() => {
    if (typeof document === 'undefined' || !branding.loaded) return;
    document.title = branding.title === 'Workspace'
      ? 'Workspace'
      : `${branding.title} Workspace`;
  }, [branding.title, branding.loaded]);

  // Listen for messages from the IDE (e.g. file opened -> switch to editor).
  // Origin-check first: code-server is same-origin behind Caddy, so anything
  // from another origin is either a misconfigured embed or a malicious frame
  // and should be ignored. Also clamp ideTabRequest to known tab IDs.
  useEffect(() => {
    const ALLOWED_TABS = new Set(['files', 'editor', 'claude']);
    const handleMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data && typeof event.data.ideTabRequest === 'string'
          && ALLOWED_TABS.has(event.data.ideTabRequest)) {
        setActiveTab(event.data.ideTabRequest);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Dev-only escape: skip auth entirely when running `vite dev`. ?auth=<state>
  // lets us preview each gate without standing up auth-service:
  //   ?auth=login    → LoginPage
  //   ?auth=denied   → AccessDenied (with a fake email)
  //   ?auth=loading  → spinner
  //   ?auth=wizard   → SetupWizard with a fresh-deploy status mock
  //                    (no fetches; saves are no-ops with a 200 ms delay)
  //   (anything else / unset) → workspace (the normal default)
  // Framed by the browser extension's side panel: only the chat, nothing else.
  // It handles its own auth gate (the extension signs in when there is no session).
  if (isExtensionEmbed()) return <ExtensionChat />;

  if (import.meta.env.DEV) {
    const fake = new URLSearchParams(window.location.search).get('auth');
    // ?onboarding=a|b|c → the onboarding options under review (OnboardingPreview).
    const onboarding = new URLSearchParams(window.location.search).get('onboarding');
    // ?onboarding=real → the real wizard against a local workspace-api (DEV_LOCAL=1).
    if (onboarding === 'real') return <DevRealOnboarding />;
    if (onboarding) return <OnboardingPreview option={onboarding} />;
    if (fake === 'login')   return <LoginPage />;
    if (fake === 'denied')  return <AccessDenied />;
    if (fake === 'loading') return (
      <div className="fixed inset-0 flex items-center justify-center bg-background text-muted-foreground/70">
        <Loader2 className="size-5 animate-spin" strokeWidth={1.75} />
      </div>
    );
    if (fake === 'wizard') return (
      <SetupWizard
        mock
        status={{
          complete: false,
          missing:  ['title', 'botName', 'claudeToken'],
          state:    {
            title: '', botName: '', botDisplayName: '',
            hasAvatar: false, botAvatarUrl: '/bot.png',
            hasClaudeToken: false, claudeTokenSetAt: null,
            admins: 1, encryptionReady: true, encryptionError: null,
          },
        }}
        onComplete={() => {
          // After the user clicks "Open workspace" on step 4, hop to the
          // login preview so we land somewhere sane without rerunning the
          // wizard. Refresh the page in real life lands them in workspace.
          window.location.href = `${window.location.pathname}?auth=workspace`;
        }}
      />
    );
    return <WorkspacePage />;
  }

  if (isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background text-muted-foreground/70">
        <Loader2 className="size-5 animate-spin" strokeWidth={1.75} />
      </div>
    );
  }

  if (!session) {
    return <LoginPage />;
  }

  if (!isAllowed) {
    return <AccessDenied />;
  }

  // Setup gate — show a spinner during the initial fetch, then the wizard
  // when basics are missing. Dismissing the wizard refreshes status; the
  // user lands in the workspace once `complete: true`.
  if (setup === undefined || onb === undefined) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background text-muted-foreground/70">
        <Loader2 className="size-5 animate-spin" strokeWidth={1.75} />
      </div>
    );
  }
  if (onb && (onb.show || !setup.complete)) {
    return <Onboarding setup={setup} onb={onb} onComplete={refreshSetup} />;
  }
  // No onboarding endpoint (an older server): the plain setup wizard.
  if (!setup.complete) {
    return <SetupWizard status={setup} onComplete={refreshSetup} />;
  }

  // Legacy code-server iframe — opt-in via UserMenu, not the default.
  if (isLegacyView()) {
    return (
      <div className="app-container">
        <TopBar />
        <div className="main-content">
          <IdeFrame url="/" activeTab={isMobile ? activeTab : null} />
        </div>
        {isMobile && <MobileTabBar activeTab={activeTab} onTabChange={setActiveTab} />}
      </div>
    );
  }

  return <WorkspacePage />;
}

// Dev only: the real onboarding against a local workspace-api, without the
// sign-in (the dev proxy forges the user).
function DevRealOnboarding() {
  const [state, setState] = useState(null);
  const load = useCallback(async () => {
    const [setup, onb] = await Promise.all([
      fetch('/api/setup/status').then((r) => r.json()),
      fetch('/api/onboarding').then((r) => r.json()),
    ]);
    setState({ setup, onb });
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!state) return null;
  if (!state.onb.show && state.setup.complete) return <div className="p-10 text-[13px]">Onboarding done — the workspace would open now.</div>;
  return <Onboarding setup={state.setup} onb={state.onb} onComplete={load} />;
}

// A file shared by link: /app/s/<token>. It is for anyone with the link, so it
// renders outside sign-in, setup and the workspace altogether.
const sharedToken = () => {
  if (typeof window === 'undefined') return null;
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const m = window.location.pathname.slice(base.length).match(/^\/s\/([A-Za-z0-9_-]{20,64})\/?$/);
  return m ? m[1] : null;
};

function App() {
  const token = sharedToken();
  if (token) return <BrandingProvider><SharedFileView token={token} /></BrandingProvider>;
  // basename follows vite's `base` ('/app/'; '/demo/' for the public demo).
  // The trailing slash is dropped — React Router expects none. All in-app
  // links use route-relative paths (e.g. `/skills`); browser sees `/app/skills`.
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <AuthProvider>
        <BrandingProvider>
          <AppContent />
        </BrandingProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;

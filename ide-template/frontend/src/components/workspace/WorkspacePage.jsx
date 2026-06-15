import { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import Sidebar from './Sidebar.jsx';
import EditorPane from './EditorPane.jsx';
import ChatPane from './ChatPane.jsx';
import WelcomeScreen from './WelcomeScreen.jsx';
import NotificationToasts from './NotificationToasts.jsx';
import useFileWatcher from './useFileWatcher.js';
import { useBranding } from './identity';
import SpinningAvatar from './SpinningAvatar.jsx';
import { useMobile } from '@/lib/useMobile';
import { useApi } from '@/lib/useApi';

/**
 * URL ⇄ selected state mapping. Each top-level view has a stable path; files
 * and folders are catch-all under /files/* and /folders/*. The pathname →
 * selected helper picks the right `{ path, type }` based on the URL; the
 * inverse (selectedToPath) generates the URL the user-facing components
 * navigate to. Modals (skill editor, integration activate) stay in the same
 * top-level URL but use search params (`?edit=...`, `?activate=...`).
 */
const VIEW_ROUTES = [
  { path: '/tasks',        selected: { path: 'Tasks.md',           type: 'file' } },
  { path: '/reminders',    selected: { path: '.claude/reminders',  type: 'reminders' } },
  { path: '/skills',       selected: { path: '.claude/skills',     type: 'skills' } },
  { path: '/integrations', selected: { path: '.claude/integrations', type: 'integrations' } },
  { path: '/team',         selected: { path: '.claude/team',       type: 'team' } },
  { path: '/ai',           selected: { path: '.claude',            type: 'dashboard' } },
  { path: '/memory',       selected: { path: 'memory',             type: 'memory' } },
  { path: '/bot',          selected: { path: '.bot',               type: 'bot' } },
];

function pathnameToSelected(pathname) {
  if (!pathname || pathname === '/') return null;
  const exact = VIEW_ROUTES.find(r => r.path === pathname);
  if (exact) return exact.selected;
  if (pathname.startsWith('/files/'))   return { path: decodeURIComponent(pathname.slice('/files/'.length)),   type: 'file' };
  if (pathname.startsWith('/folders/')) return { path: decodeURIComponent(pathname.slice('/folders/'.length)), type: 'dir' };
  return null;
}

function selectedToPath(selected) {
  if (!selected) return '/';
  // Tasks.md is its own canonical /tasks URL — nicer for the sidebar
  // shortcut. Files and folders are generic types ('file', 'dir') so
  // we route them by path, NOT by type. The VIEW_ROUTES match only
  // applies to typed dashboards (skills, integrations, reminders,
  // team, dashboard) — types that uniquely identify a view.
  if (selected.path === 'Tasks.md' && selected.type === 'file') return '/tasks';
  if (selected.type === 'file') return `/files/${selected.path}`;
  if (selected.type === 'dir')  return `/folders/${selected.path}`;
  const v = VIEW_ROUTES.find(r => r.selected.type === selected.type);
  if (v) return v.path;
  return '/';
}

const TELEGRAM_BANNER_DISMISSED_KEY = 'workspace.banner.telegram.dismissed';

/**
 * Workspace — three-column shell.
 *   left:   Sidebar (collapsible — hides entirely)
 *   centre: EditorPane (file/image viewer / Kanban / Gallery / dashboard)
 *   right:  ChatPane (assistant)
 *
 * Cross-cutting state held here:
 *   selected         — which file is open in the centre pane
 *   showHidden       — whether the file tree includes technical files
 *   sidebarOpen      — render the left column at all
 *   fileEventNonce   — bumps on every chokidar event; consumers refetch.
 */
export default function WorkspacePage() {
  const { botDisplayName } = useBranding();
  const location = useLocation();
  const navigate = useNavigate();
  // selected is derived from the URL — single source of truth lives in the
  // browser's address bar. Updates flow: user click → navigate(...) →
  // useLocation re-renders → derived selected updates → views re-render.
  // Backwards compat: legacy ?view=integrations links push into history
  // once on mount, then drop the query param so it doesn't pile up.
  const selected = pathnameToSelected(location.pathname);
  const [showHidden,  setShowHidden]  = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [chatOpen,    setChatOpen]    = useState(true);
  // hasStarted is true whenever there's something in view OR the user has
  // sent a first message from the welcome screen. URL drives the file/view
  // half; sentFromWelcome covers the "user typed a message but no file yet"
  // edge case so the welcome screen doesn't snap back into view after send.
  const [sentFromWelcome, setSentFromWelcome] = useState(false);
  const hasStarted = location.pathname !== '/' || sentFromWelcome;
  const [pendingMsg,  setPendingMsg]  = useState(null);

  // Listen for `ide:chat-prefill` window events. Any modal / panel can fire
  // this to drop a draft message into the chat composer (NOT auto-send) and
  // open the chat pane. Used by the Integrations modal's "Ask <bot>" button
  // to start a help conversation about whichever integration is open.
  useEffect(() => {
    const onPrefill = (e) => {
      const text = String(e?.detail?.text || e?.detail || '').trim();
      if (!text) return;
      setPendingMsg({ text, fill: true });
      setChatOpen(true);
    };
    window.addEventListener('ide:chat-prefill', onPrefill);
    return () => window.removeEventListener('ide:chat-prefill', onPrefill);
  }, []);

  // Backwards-compat: old ?view=foo links from before path-based routing.
  // Translate once on mount, replace history so the URL doesn't flicker.
  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const legacyView = sp.get('view');
    if (!legacyView) return;
    const map = {
      integrations: '/integrations', skills: '/skills', reminders: '/reminders',
      team: '/team', tasks: '/tasks', ai: '/ai', dashboard: '/ai',
    };
    if (map[legacyView]) {
      sp.delete('view');
      const remaining = sp.toString();
      navigate(`${map[legacyView]}${remaining ? `?${remaining}` : ''}`, { replace: true });
    }
    // 'legacy' (the code-server iframe escape hatch) is handled in App.jsx,
    // not here, so leave it alone.
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  // Banner dismissal is sticky across page loads — once you click X, you've
  // told us you don't want it. Read the flag from localStorage on mount.
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    try { return window.localStorage.getItem(TELEGRAM_BANNER_DISMISSED_KEY) === '1'; }
    catch { return false; }
  });
  const fileEventNonce = useFileWatcher();
  const isMobile = useMobile();

  const { data: integrationsData } = useApi('/api/integrations');
  const isTelegramActive = !!integrationsData?.integrations?.find(i => i.id === 'telegram')?.active;
  // Show the banner only when:
  //   - the API reply is in (so we don't flash it for users who *do* have it),
  //   - telegram isn't already active,
  //   - the user hasn't dismissed it before.
  const showBanner = !!integrationsData && !isTelegramActive && !bannerDismissed;

  const dismissBanner = () => {
    setBannerDismissed(true);
    try { window.localStorage.setItem(TELEGRAM_BANNER_DISMISSED_KEY, '1'); } catch {}
  };

  // On mobile, default sidebar to closed
  useEffect(() => {
    if (isMobile) {
      setSidebarOpen(false);
    }
  }, [isMobile]);

  const handleWelcomeSend = (msg, files) => {
    setChatOpen(true);
    setPendingMsg(files && files.length ? { text: msg, files } : msg);
    setSentFromWelcome(true);
  };

  const handleHome = useCallback(() => {
    setChatOpen(false);
    setSentFromWelcome(false);
    navigate('/');
  }, [navigate]);

  const handleSelect = useCallback((item) => {
    if (item === null) { navigate('/'); return; }
    const target = selectedToPath(item);
    // Transitioning out of the welcome screen via a file/view click means
    // the user signalled intent to read / configure — not to chat. Close
    // the chat so the editor + sidebar gets the full layout. If chatOpen
    // were left at its initial `true`, the chat pane would pop up on the
    // first navigation away from `/`, forcing the user to close it before
    // they can see the document they just opened. `handleWelcomeSend`
    // still opens the chat on the chat-first welcome path.
    if (location.pathname === '/' && !sentFromWelcome) {
      setChatOpen(false);
    }
    navigate(target);
    if (isMobile) setSidebarOpen(false);
  }, [navigate, isMobile, location.pathname, sentFromWelcome]);

  return (
    <div
      className="flex h-[100dvh] w-screen flex-col overflow-hidden bg-background text-foreground antialiased"
      style={{
        fontFamily: '"Geist Variable", "Geist", -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
        fontFeatureSettings: '"cv11", "ss01", "ss03", "calt"',
      }}
    >
      {/* Server-pushed notification toasts (bottom-right overlay). Subscribes
          once to /api/notifications/stream for the whole workspace shell, so
          reminders + future skill-completion pings reach the user regardless
          of which view is active. Phase 1 of WEB_CHAT_PUSH. */}
      <NotificationToasts />
      {/* Top promo banner — Telegram CTA. Visible on desktop only; on mobile the
          chat already takes the full viewport so the banner has nowhere to live.
          The floating bot avatar (rendered below as `motion.button`) is offset
          downward when this banner is showing so it doesn't sit underneath. */}
      <AnimatePresence>
        {showBanner && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{    height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="z-[60] shrink-0 border-b border-[--color-sidebar-border] bg-background max-md:hidden"
          >
            <div className="flex h-12 items-center justify-between gap-4 px-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <img
                  src={`${(import.meta.env.BASE_URL || '/').replace(/\/+$/, '')}/integrations/telegram.svg`}
                  alt=""
                  className="size-5 shrink-0"
                />
                <p className="truncate text-[13px] text-foreground/85">
                  Add <span className="font-semibold text-foreground">{botDisplayName}</span> on Telegram and take them everywhere with you.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleSelect({ path: '.claude/integrations', type: 'integrations' })}
                  className="rounded-md bg-foreground px-3 py-1.5 text-[12px] font-medium text-background transition-colors hover:bg-foreground/85"
                >
                  Set up
                </button>
                <button
                  type="button"
                  onClick={dismissBanner}
                  title="Dismiss"
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted/50 hover:text-foreground/80"
                >
                  <X className="size-3.5" strokeWidth={1.75} />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className={cn(
          'relative flex flex-1 min-h-0 overflow-hidden md:grid',
          !hasStarted
            ? (sidebarOpen ? 'md:grid-cols-[280px_minmax(0,1fr)]' : 'md:grid-cols-[minmax(0,1fr)]')
            : cn(
                sidebarOpen && chatOpen  && 'md:grid-cols-[280px_minmax(0,1fr)_460px]',
                sidebarOpen && !chatOpen && 'md:grid-cols-[280px_minmax(0,1fr)]',
                !sidebarOpen && chatOpen  && 'md:grid-cols-[minmax(0,1fr)_460px]',
                !sidebarOpen && !chatOpen && 'md:grid-cols-[minmax(0,1fr)]',
              ),
        )}
        style={{
          transition: 'grid-template-columns 0.22s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
      {/* Mobile Sidebar Backdrop */}
      <AnimatePresence>
        {isMobile && sidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
          />
        )}
      </AnimatePresence>

      {(sidebarOpen || (!isMobile && sidebarOpen)) && (
        <Sidebar
          selected={selected}
          onSelect={handleSelect}
          onHome={handleHome}
          showHidden={showHidden}
          onToggleHidden={() => setShowHidden(s => !s)}
          onCollapseSidebar={() => setSidebarOpen(false)}
          fileEventNonce={fileEventNonce}
          className={cn(isMobile && "fixed inset-y-0 left-0 w-[280px] z-50 shadow-2xl")}
        />
      )}
      {!hasStarted ? (
        <WelcomeScreen onSend={handleWelcomeSend} sidebarOpen={sidebarOpen} onExpandSidebar={() => setSidebarOpen(true)} />
      ) : (
        <EditorPane
          selected={selected}
          onSelect={handleSelect}
          fileEventNonce={fileEventNonce}
          sidebarOpen={sidebarOpen}
          onExpandSidebar={() => setSidebarOpen(true)}
          className="flex-1"
        />
      )}
      {hasStarted && (
        <ChatPane
          onCollapse={() => setChatOpen(false)}
          onFileSelect={handleSelect}
          initialMessage={pendingMsg}
          onInitialMessageConsumed={() => setPendingMsg(null)}
          className={cn(
            isMobile && "fixed inset-0 z-50 w-full",
            !chatOpen && "hidden"
          )}
        />
      )}

      {/* Floating bot avatar — animated in/out when chat collapses (top-right) */}
      <AnimatePresence>
        {!chatOpen && (
          <motion.button
            type="button"
            onClick={() => setChatOpen(true)}
            title={`Open chat with ${botDisplayName}`}
            initial={{ opacity: 0, scale: 0.6, y: -12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{    opacity: 0, scale: 0.6, y: -12 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            whileHover={{ scale: 1.07 }}
            whileTap={{ scale: 0.93 }}
            className={cn(
              'fixed max-md:bottom-6 right-5 z-50 rounded-full shadow-[0_4px_16px_rgba(0,0,0,0.14),0_1px_3px_rgba(0,0,0,0.08)]',
              'transition-[top] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
              showBanner ? 'md:top-[68px]' : 'md:top-5',
            )}
          >
            <SpinningAvatar className="max-md:size-[60px] md:size-12" />
          </motion.button>
        )}
      </AnimatePresence>
      </div>
    </div>
  );
}

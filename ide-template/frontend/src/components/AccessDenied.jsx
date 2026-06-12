import { Lock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useBranding } from './workspace/identity';
// AccessDenied currently doesn't render a brand image (we redesigned to a
// neutral Lock icon), so no <img> swap needed here.

/**
 * Shown after a successful Google OAuth round-trip when the user's email
 * isn't on the IDE_ALLOWED_EMAILS whitelist. Sparse single-card layout —
 * one icon, one heading, one explanation, one CTA. Lots of whitespace.
 */
export default function AccessDenied() {
  const { user, signOut } = useAuth();
  const { title } = useBranding();

  // Dev mode: AuthContext returns no user, so /auth/session DELETE is moot.
  // Fake email so the UI has something to display, and route Sign out back
  // to the login screen via ?auth=login.
  const isDev = import.meta.env.DEV;
  const displayEmail = user?.email || (isDev ? 'someone@blocked.example' : null);
  const handleSignOut = isDev
    ? () => { window.location.href = `${window.location.pathname}?auth=login`; }
    : signOut;

  const workspaceName = title || 'this workspace';

  return (
    <main
      className="flex min-h-screen w-screen items-center justify-center bg-background px-6 py-10 text-foreground antialiased"
      style={{
        fontFamily: '"Geist Variable", "Geist", -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
        fontFeatureSettings: '"cv11", "ss01", "ss03", "calt"',
      }}
    >
      <div className="w-full max-w-[420px]">
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_2px_4px_rgba(0,0,0,0.04),0_24px_60px_-20px_rgba(28,27,24,0.16)]">
          <div className="flex flex-col items-center gap-7 px-10 py-12">
            <div className="flex size-14 items-center justify-center rounded-2xl border border-border/70 bg-muted/40">
              <Lock className="size-5 text-muted-foreground/70" strokeWidth={1.5} />
            </div>

            <div className="flex flex-col gap-2.5 text-center">
              <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-foreground">
                You don't have access
              </h1>
              <p className="text-[13.5px] leading-relaxed text-muted-foreground">
                {displayEmail ? (
                  <>
                    Ask an admin to add{' '}
                    <span className="font-mono text-foreground/90">{displayEmail}</span>
                    {' '}to {workspaceName}, or sign in with a different account.
                  </>
                ) : (
                  <>This account isn't on the {workspaceName} access list.</>
                )}
              </p>
            </div>

            <button
              type="button"
              onClick={handleSignOut}
              className="mt-1 inline-flex items-center justify-center rounded-xl bg-foreground/95 px-5 py-2.5 text-[13px] font-medium text-background transition-all hover:bg-foreground active:scale-[0.99]"
            >
              Sign in with another account
            </button>
          </div>
        </div>

        <p className="mt-7 text-center text-[11.5px] text-muted-foreground/55">
          {workspaceName}
        </p>
      </div>
    </main>
  );
}

import { useAuth } from '../context/AuthContext';
import { useBranding, BrandedImage } from './workspace/identity';
import TileBanner from './workspace/views/TileBanner.jsx';

/**
 * Shown after a successful Google OAuth round-trip when the user's email
 * isn't on the IDE_ALLOWED_EMAILS whitelist. The same tile as the sign-in
 * page (banner, logo on its edge, left-aligned text, one quiet button), so
 * the two read as one screen in two states.
 */
export default function AccessDenied() {
  const { user, signOut } = useAuth();
  const { title, iconUrl } = useBranding();

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
      <div className="w-full max-w-[380px] overflow-hidden rounded-[6px] border border-border/60 bg-card">
        {/* The sign-in wave, knocked out of line: same card, it didn't work. */}
        <TileBanner abstract="wave-fault" seed={title || 'sign-in'} soft className="h-28" />
        <div className="flex flex-col gap-5 px-7 pb-7">
          <BrandedImage
            src={iconUrl}
            alt={workspaceName}
            className="relative -mt-7 size-14 rounded-[6px] bg-card object-cover ring-1 ring-foreground/10"
          />

          <div className="flex flex-col gap-1">
            <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground/90">
              You don't have access
            </h1>
            <p className="text-[13px] leading-relaxed text-muted-foreground/80">
              {displayEmail ? (
                <>
                  Ask an admin to add{' '}
                  <span className="font-medium text-foreground/85">{displayEmail}</span>
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
            className="inline-flex w-full items-center justify-center rounded-[6px] border border-border/70 bg-card px-4 py-2.5 text-[13.5px] font-medium text-foreground/85 transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            Sign in with another account
          </button>
        </div>
      </div>
    </main>
  );
}

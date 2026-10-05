import { AlertTriangle } from 'lucide-react';
import { useBranding, BrandedImage } from './workspace/identity';
import TileBanner from './workspace/views/TileBanner.jsx';

/**
 * Login page — single Google sign-in button. Visual language follows the
 * workspace UI (Tailwind, Geist font, soft warm card on off-white). Three
 * states: nominal, sign-in failed (?error=…), and access denied with the
 * email shown so the admin can be told who to whitelist.
 *
 * Preserves the originally-requested URL (e.g. /app/?view=workspace) through
 * the OAuth round-trip via ?returnTo=<encoded-local-path>. The auth-service
 * validates returnTo with safeReturnTo() — only paths under /app/ pass.
 */
export default function LoginPage() {
  const { title, iconUrl } = useBranding();
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  const deniedEmail = params.get('email');

  const cleanParams = new URLSearchParams(window.location.search);
  cleanParams.delete('error');
  cleanParams.delete('email');
  cleanParams.delete('auth');   // dev-only routing param — never goes to OAuth
  const cleanSearch = cleanParams.toString();
  const returnTo = window.location.pathname + (cleanSearch ? `?${cleanSearch}` : '');
  // In dev mode (vite dev) we fake the round-trip — clicking sign-in lands
  // straight in the workspace via ?auth=workspace. No OAuth, no auth-service.
  const signInHref = import.meta.env.DEV
    ? `${window.location.pathname}?auth=workspace`
    : `/auth/google?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <main
      className="flex min-h-screen w-screen items-center justify-center bg-background px-6 py-10 text-foreground antialiased"
      style={{
        fontFamily: '"Geist Variable", "Geist", -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
        fontFeatureSettings: '"cv11", "ss01", "ss03", "calt"',
      }}
    >
      {/* One tile, the same family as the AI Settings tiles: a halftone banner,
          the organisation's logo on its edge, then the title and the button. */}
      <div className="w-full max-w-[380px] overflow-hidden rounded-[6px] border border-border/60 bg-card">
        {/* The wave to sign in; the same wave knocked out of line when it didn't work. */}
        <TileBanner abstract={error ? 'wave-fault' : 'wave'} seed={title || 'sign-in'} soft className="h-28" />
        <div className="flex flex-col gap-5 px-7 pb-7">
          <BrandedImage
            src={iconUrl}
            alt={title}
            className="relative -mt-7 size-14 rounded-[6px] bg-card object-cover ring-1 ring-foreground/10"
          />

          <div className="flex flex-col gap-1">
            <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground/90">
              Sign in to {title}
            </h1>
            <p className="text-[13px] leading-relaxed text-muted-foreground/80">
              Use your Google account to access the workspace.
            </p>
          </div>

          {error === 'access_denied' ? (
            <ErrorBanner
              title="Not on the access list"
              body={
                <>
                  <span className="font-medium text-foreground/80">{deniedEmail || 'This account'}</span>{' '}
                  isn't authorised. Ask your admin to whitelist it.
                </>
              }
            />
          ) : error ? (
            <ErrorBanner
              title="Sign-in failed"
              body="Something went wrong on our side. Try again in a moment."
            />
          ) : null}

          <a
            href={signInHref}
            className="inline-flex w-full items-center justify-center gap-2.5 rounded-[6px] border border-border/70 bg-card px-4 py-2.5 text-[13.5px] font-medium text-foreground/85 transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            <GoogleIcon />
            Sign in with Google
          </a>
        </div>
      </div>
    </main>
  );
}

function ErrorBanner({ title, body }) {
  return (
    <div className="flex items-start gap-2.5 rounded-[6px] border border-destructive/25 bg-destructive/[0.04] px-3 py-2.5">
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-destructive/85" strokeWidth={1.75} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground/90">{title}</div>
        {body && <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground/85">{body}</div>}
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden className="shrink-0">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

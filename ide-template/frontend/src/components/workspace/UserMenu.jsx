import { useState } from 'react';
import { LogOut, ChevronUp, Sun, Moon, Monitor, Check, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import useMe from './useMe.js';
import UserSettingsModal from './UserSettingsModal.jsx';

/**
 * UserMenu — avatar + display name at the bottom of the sidebar. Click opens
 * a dropdown with the user's email and a Sign out action. Falls back to
 * initials when the Google avatar URL fails to load.
 *
 * In dev mode (`?view=workspace` shortcut without auth-service running) the
 * AuthProvider returns `user: null`, so we render nothing — no fake "Sign in"
 * button to confuse the dev loop.
 */
export default function UserMenu() {
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const { me } = useMe();
  // All hooks must run before any early return — `user` populates async, so a
  // conditional hook below would change hook order between renders.
  const [open, setOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Dev mode: show placeholder if user is null
  const displayUser = user || (import.meta.env.DEV ? {
    email: 'dev@localhost',
    name: 'Dev User',
  } : null);

  if (!displayUser) return null;
  // Prefer the user's own team profile (editable in User settings) over Google.
  const name    = me?.displayName || displayUser.name || displayUser.email;
  // In a team workspace, match the Team list + settings modal exactly: custom
  // avatar → displayName initial. Don't fall back to the Google picture — it's
  // only available in this one surface, so it made the avatar differ between the
  // sidebar, Team list, and modal. In solo, the Google picture is still used.
  const avatar  = me?.avatarUrl || (me?.teamMode ? null : displayUser.picture);
  const initial = (name || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'group flex h-11 w-full items-center gap-2.5 rounded-md px-2 text-left',
          'transition-colors duration-150 hover:bg-sidebar-accent/55',
          'outline-none focus-visible:ring-0',
        )}
      >
        <Avatar src={avatar} initial={initial} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13.5px] font-medium leading-tight text-foreground">
              {name}
            </span>
          </div>
          <div className="truncate text-[11.5px] text-muted-foreground/70">
            {displayUser.email}
          </div>
        </div>
        <ChevronUp className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} strokeWidth={2} />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-full left-0 mb-2 z-50 w-[calc(100vw-32px)] md:w-full rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <button
              onClick={() => { setShowSettings(true); setOpen(false); }}
              className="w-full flex gap-2.5 items-center rounded-md px-3 py-2 text-[13px] text-foreground/85 hover:bg-muted/40 transition-colors text-left"
            >
              <Settings className="size-4 shrink-0 text-muted-foreground/65" strokeWidth={1.75} />
              User settings
            </button>
            <div className="my-1 border-t border-border/40" />
            <div className="px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Theme
            </div>
            <ThemeOption icon={Sun}     label="Light"  value="light"  current={theme} onChoose={setTheme} />
            <ThemeOption icon={Moon}    label="Dark"   value="dark"   current={theme} onChoose={setTheme} />
            <ThemeOption icon={Monitor} label="System" value="system" current={theme} onChoose={setTheme} />

            <div className="my-1 border-t border-border/40" />
            <button
              onClick={() => {
                signOut();
                setOpen(false);
              }}
              className="w-full flex gap-2.5 items-center rounded-md px-3 py-2 text-[13px] text-destructive hover:bg-destructive/10 transition-colors text-left"
            >
              <LogOut className="size-4 shrink-0" strokeWidth={1.75} />
              Sign out
            </button>
          </div>
        </>
      )}

      {showSettings && me && (
        <UserSettingsModal me={me} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}

function ThemeOption({ icon: Icon, label, value, current, onChoose }) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onChoose(value)}
      className="w-full flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] text-foreground/85 hover:bg-muted/40 transition-colors text-left"
    >
      <Icon className="size-4 text-muted-foreground/65 shrink-0" strokeWidth={1.75} />
      <span className="flex-1">{label}</span>
      {active && <Check className="size-3.5 text-foreground/85 shrink-0" strokeWidth={2.25} />}
    </button>
  );
}

function Avatar({ src, initial }) {
  // Pastel cream gradient palettes — more vibrant and visible
  const gradients = [
    'from-yellow-200 to-amber-300',
    'from-amber-200 to-orange-300',
    'from-orange-200 to-amber-300',
    'from-yellow-200 to-orange-300',
    'from-amber-300 to-yellow-300',
  ];

  // Deterministic gradient based on initial
  const gradientIdx = (initial?.charCodeAt(0) || 0) % gradients.length;
  const gradient = gradients[gradientIdx];

  return (
    <div className={cn(
      'flex size-7 shrink-0 items-center justify-center overflow-hidden',
      'rounded-full bg-gradient-to-br text-foreground text-[11px] font-semibold',
      'ring-1 ring-[--color-sidebar-border]',
      gradient,
    )}>
      {src ? (
        <img
          src={src}
          alt=""
          className="size-full object-cover"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      ) : (
        <span>{initial}</span>
      )}
    </div>
  );
}

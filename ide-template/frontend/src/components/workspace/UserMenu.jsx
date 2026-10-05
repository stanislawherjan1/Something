import { useState } from 'react';
import { LogOut, ChevronUp, Sun, Moon, Monitor, Check, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import PersonInitial from './PersonInitial.jsx';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import useMe from './useMe.js';
import { useNavigate } from 'react-router-dom';

/**
 * UserMenu — avatar + display name at the bottom of the sidebar. Click opens
 * a dropdown with the user's email and a Sign out action. Falls back to
 * initials when the Google avatar URL fails to load.
 *
 * In dev mode (`?view=workspace` shortcut without auth-service running) the
 * AuthProvider returns `user: null`, so we render nothing — no fake "Sign in"
 * button to confuse the dev loop.
 */
export default function UserMenu({ collapsed = false }) {
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const { me } = useMe();
  // All hooks must run before any early return — `user` populates async, so a
  // conditional hook below would change hook order between renders.
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

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
        title={collapsed ? name : undefined}
        className={cn(
          // px-1.5 puts the avatar's centre on the rail's 28 px axis in both states.
          'group flex h-11 w-full items-center gap-2.5 rounded-md px-1.5 text-left',
          'transition-colors duration-150 hover:bg-sidebar-accent/55',
          'outline-none focus-visible:ring-0',
        )}
      >
        <Avatar src={avatar} initial={initial} seed={displayUser.email} />
        {!collapsed && <>
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
        </>}
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className={cn(
            'menu-panel absolute z-50',
            // In the rail the menu opens to the right of the avatar, at the
            // open sidebar's width; otherwise above it, as wide as the sidebar.
            collapsed ? 'bottom-0 left-full ml-4 w-[264px]' : 'bottom-full left-0 mb-2 w-[calc(100vw-32px)] md:w-full',
          )}>
            <button
              onClick={() => { navigate('/settings'); setOpen(false); }}
              className="menu-item"
            >
              <Settings className="size-4 shrink-0 text-muted-foreground/65" strokeWidth={1.75} />
              Settings
            </button>
            <div className="menu-sep" />
            <div className="menu-label">
              Theme
            </div>
            <ThemeOption icon={Sun}     label="Light"  value="light"  current={theme} onChoose={setTheme} />
            <ThemeOption icon={Moon}    label="Dark"   value="dark"   current={theme} onChoose={setTheme} />
            <ThemeOption icon={Monitor} label="System" value="system" current={theme} onChoose={setTheme} />

            <div className="menu-sep" />
            <button
              onClick={() => {
                signOut();
                setOpen(false);
              }}
              className="menu-item hover:!text-destructive/90 [&:hover_svg]:!text-destructive/80"
            >
              <LogOut className="size-4 shrink-0" strokeWidth={1.75} />
              Sign out
            </button>
          </div>
        </>
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
      className="menu-item"
    >
      <Icon className="size-4 text-muted-foreground/65 shrink-0" strokeWidth={1.75} />
      <span className="flex-1">{label}</span>
      {active && <Check className="size-3.5 text-foreground/85 shrink-0" strokeWidth={2.25} />}
    </button>
  );
}

function Avatar({ src, initial, seed }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <PersonInitial initial={initial} seed={seed} className="size-7 text-[11.5px]" />;
  return (
    <div className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full ring-1 ring-[--color-sidebar-border]">
      <img src={src} alt="" className="size-full object-cover" onError={() => setBroken(true)} />
    </div>
  );
}

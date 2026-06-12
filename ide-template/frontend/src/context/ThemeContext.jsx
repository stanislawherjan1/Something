import { createContext, useContext, useEffect, useState, useCallback } from 'react';

/**
 * ThemeContext — three-state colour-scheme: 'light' | 'dark' | 'system'.
 *
 * The actual `<html class="dark">` flip is mirrored here AND in an inline
 * script in index.html that runs before React mounts. The early script
 * prevents flash-of-wrong-theme; this context handles runtime changes
 * (user picks new theme) and OS preference changes when on 'system'.
 *
 * Persisted in localStorage under key 'theme'. When the value is missing
 * or unrecognised, default is 'system'.
 */

const THEME_KEY = 'theme';
const VALID = new Set(['light', 'dark', 'system']);

const ThemeContext = createContext({
  theme: 'system',
  resolvedTheme: 'light',
  setTheme: () => {},
});

function readStored() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return VALID.has(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

function systemPrefersDark() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyToDom(resolved) {
  const root = document.documentElement;
  if (resolved === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
  // Keep the mobile theme-color meta in sync so the browser chrome (URL bar)
  // matches the workspace background — small detail but very visible on iOS.
  const meta = document.getElementById('theme-color-meta');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#1b1b1a' : '#f7f6f2');
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readStored);
  const [resolvedTheme, setResolvedTheme] = useState(() =>
    readStored() === 'dark' || (readStored() === 'system' && systemPrefersDark()) ? 'dark' : 'light'
  );

  // Apply on every theme change.
  useEffect(() => {
    const resolved = theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme;
    setResolvedTheme(resolved);
    applyToDom(resolved);
  }, [theme]);

  // Listen for OS preference flip — only matters when on 'system'.
  useEffect(() => {
    if (theme !== 'system') return undefined;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const resolved = mql.matches ? 'dark' : 'light';
      setResolvedTheme(resolved);
      applyToDom(resolved);
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((next) => {
    if (!VALID.has(next)) return;
    setThemeState(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

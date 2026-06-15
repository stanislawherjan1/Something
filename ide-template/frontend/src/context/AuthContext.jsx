import { createContext, useContext, useEffect, useState } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(undefined); // undefined = loading

    useEffect(() => {
        fetch('/auth/me', { credentials: 'include' })
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (data?.email) {
                    // Flat shape matching auth-service's JWT payload —
                    // we used to wrap into a Supabase-style user_metadata
                    // block, but Supabase is gone, so the wrapping was
                    // dead surface area making consumers harder to read.
                    setUser({
                        email:   data.email,
                        name:    data.name    || null,
                        picture: data.picture || null,
                        role:    data.role    || null,
                        isAdmin: Boolean(data.isAdmin),
                    });
                } else {
                    setUser(null);
                }
            })
            .catch(() => setUser(null));
    }, []);

    // Session expired mid-session: any /api/* call that hits a 401 (or the
    // legacy 302-to-/app/) dispatches `auth:expired` via the global fetch
    // interceptor in lib/authFetch.js. Flipping user to null re-renders
    // App.jsx as the LoginPage immediately, so the operator doesn't need
    // to refresh to escape the stale workspace.
    useEffect(() => {
        const handler = () => setUser(null);
        window.addEventListener('auth:expired', handler);
        return () => window.removeEventListener('auth:expired', handler);
    }, []);

    async function signOut() {
        // Dev mode: AuthContext is unused (App.jsx renders WorkspacePage
        // directly in DEV), so a real DELETE goes to workspace-api which
        // has no /auth/* — the fetch fails and the workspace stays mounted.
        // Hop to ?auth=login so we actually see the login screen.
        if (import.meta.env.DEV) {
            window.location.href = `${window.location.pathname}?auth=login`;
            return;
        }
        await fetch('/auth/session', { method: 'DELETE', credentials: 'include' });
        setUser(null);
    }

    const isLoading = user === undefined;
    // session mirrors the shape consumers expect: { user }
    const session = user ? { user } : null;
    // whitelist is enforced server-side on /auth/callback — if session exists, user is allowed
    const isAllowed = !!user;

    return (
        <AuthContext.Provider value={{ session, user, isAllowed, isLoading, signOut }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within AuthProvider');
    return ctx;
}

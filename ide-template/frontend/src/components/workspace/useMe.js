import { useApi } from '@/lib/useApi';

/**
 * The current user's team-mode identity from GET /api/me:
 *   { email, slug, role, displayName, isAdmin, personalRoot }
 *
 * Deduped/cached by useApi, so the sidebar, file split, and user menu all
 * share a single request. `me` is null until the first fetch resolves.
 */
export default function useMe() {
  const { data, loading, error, reload } = useApi('/api/me');
  return { me: data || null, loading, error, reload };
}

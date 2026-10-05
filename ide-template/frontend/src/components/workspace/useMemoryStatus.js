import { useApi } from '@/lib/useApi';

/** The migration that moves the old memory into memory v4 (routes/migrations.js). */
export const MEMORY_MIGRATION = '0005-legacy-memory-to-ledger';

/**
 * Where this workspace is with memory v4: { loaded, mode, migrated, available,
 * admin, job, reload } — one shared, cached fetch for the upgrade bar, the
 * Memory view and Routines.
 */
export function useMemoryStatus() {
  const { data, reload } = useApi('/api/migrations/status');
  // The next content migration an admin can start: the move before it has
  // run, a follow-up (the card sort) after it. `available` = there is one.
  const pending = Array.isArray(data?.pending) && data.pending.length ? data.pending[0] : null;
  return {
    loaded: !!data,
    mode: data?.memory?.mode || 'off',
    migrated: !!data?.memory?.migrated,
    available: !!data?.memory?.available || !!pending,
    admin: !!data?.admin,
    job: data?.memory?.job || null,
    pending,
    reload,
  };
}

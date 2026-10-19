// The address of a file shared by link (workspace-api routes/shares.js): the
// app's own /s/<token> page, on this workspace's domain.
export const shareUrl = (token) => `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}/s/${token}`;

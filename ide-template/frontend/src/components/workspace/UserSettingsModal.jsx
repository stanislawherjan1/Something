import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Loader2, Upload, Trash2, AlertTriangle } from 'lucide-react';
import { invalidate } from '@/lib/useApi';

/**
 * UserSettingsModal — a user edits their OWN profile: display name + avatar.
 * Launched from the UserMenu dropdown. Self-service (PATCH /api/me +
 * POST/DELETE /api/me/avatar).
 *
 * The avatar is resized to 512×512 webp ON THE CLIENT (canvas) before upload,
 * so files stay ~tens of KB and the server does zero image processing.
 */
export default function UserSettingsModal({ me, onClose }) {
  const [displayName, setDisplayName] = useState(me?.displayName || '');
  const [previewUrl, setPreviewUrl]   = useState(null);   // object URL of a freshly-picked avatar
  const [blob, setBlob]               = useState(null);   // resized webp Blob to upload
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  // Revoke the preview object URL on replace + unmount (no blob leak).
  useEffect(() => {
    if (!previewUrl) return undefined;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  // Escape to close + lock body scroll while open.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose, busy]);

  const pick = useCallback(async (file) => {
    setError(null);
    if (!file) return;
    if (!/^image\//.test(file.type)) { setError('Pick an image (PNG, JPEG, or webp).'); return; }
    try {
      const out = await resizeToWebp(file, 512);
      setBlob(out);
      setRemoveAvatar(false);
      setPreviewUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(out); });
    } catch {
      setError("Couldn't process that image — try a different one.");
    }
  }, []);

  async function save() {
    setBusy(true); setError(null);
    try {
      if (blob) {
        const fd = new FormData();
        fd.append('avatar', blob, 'avatar.webp');
        const r = await fetch('/api/me/avatar', { method: 'POST', body: fd });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Avatar upload failed (${r.status})`);
      } else if (removeAvatar) {
        const r = await fetch('/api/me/avatar', { method: 'DELETE' });
        if (!r.ok && r.status !== 404) throw new Error(`Couldn't remove avatar (${r.status})`);
      }
      const trimmed = displayName.trim();
      if (trimmed && trimmed !== me?.displayName) {
        const r = await fetch('/api/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: trimmed }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Name update failed (${r.status})`);
      }
      invalidate('/api/me');     // user menu name + avatar
      invalidate('/api/team');   // team list name + avatar
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const initial = (me?.displayName || me?.email || '?').trim().charAt(0).toUpperCase();
  const shownAvatar = previewUrl || (!removeAvatar ? me?.avatarUrl : null) || null;
  const hasExisting = !!me?.avatarUrl && !blob;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="User settings"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4 backdrop-blur-[3px]"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border/60 bg-background shadow-xl">
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
          <h2 className="text-[14px] font-semibold text-foreground/90">Your settings</h2>
          <button type="button" onClick={onClose} disabled={busy}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85 disabled:opacity-50">
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          {/* Avatar */}
          <div className="flex items-center gap-4">
            <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-amber-200 to-orange-300 text-[20px] font-semibold text-foreground ring-1 ring-border/60">
              {shownAvatar
                ? <img src={shownAvatar} alt="" className="size-full object-cover" />
                : <span>{initial}</span>}
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground/75">Profile picture</span>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border/55 px-2.5 py-1 text-[12px] font-medium text-foreground/85 hover:bg-muted/40 disabled:opacity-50">
                  <Upload className="size-3.5" strokeWidth={1.75} /> Upload
                </button>
                {(hasExisting || blob) && (
                  <button type="button"
                    onClick={() => { setBlob(null); setPreviewUrl((o) => { if (o) URL.revokeObjectURL(o); return null; }); setRemoveAvatar(true); }}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground/75 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50">
                    <Trash2 className="size-3.5" strokeWidth={1.75} /> Remove
                  </button>
                )}
              </div>
              <span className="text-[11px] text-muted-foreground/65">Resized to 512×512 · stored as a small webp</span>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
          </div>

          {/* Display name */}
          <label className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground/75">Display name</span>
            <input
              type="text" value={displayName} maxLength={100}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="How your name shows to the team"
              className="rounded-md border border-border/55 bg-background px-3 py-2 text-[13.5px] text-foreground/90 outline-none transition-colors focus:border-foreground/35"
            />
            <span className="text-[11px] text-muted-foreground/65">{me?.email}</span>
          </label>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90 disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={busy || !displayName.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition-colors hover:bg-foreground/85 disabled:opacity-50">
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Resize an image file to a `size`×`size` webp Blob, cover-fit + center-cropped.
function resizeToWebp(file, size) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode failed'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        canvas.toBlob(
          (b) => b ? resolve(b) : reject(new Error('encode failed')),
          'image/webp', 0.85,
        );
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

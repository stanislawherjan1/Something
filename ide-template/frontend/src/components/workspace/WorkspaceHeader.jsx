import { useState, useRef, useEffect } from 'react';
import { PanelLeftClose, Settings, X, Loader2, Save, Check, Upload, Building2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBranding, BrandedImage } from './identity';

/**
 * Sidebar header — workspace mark + brand name. On hover surfaces a gear
 * (workspace settings: title + logo) and a collapse button.
 */
export default function WorkspaceHeader({ onCollapseSidebar, onHome }) {
  const branding = useBranding();
  const [showSettings, setShowSettings] = useState(false);
  // Gear is always available — even in legacy mode the user can override
  // env-derived branding via .branding.json (file wins over env). The flag
  // is kept on the resolved branding so the modal can show an info banner.
  const showGear = true;

  return (
    <div className="group flex h-14 shrink-0 items-center gap-2.5 px-3.5">
      <div 
        onClick={onHome}
        className={cn(
          'flex size-7 shrink-0 items-center justify-center overflow-hidden cursor-pointer hover:opacity-75 transition-opacity',
          'rounded-sm border border-[--color-sidebar-border] bg-background',
        )}
      >
        <BrandedImage
          src={branding.iconUrl}
          alt=""
          className="size-full object-contain"
        />
      </div>
      <div 
        onClick={onHome}
        className="min-w-0 flex-1 cursor-pointer hover:opacity-75 transition-opacity"
      >
        <div className="truncate text-[15.5px] font-semibold leading-none tracking-[-0.01em] text-foreground">
          {branding.title}
        </div>
      </div>
      {showGear && (
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          title="Workspace settings"
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md',
            'text-muted-foreground/60 opacity-0 transition-all duration-150',
            'hover:bg-sidebar-accent/60 hover:text-foreground/80',
            'group-hover:opacity-100 focus-visible:opacity-100',
          )}
        >
          <Settings className="size-[15px]" strokeWidth={1.75} />
        </button>
      )}
      {onCollapseSidebar && (
        <button
          type="button"
          onClick={onCollapseSidebar}
          title="Hide sidebar"
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md',
            'text-muted-foreground/60 opacity-0 transition-all duration-150',
            'hover:bg-sidebar-accent/60 hover:text-foreground/80',
            'group-hover:opacity-100 focus-visible:opacity-100',
          )}
        >
          <PanelLeftClose className="size-[15px]" strokeWidth={1.75} />
        </button>
      )}
      {showSettings && (
        <WorkspaceSettingsModal
          branding={branding}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

/* ─── Settings modal ────────────────────────────────────────────────────── */

function WorkspaceSettingsModal({ branding, onClose }) {
  const [title, setTitle]               = useState(branding.title === 'Workspace' ? '' : (branding.title || ''));
  const [logoFile, setLogoFile]         = useState(null);
  const [logoPreview, setLogoPreview]   = useState(null);
  const [busy, setBusy]                 = useState(false);
  const [saved, setSaved]               = useState(false);
  const [error, setError]               = useState(null);
  const logoInputRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // Revoke object URLs to avoid leaking them while the modal is open.
  useEffect(() => () => { if (logoPreview) URL.revokeObjectURL(logoPreview); }, [logoPreview]);

  const pickLogo = (file) => {
    if (!file) { setLogoFile(null); if (logoPreview) URL.revokeObjectURL(logoPreview); setLogoPreview(null); return; }
    if (file.size > 2 * 1024 * 1024) { setError('Logo must be under 2 MiB.'); return; }
    if (!/^image\/(png|jpe?g|svg\+xml)$/i.test(file.type)) { setError('Logo must be PNG, JPEG, or SVG.'); return; }
    setError(null);
    if (logoPreview) URL.revokeObjectURL(logoPreview);
    setLogoFile(file);
    setLogoPreview(URL.createObjectURL(file));
  };

  const trimmed = title.trim();
  const titleChanged = trimmed && trimmed !== branding.title;
  const dirty = titleChanged || !!logoFile;

  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    try {
      if (titleChanged) {
        const r = await fetch('/api/setup/branding', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: trimmed }),
        });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${r.status}`);
        }
      }
      if (logoFile) {
        const fd = new FormData();
        fd.append('avatar', logoFile);
        const r = await fetch('/api/setup/logo', { method: 'POST', body: fd });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${r.status}`);
        }
      }
      await branding.reload();
      setSaved(true);
      setLogoFile(null);
      if (logoPreview) URL.revokeObjectURL(logoPreview);
      setLogoPreview(null);
      setTimeout(() => setSaved(false), 1600);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const currentLogo = logoPreview || branding.logoUrl;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Workspace settings"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-[3px]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Settings className="size-4 text-foreground/75" strokeWidth={1.75} />
            <h2 className="text-[14px] font-semibold text-foreground/90">Workspace settings</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex flex-col gap-5 px-5 py-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/65">
              Organisation name
            </span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Acme · Globex · Initech"
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-md border border-border/60 bg-background px-3 py-2 text-[13.5px] text-foreground outline-none transition-all focus:border-foreground/60 focus:ring-2 focus:ring-foreground/10"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/65">
              Logo
            </span>
            <div
              onClick={() => logoInputRef.current?.click()}
              className={cn(
                'group flex cursor-pointer items-center gap-3 rounded-md border border-dashed px-3.5 py-3 transition-all',
                logoFile
                  ? 'border-[--color-ring]/50 bg-[--color-ring]/5'
                  : 'border-border hover:border-foreground/25 hover:bg-muted/40',
              )}
            >
              <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-background">
                {currentLogo
                  ? <BrandedImage src={currentLogo} alt="" className="size-full object-contain p-0.5" />
                  : <Building2 className="size-4 text-muted-foreground" strokeWidth={1.75} />
                }
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13px] font-medium text-foreground">
                  {logoFile ? 'Logo selected' : 'Replace logo'}
                </span>
                <span className="text-[11.5px] text-muted-foreground/65">
                  {logoFile ? logoFile.name : 'PNG, JPEG, or SVG · up to 2 MiB'}
                </span>
              </div>
              {logoFile
                ? <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); pickLogo(null); }}
                    className="text-[11.5px] text-[--color-ring] hover:underline"
                  >
                    Remove
                  </button>
                : <Upload className="size-4 text-muted-foreground/45 group-hover:text-muted-foreground" strokeWidth={1.75} />
              }
              <input
                ref={logoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml"
                className="hidden"
                onChange={(e) => pickLogo(e.target.files?.[0] || null)}
              />
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90"
          >
            Close
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85 disabled:opacity-50"
          >
            {busy
              ? <Loader2 className="size-3.5 animate-spin" />
              : saved
                ? <Check className="size-3.5" strokeWidth={2.5} />
                : <Save className="size-3.5" strokeWidth={2} />}
            {busy ? 'Saving…' : saved ? 'Saved' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

import { cn } from '@/lib/utils';
import TileBanner from './TileBanner.jsx';

// One picture in an avatar picker: a square tile, ringed when selected.
// `halftone` draws presets the way the bot appears everywhere else.
// Shared by the AI Settings bot modal and the setup wizard, with the list of
// preset pictures both of them offer.

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
// 1..16 minus the ones withdrawn from the picker. The files stay in public/ —
// a bot already wearing a withdrawn picture keeps it rather than 404ing.
const WITHDRAWN_AVATARS = new Set(['6']);

export const PRESET_AVATARS = Array.from({ length: 16 }, (_, i) => ({
  id: String(i + 1),
  url: `${BASE}/avatars/${i + 1}.png`,
})).filter((a) => !WITHDRAWN_AVATARS.has(a.id));

export default function Tile({ src, selected, onClick, label, halftone = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={selected}
      className={cn(
        'relative aspect-square overflow-hidden rounded-[6px] transition-all duration-150',
        selected
          ? 'opacity-100 ring-2 ring-ring ring-offset-2 ring-offset-background'
          : cn('ring-1 ring-border/60 hover:opacity-100 hover:ring-foreground/25', !halftone && 'opacity-60'),
      )}
    >
      {halftone
        ? <TileBanner image={src} mode="dark" center plain step={1.7} scale={1} seed={label} paper className="!h-full" />
        : <img src={src} alt="" className="size-full object-cover" />}
    </button>
  );
}

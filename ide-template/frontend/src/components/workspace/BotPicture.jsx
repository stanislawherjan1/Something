/**
 * The bot's picture — one component for every place the bot's face appears,
 * so it always looks the same. A stock picture is drawn as the screens'
 * dot-grid halftone; one someone uploaded is shown as it is. Falls back to
 * the stock avatar when none is set. Size and shape come from `className`
 * (it fills its box; round it with `rounded-full`).
 */
import { cn } from '@/lib/utils';
import TileBanner from './views/TileBanner.jsx';
import { wearsStockPicture } from '@/lib/avatar';
import { useBranding, BOT_FALLBACK, BrandedImage } from './identity';

export default function BotPicture({ className }) {
  const branding = useBranding();
  const src = branding.botAvatarUrl || BOT_FALLBACK;
  return (
    <div className={cn('relative shrink-0 overflow-hidden', className)}>
      {wearsStockPicture(branding)
        ? <TileBanner image={src} mode="dark" center plain step={1.7} scale={1} seed="bot" paper className="!absolute inset-0 !h-full" />
        : <BrandedImage src={src} fallback={BOT_FALLBACK} className="absolute inset-0 size-full object-cover" />}
    </div>
  );
}

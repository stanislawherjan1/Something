/**
 * The bot's picture as the screens' dot-grid halftone — one component for
 * every place the bot's face appears, so it always looks the same. Falls
 * back to the stock avatar when none is set. Size and shape come from
 * `className` (it fills its box; round it with `rounded-full`).
 */
import { cn } from '@/lib/utils';
import TileBanner from './views/TileBanner.jsx';
import { useBranding, BOT_FALLBACK } from './identity';

export default function BotPicture({ className }) {
  const { botAvatarUrl } = useBranding();
  return (
    <div className={cn('relative shrink-0 overflow-hidden', className)}>
      <TileBanner image={botAvatarUrl || BOT_FALLBACK} mode="dark" center plain step={1.7} scale={1} seed="bot" paper className="!absolute inset-0 !h-full" />
    </div>
  );
}

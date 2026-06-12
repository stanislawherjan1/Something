import { cn } from '@/lib/utils';
import { useBranding, BrandedImage, BOT_FALLBACK } from './identity';

export default function SpinningAvatar({ size, className }) {
  const { botAvatarUrl } = useBranding();
  const style = className ? undefined : { width: (size || 9) * 4, height: (size || 9) * 4 };
  return (
    <div className={cn("relative shrink-0 rounded-full", className)} style={style}>
      <div
        className="absolute inset-0 rounded-full animate-[spin_8s_linear_infinite]"
        style={{
          background: 'conic-gradient(from 0deg, transparent 60%, rgba(0,0,0,0.18) 100%)',
          padding: '2px',
          borderRadius: '9999px',
        }}
      >
        <div className="size-full rounded-full bg-background" />
      </div>
      <div className="absolute inset-[2px] overflow-hidden rounded-full bg-muted">
        <BrandedImage
          src={botAvatarUrl}
          fallback={BOT_FALLBACK}
          alt=""
          className="size-full object-cover"
        />
      </div>
    </div>
  );
}

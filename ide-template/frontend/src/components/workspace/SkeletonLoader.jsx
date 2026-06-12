import { cn } from '@/lib/utils';

export function SkeletonLine({ width = '100%', height = '16px', className }) {
  return (
    <div
      className={cn('rounded animate-pulse bg-muted-foreground/20', className)}
      style={{ width, height }}
    />
  );
}

export function SkeletonCircle({ size = '24px', className }) {
  return (
    <div
      className={cn('rounded-full animate-pulse bg-muted-foreground/20', className)}
      style={{ width: size, height: size }}
    />
  );
}

export function SkeletonFileRow({ depth = 0 }) {
  return (
    <div
      className="flex h-7 items-center gap-1.5 rounded-md px-2"
      style={{ paddingLeft: `${10 + depth * 12}px` }}
    >
      <SkeletonCircle size="16px" />
      <SkeletonLine width="60%" height="14px" />
    </div>
  );
}

export function SkeletonEditorHeader() {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2.5 px-6">
      <SkeletonCircle size="15px" />
      <SkeletonLine width="40%" height="16px" />
      <div className="ml-auto">
        <SkeletonLine width="100px" height="14px" />
      </div>
    </div>
  );
}

export function SkeletonFolderGrid() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
      {[...Array(8)].map((_, i) => (
        <div key={i} className="flex flex-col items-center gap-2 rounded-lg p-3 border border-border/50">
          <SkeletonCircle size="24px" />
          <SkeletonLine width="100%" height="12px" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonText() {
  return (
    <div className="space-y-2">
      <SkeletonLine width="100%" height="20px" />
      <SkeletonLine width="95%" height="16px" />
      <SkeletonLine width="98%" height="16px" />
    </div>
  );
}

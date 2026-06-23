import { cn } from "@/lib/utils";

type SkeletonBlockProps = {
  className?: string;
};

export function SkeletonBlock({ className }: SkeletonBlockProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-[6px] bg-surface-muted", className)}
    />
  );
}

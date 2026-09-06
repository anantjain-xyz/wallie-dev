import { cn } from "@/lib/utils";

export function ShimmerText({ active = true, children }: { active?: boolean; children: string }) {
  return <span className={cn(active && "activity-shimmer")}>{children}</span>;
}

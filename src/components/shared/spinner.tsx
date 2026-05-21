import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

type SpinnerProps = {
  label?: string;
  size?: "sm" | "md";
} & HTMLAttributes<HTMLSpanElement>;

export function Spinner({ className, label, size = "sm", ...props }: SpinnerProps) {
  return (
    <span
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cn(
        "inline-block shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent",
        size === "md" ? "h-4 w-4" : "h-3 w-3",
        className,
      )}
      role={label ? "status" : undefined}
      {...props}
    />
  );
}

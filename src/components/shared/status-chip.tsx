import type { ReactNode } from "react";

import { formatSentenceCaseLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";

const toneClasses = {
  blocked: "border-danger/20 bg-danger-soft text-danger",
  planned: "border-border-strong bg-surface-muted text-muted",
  ready: "border-accent/16 bg-accent-soft text-accent",
} as const;

type StatusChipProps = {
  children: ReactNode;
  tone?: keyof typeof toneClasses;
};

export function StatusChip({ children, tone = "planned" }: StatusChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
        toneClasses[tone],
      )}
    >
      {typeof children === "string" ? formatSentenceCaseLabel(children) : children}
    </span>
  );
}

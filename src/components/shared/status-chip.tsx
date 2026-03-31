import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const toneClasses = {
  blocked:
    "border-red-400/60 bg-red-500/10 text-red-900 shadow-[0_0_0_1px_rgba(185,28,28,0.05)]",
  planned:
    "border-slate-400/60 bg-slate-900/5 text-slate-700 shadow-[0_0_0_1px_rgba(15,23,42,0.05)]",
  ready:
    "border-amber-500/60 bg-amber-500/15 text-amber-950 shadow-[0_0_0_1px_rgba(180,83,9,0.05)]",
} as const;

type StatusChipProps = {
  children: ReactNode;
  tone?: keyof typeof toneClasses;
};

export function StatusChip({
  children,
  tone = "planned",
}: StatusChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.24em]",
        toneClasses[tone],
      )}
    >
      {children}
    </span>
  );
}

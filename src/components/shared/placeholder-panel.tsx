import type { ReactNode } from "react";

import { StatusChip } from "@/components/shared/status-chip";
import { cn } from "@/lib/utils";

type PanelTone = "blocked" | "planned" | "ready";

type PlaceholderPanelProps = {
  children?: ReactNode;
  className?: string;
  eyebrow: string;
  items?: string[];
  summary: string;
  title: string;
  tone?: PanelTone;
};

export function PlaceholderPanel({
  children,
  className,
  eyebrow,
  items = [],
  summary,
  title,
  tone = "planned",
}: PlaceholderPanelProps) {
  return (
    <section
      className={cn(
        "ui-panel p-6",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-3">
          <p className="text-[11px] font-medium text-muted">
            {eyebrow}
          </p>
          <h2 className="max-w-2xl text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {title}
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-muted sm:text-base">
            {summary}
          </p>
        </div>
        <StatusChip tone={tone}>{tone}</StatusChip>
      </div>

      {items.length ? (
        <ul className="mt-6 grid gap-3 text-sm leading-6 text-foreground/85">
          {items.map((item) => (
            <li
              key={item}
              className="ui-subpanel px-4 py-3"
            >
              {item}
            </li>
          ))}
        </ul>
      ) : null}

      {children ? <div className="mt-6">{children}</div> : null}
    </section>
  );
}

import type { ReactNode } from "react";

import { StatusChip } from "@/components/shared/status-chip";
import { cn } from "@/lib/utils";

type PanelTone = "blocked" | "planned" | "ready";

type PlaceholderPanelProps = {
  children?: ReactNode;
  className?: string;
  eyebrow?: string;
  items?: string[];
  summary: string;
  title: string;
  titleAs?: "h1" | "h2" | "h3";
  tone?: PanelTone;
};

export function PlaceholderPanel({
  children,
  className,
  eyebrow,
  items = [],
  summary,
  title,
  titleAs = "h2",
  tone = "planned",
}: PlaceholderPanelProps) {
  const TitleTag = titleAs;

  return (
    <section className={cn("ui-panel p-6", className)}>
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-3">
          {eyebrow ? (
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted">{eyebrow}</p>
          ) : null}
          <TitleTag className="type-page-title max-w-2xl">{title}</TitleTag>
          <p className="max-w-2xl text-[14px] leading-6 text-muted">{summary}</p>
        </div>
        <StatusChip tone={tone}>{tone}</StatusChip>
      </header>

      {items.length ? (
        <ul className="mt-6 grid gap-3 text-sm leading-6 text-foreground/85">
          {items.map((item) => (
            <li key={item} className="ui-subpanel px-4 py-3">
              {item}
            </li>
          ))}
        </ul>
      ) : null}

      {children ? <div className="mt-6">{children}</div> : null}
    </section>
  );
}

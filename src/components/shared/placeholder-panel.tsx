import type { ReactNode } from "react";

import { Status, type StatusValue } from "@/components/ui/status";
import { cn } from "@/lib/utils";

type PanelTone = "blocked" | "planned" | "ready";

const panelStatusValues = {
  blocked: "blocked",
  planned: "upcoming",
  ready: "healthy",
} satisfies Record<PanelTone, StatusValue>;

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
    <section className={cn("ui-sheet p-6", className)}>
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-3">
          {eyebrow ? (
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted">{eyebrow}</p>
          ) : null}
          <TitleTag className="type-page-title max-w-2xl">{title}</TitleTag>
          <p className="max-w-2xl text-[14px] leading-6 text-muted">{summary}</p>
        </div>
        <Status
          label={tone === "planned" ? "Planned" : undefined}
          value={panelStatusValues[tone]}
        />
      </header>

      {items.length ? (
        <ul className="mt-6 divide-y divide-border border-y border-border text-sm leading-6 text-foreground/85">
          {items.map((item) => (
            <li key={item} className="py-3">
              {item}
            </li>
          ))}
        </ul>
      ) : null}

      {children ? <div className="mt-6">{children}</div> : null}
    </section>
  );
}

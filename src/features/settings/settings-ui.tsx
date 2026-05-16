import type { ReactNode } from "react";

import type { WorkspaceUsageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";

export const dateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export const interactiveLinkClass =
  "font-semibold text-foreground transition-colors duration-150 hover:text-accent focus-visible:rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30";

export function Section({
  anchorId,
  children,
  statusBadge,
  tagline,
  title,
}: {
  anchorId?: string;
  children: ReactNode;
  statusBadge?: ReactNode;
  tagline?: ReactNode;
  title: string;
}) {
  return (
    <section id={anchorId} className="scroll-mt-8">
      <header className="settings-section-header mb-6">
        <div className="space-y-1">
          <h2 className="text-[18px] font-semibold tracking-tight text-foreground">{title}</h2>
          {tagline ? <p className="text-[13px] leading-5 text-muted">{tagline}</p> : null}
        </div>
        {statusBadge ? <div className="shrink-0">{statusBadge}</div> : null}
      </header>
      <div>{children}</div>
    </section>
  );
}

export type BadgeTone = "success" | "warning" | "danger" | "neutral" | "accent";

export function StatusBadge({
  children,
  tone,
  withDot = true,
}: {
  children: ReactNode;
  tone: BadgeTone;
  withDot?: boolean;
}) {
  const toneClassName = {
    success: "ui-badge-success",
    warning: "ui-badge-warning",
    danger: "ui-badge-danger",
    neutral: "ui-badge-neutral",
    accent: "ui-badge-accent",
  }[tone];

  return (
    <span className={`ui-badge ${toneClassName}`}>
      {withDot ? <span className="ui-badge-dot" /> : null}
      {children}
    </span>
  );
}

export function toneClass(kind: FlashMessage["kind"]) {
  switch (kind) {
    case "error":
      return "border-danger/20 bg-danger-soft text-danger";
    case "info":
      return "border-accent/20 bg-accent-soft text-accent";
    default:
      return "border-success/20 bg-success-soft text-success";
  }
}

export function ConfigState({ missingKeys, title }: { missingKeys: string[]; title: string }) {
  if (missingKeys.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1 rounded-[6px] border border-warning/20 bg-warning-soft px-4 py-3 text-sm leading-6 text-warning">
      <p className="font-semibold">{title}</p>
      <p>Missing env vars: {missingKeys.join(", ")}</p>
    </div>
  );
}

export function AvatarFallback({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "W";

  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-[10px] border border-border bg-surface-strong text-xl font-semibold text-foreground">
      {initial}
    </div>
  );
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function UsageCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 px-5 py-4">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      <span className="text-[20px] font-semibold tracking-tight text-foreground">{value}</span>
    </div>
  );
}

export function UsageSummary({ usage }: { usage: WorkspaceUsageData }) {
  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-surface sm:grid-cols-4 sm:divide-y-0">
      <UsageCell label="Total runs" value={String(usage.totalRuns)} />
      <UsageCell label="Input tokens" value={formatTokens(usage.totalInputTokens)} />
      <UsageCell label="Output tokens" value={formatTokens(usage.totalOutputTokens)} />
      <UsageCell label="Total cost" value={`$${usage.totalCostUsd.toFixed(2)}`} />
    </div>
  );
}

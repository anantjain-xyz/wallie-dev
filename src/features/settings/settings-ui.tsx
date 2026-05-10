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

export function Section({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="space-y-5 rounded-[20px] bg-surface px-5 py-5 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_12px_28px_rgba(16,24,40,0.05)] sm:px-6 sm:py-6">
      <h2 className="text-base font-semibold tracking-tight text-balance text-foreground">
        {title}
      </h2>
      <div>{children}</div>
    </section>
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
    <div className="ui-subpanel flex h-20 w-20 items-center justify-center text-2xl font-semibold text-foreground">
      {initial}
    </div>
  );
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function UsageSummary({ usage }: { usage: WorkspaceUsageData }) {
  return (
    <div className="space-y-4">
      <p className="text-sm leading-7 text-muted">
        Aggregate token usage and costs across all agent runs in this workspace.
      </p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="ui-subpanel space-y-1 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Total Runs</p>
          <p className="text-lg font-semibold text-foreground">{usage.totalRuns}</p>
        </div>
        <div className="ui-subpanel space-y-1 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Input Tokens</p>
          <p className="text-lg font-semibold text-foreground">
            {formatTokens(usage.totalInputTokens)}
          </p>
        </div>
        <div className="ui-subpanel space-y-1 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Output Tokens</p>
          <p className="text-lg font-semibold text-foreground">
            {formatTokens(usage.totalOutputTokens)}
          </p>
        </div>
        <div className="ui-subpanel space-y-1 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Total Cost</p>
          <p className="text-lg font-semibold text-foreground">${usage.totalCostUsd.toFixed(2)}</p>
        </div>
      </div>
    </div>
  );
}

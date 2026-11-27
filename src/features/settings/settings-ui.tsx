import type { ReactNode } from "react";

import type { WorkspaceUsageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { cn } from "@/lib/utils";

export const dateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export const interactiveLinkClass =
  "font-semibold text-foreground transition-colors duration-150 hover:text-accent focus-visible:rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30";

export function Section({
  actions,
  anchorId,
  children,
  className,
  heading: Heading = "h2",
  statusBadge,
  tagline,
  title,
}: {
  actions?: ReactNode;
  anchorId?: string;
  children: ReactNode;
  className?: string;
  heading?: "h2" | "h3";
  statusBadge?: ReactNode;
  tagline?: ReactNode;
  title: string;
}) {
  return (
    <section className={cn("min-w-0 scroll-mt-4", className)} id={anchorId}>
      <header className="settings-section-header mb-4">
        <div className="min-w-0 space-y-1">
          <Heading
            className={cn(
              "text-pretty break-words focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              Heading === "h2" ? "type-section-title" : "type-body font-semibold text-foreground",
            )}
            data-settings-heading={anchorId ? "" : undefined}
            tabIndex={anchorId ? -1 : undefined}
          >
            {title}
          </Heading>
          {tagline ? <p className="type-secondary break-words text-muted">{tagline}</p> : null}
        </div>
        {statusBadge || actions ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {statusBadge}
            {actions}
          </div>
        ) : null}
      </header>
      {children}
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

export function InlineActionMessage({
  className = "",
  message,
}: {
  className?: string;
  message: FlashMessage | null;
}) {
  if (!message) {
    return null;
  }

  return (
    <div
      aria-live="polite"
      className={`rounded-[6px] border px-3 py-2 text-[13px] leading-5 ${toneClass(message.kind)} ${className}`}
      role={message.kind === "error" ? "alert" : "status"}
    >
      {message.text}
    </div>
  );
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

const runCount = new Intl.NumberFormat();
const tokenCount = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const usdCost = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

function UsageCell({ label, note, value }: { label: string; note?: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 px-5 py-4">
      <span className="text-xs font-medium text-muted">{label}</span>
      <span className="text-[20px] font-semibold tabular-nums tracking-tight text-foreground">
        {value}
      </span>
      {note ? <span className="text-xs text-muted">{note}</span> : null}
    </div>
  );
}

function metricNote(
  unavailable: boolean,
  estimated: boolean,
  hasKnownValue: boolean,
): string | undefined {
  if (unavailable && !hasKnownValue) return "Provider did not report";
  if (unavailable && estimated) return "Partial · includes estimates";
  if (unavailable) return "Partial · some runs unavailable";
  if (estimated) return "Includes estimates";
  return undefined;
}

export function UsageSummary({ usage }: { usage: WorkspaceUsageData }) {
  const empty = usage.totalRuns === 0 && !usage.tokensUnavailable && !usage.costUnavailable;
  if (empty) return <p className="type-body text-muted">No runs have started yet.</p>;
  const input =
    usage.totalInputTokens === null
      ? "Unavailable"
      : `${tokenCount.format(usage.totalInputTokens)}${usage.tokensUnavailable ? "+" : ""}`;
  const output =
    usage.totalOutputTokens === null
      ? "Unavailable"
      : `${tokenCount.format(usage.totalOutputTokens)}${usage.tokensUnavailable ? "+" : ""}`;
  const cost =
    usage.totalCostUsd === null
      ? "Unavailable"
      : `${usdCost.format(usage.totalCostUsd)}${usage.costUnavailable ? "+" : ""}`;
  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-[6px] border border-border bg-sheet sm:grid-cols-4 sm:divide-y-0">
      <UsageCell label="Runs started" value={runCount.format(usage.totalRuns)} />
      <UsageCell
        label="Input tokens"
        note={metricNote(
          usage.tokensUnavailable,
          usage.hasEstimatedTokens,
          usage.totalInputTokens !== null,
        )}
        value={input}
      />
      <UsageCell
        label="Output tokens"
        note={metricNote(
          usage.tokensUnavailable,
          usage.hasEstimatedTokens,
          usage.totalOutputTokens !== null,
        )}
        value={output}
      />
      <UsageCell
        label="Run cost (USD)"
        note={metricNote(
          usage.costUnavailable,
          usage.hasEstimatedCost,
          usage.totalCostUsd !== null,
        )}
        value={cost}
      />
    </div>
  );
}

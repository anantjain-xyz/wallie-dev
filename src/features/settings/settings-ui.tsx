import { PageSection } from "@/components/ui/page-shell";
import type { WorkspaceUsageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";

export const dateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export const interactiveLinkClass =
  "font-semibold text-foreground transition-colors duration-150 hover:text-accent focus-visible:rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30";

// Re-export the shared PageSection under the legacy "Section" name so the
// settings sub-components keep importing from this module unchanged.
export const Section = PageSection;

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

export function AvatarFallback({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "W";

  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-[6px] border border-border bg-control-hover text-xl font-semibold text-foreground">
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
      <span className="text-xs font-medium text-muted">{label}</span>
      <span className="text-[20px] font-semibold tracking-tight text-foreground">{value}</span>
    </div>
  );
}

export function UsageSummary({ usage }: { usage: WorkspaceUsageData }) {
  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-[6px] border border-border bg-sheet sm:grid-cols-4 sm:divide-y-0">
      <UsageCell label="Total runs" value={String(usage.totalRuns)} />
      <UsageCell label="Input tokens" value={formatTokens(usage.totalInputTokens)} />
      <UsageCell label="Output tokens" value={formatTokens(usage.totalOutputTokens)} />
      <UsageCell label="Total cost" value={`$${usage.totalCostUsd.toFixed(2)}`} />
    </div>
  );
}

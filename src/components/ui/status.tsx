import type { CSSProperties, HTMLAttributes } from "react";

import type { PipelinePhaseStatus } from "@/lib/pipeline/types";
import type { Enums } from "@/lib/supabase/database.types";
import { cn } from "@/lib/utils";

export const STATUS_VALUES = [
  "awaiting_review",
  "agent_generating",
  "running",
  "approved",
  "complete",
  "rejected",
  "failed",
  "queued",
  "upcoming",
  "canceled",
  "archived",
  "skipped",
  "healthy",
  "needs_attention",
  "blocked",
  "not_started",
] as const;

export type StatusValue = (typeof STATUS_VALUES)[number];
export type StatusTone =
  | "attention"
  | "progress"
  | "success"
  | "warning"
  | "danger"
  | "neutral"
  | "subdued";
export type ConfigurationStatus = Extract<
  StatusValue,
  "healthy" | "needs_attention" | "blocked" | "not_started"
>;

type StatusIcon =
  | "attention"
  | "progress"
  | "success"
  | "warning"
  | "danger"
  | "neutral"
  | "subdued";

export type StatusDefinition = {
  description: string;
  icon: StatusIcon;
  label: string;
  tone: StatusTone;
};

export const STATUS_DEFINITIONS = {
  awaiting_review: {
    description: "Needs review before the session can continue.",
    icon: "attention",
    label: "Awaiting review",
    tone: "attention",
  },
  agent_generating: {
    description: "The agent is generating the stage artifact.",
    icon: "progress",
    label: "Agent generating",
    tone: "progress",
  },
  running: {
    description: "Work is in progress.",
    icon: "progress",
    label: "Running",
    tone: "progress",
  },
  approved: {
    description: "The stage artifact was approved.",
    icon: "success",
    label: "Approved",
    tone: "success",
  },
  complete: {
    description: "Work completed successfully.",
    icon: "success",
    label: "Complete",
    tone: "success",
  },
  rejected: {
    description: "Changes were requested before this work can continue.",
    icon: "warning",
    label: "Changes requested",
    tone: "warning",
  },
  failed: {
    description: "Work stopped because of an error.",
    icon: "danger",
    label: "Failed",
    tone: "danger",
  },
  queued: {
    description: "Work is queued and has not started.",
    icon: "neutral",
    label: "Queued",
    tone: "neutral",
  },
  upcoming: {
    description: "This stage has not started yet.",
    icon: "neutral",
    label: "Upcoming",
    tone: "neutral",
  },
  canceled: {
    description: "Work was canceled.",
    icon: "subdued",
    label: "Canceled",
    tone: "subdued",
  },
  archived: {
    description: "This item is archived.",
    icon: "subdued",
    label: "Archived",
    tone: "subdued",
  },
  skipped: {
    description: "This step was skipped.",
    icon: "subdued",
    label: "Skipped",
    tone: "subdued",
  },
  healthy: {
    description: "Configuration is healthy.",
    icon: "success",
    label: "Healthy",
    tone: "success",
  },
  needs_attention: {
    description: "Configuration needs attention.",
    icon: "warning",
    label: "Needs attention",
    tone: "warning",
  },
  blocked: {
    description: "Configuration is blocked.",
    icon: "danger",
    label: "Blocked",
    tone: "danger",
  },
  not_started: {
    description: "Configuration has not started.",
    icon: "neutral",
    label: "Not started",
    tone: "neutral",
  },
} satisfies Record<StatusValue, StatusDefinition>;

const UNKNOWN_STATUS_DEFINITION: StatusDefinition = {
  description: "The application received a status it does not recognize.",
  icon: "neutral",
  label: "Unknown status",
  tone: "neutral",
};

export const SESSION_PHASE_STATUS_VALUES = {
  agent_generating: "agent_generating",
  awaiting_review: "awaiting_review",
  approved: "approved",
  rejected: "rejected",
} satisfies Record<PipelinePhaseStatus, StatusValue>;

type AgentRunStatus = Enums<"agent_run_status">;

export const AGENT_RUN_STATUS_VALUES = {
  canceled: "canceled",
  error: "failed",
  queued: "queued",
  running: "running",
  started: "running",
  success: "complete",
} satisfies Record<AgentRunStatus, StatusValue>;

export type ConfigurationStatusTone = "accent" | "danger" | "neutral" | "success" | "warning";

export const CONFIGURATION_STATUS_BY_TONE = {
  accent: "not_started",
  danger: "blocked",
  neutral: "not_started",
  success: "healthy",
  warning: "needs_attention",
} satisfies Record<ConfigurationStatusTone, ConfigurationStatus>;

export function sessionPhaseStatusValue(status: PipelinePhaseStatus): StatusValue {
  return SESSION_PHASE_STATUS_VALUES[status];
}

export function agentRunStatusValue(status: AgentRunStatus): StatusValue {
  return AGENT_RUN_STATUS_VALUES[status];
}

export function configurationStatusFromTone(tone: ConfigurationStatusTone): ConfigurationStatus {
  return CONFIGURATION_STATUS_BY_TONE[tone];
}

export function resolveStatusDefinition(value: unknown): StatusDefinition {
  if (typeof value === "string" && Object.hasOwn(STATUS_DEFINITIONS, value)) {
    return STATUS_DEFINITIONS[value as StatusValue];
  }

  if (process.env.NODE_ENV === "development") {
    console.warn("Unknown product status", { value });
  }

  return UNKNOWN_STATUS_DEFINITION;
}

const toneClasses: Record<StatusTone, string> = {
  attention: "border-accent bg-accent-soft text-accent font-semibold",
  danger: "border-danger/30 bg-danger-soft text-danger",
  neutral: "border-border bg-surface-muted text-muted",
  progress: "border-accent/30 bg-accent-soft text-accent",
  subdued: "border-border bg-surface-muted text-muted opacity-80",
  success: "border-success/30 bg-success-soft text-success",
  warning: "border-warning/30 bg-warning-soft text-warning",
};

export type StatusProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  /** Keeps the full label visible while reducing padding for dense layouts. */
  compact?: boolean;
  /** Overrides the grammar description when the surrounding context can be more specific. */
  description?: string;
  /** Overrides display copy without changing the status's semantic tone or icon. */
  label?: string;
  /** Optional determinate progress from 0 to 100. */
  progress?: number;
  /** Compile-time status grammar. Invalid runtime values still fail safely. */
  value: StatusValue;
};

export function Status({
  className,
  compact = false,
  description,
  label,
  progress,
  value,
  ...props
}: StatusProps) {
  const definition = resolveStatusDefinition(value);
  const visibleLabel = label ?? definition.label;
  const accessibleDescription = description ?? definition.description;
  const normalizedProgress =
    typeof progress === "number" && Number.isFinite(progress)
      ? Math.min(100, Math.max(0, progress))
      : null;

  return (
    <span
      aria-label={`${visibleLabel}. ${accessibleDescription}`}
      className={cn(
        "ui-status inline-flex max-w-full items-center gap-1.5 rounded-full border text-xs leading-5",
        compact ? "px-2 py-0.5" : "px-2.5 py-1",
        toneClasses[definition.tone],
        className,
      )}
      data-status={typeof value === "string" ? value : "unknown"}
      data-tone={definition.tone}
      {...props}
    >
      <StatusGlyph icon={definition.icon} />
      <span className="min-w-0 whitespace-nowrap">{visibleLabel}</span>
      {normalizedProgress === null ? null : (
        <span
          aria-label={`${visibleLabel} progress`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={normalizedProgress}
          className="ui-status-progress h-1.5 w-12 overflow-hidden rounded-full bg-current/15"
          role="progressbar"
        >
          <span
            className="ui-status-progress-value block h-full rounded-full bg-current"
            style={{ "--status-progress": `${normalizedProgress}%` } as CSSProperties}
          />
        </span>
      )}
    </span>
  );
}

function StatusGlyph({ icon }: { icon: StatusIcon }) {
  const className = cn(
    "ui-status-icon h-3.5 w-3.5 shrink-0",
    icon === "progress" && "animate-spin motion-reduce:animate-none",
  );

  switch (icon) {
    case "attention":
      return (
        <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 16 16">
          <path d="M8 2.25 13.75 8 8 13.75 2.25 8 8 2.25Z" stroke="currentColor" />
          <path d="M8 5.25v3.5M8 11h.01" stroke="currentColor" strokeLinecap="round" />
        </svg>
      );
    case "progress":
      return (
        <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 16 16">
          <path d="M13 8a5 5 0 1 1-5-5" stroke="currentColor" strokeLinecap="round" />
        </svg>
      );
    case "success":
      return (
        <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="5.25" stroke="currentColor" />
          <path d="m5.5 8 1.6 1.6 3.4-3.4" stroke="currentColor" strokeLinecap="round" />
        </svg>
      );
    case "warning":
      return (
        <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 16 16">
          <path d="M8 2.4 14 13H2L8 2.4Z" stroke="currentColor" strokeLinejoin="round" />
          <path d="M8 6v3.2M8 11.4h.01" stroke="currentColor" strokeLinecap="round" />
        </svg>
      );
    case "danger":
      return (
        <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="5.25" stroke="currentColor" />
          <path d="m6.25 6.25 3.5 3.5m0-3.5-3.5 3.5" stroke="currentColor" strokeLinecap="round" />
        </svg>
      );
    case "subdued":
      return (
        <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="5.25" stroke="currentColor" />
          <path d="M5.5 8h5" stroke="currentColor" strokeLinecap="round" />
        </svg>
      );
    case "neutral":
      return (
        <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="5.25" stroke="currentColor" />
          <path d="M8 5v3.25l2 1.25" stroke="currentColor" strokeLinecap="round" />
        </svg>
      );
  }
}

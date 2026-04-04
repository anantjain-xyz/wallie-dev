import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import {
  formatIssueEstimate,
  formatIssuePriority,
  formatIssueStatus,
  getIssueMemberDisplayName,
  type IssueMember,
  type IssuePriority,
  type IssueStatus,
} from "@/features/issues/types";

const statusToneClasses: Record<IssueStatus, string> = {
  backlog: "border-border-strong bg-surface-muted text-muted",
  todo: "border-accent/18 bg-accent-soft text-accent",
  in_progress: "border-warning/18 bg-warning-soft text-warning",
  in_review: "border-accent/18 bg-accent-soft text-accent",
  done: "border-success/18 bg-success-soft text-success",
  canceled: "border-danger/18 bg-danger-soft text-danger",
};

const priorityToneClasses: Record<IssuePriority, string> = {
  urgent: "border-danger/18 bg-danger-soft text-danger",
  high: "border-warning/18 bg-warning-soft text-warning",
  medium: "border-accent/18 bg-accent-soft text-accent",
  low: "border-success/18 bg-success-soft text-success",
  none: "border-border-strong bg-surface-muted text-muted",
};

function Badge({ children, className }: { children: ReactNode; className: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function IssueStatusBadge({ status }: { status: IssueStatus }) {
  return <Badge className={statusToneClasses[status]}>{formatIssueStatus(status)}</Badge>;
}

export function IssuePriorityBadge({ priority }: { priority: IssuePriority }) {
  return <Badge className={priorityToneClasses[priority]}>{formatIssuePriority(priority)}</Badge>;
}

export function IssueEstimateBadge({ estimatePoints }: { estimatePoints: number | null }) {
  return (
    <Badge className="border-border bg-surface-muted text-muted">
      {formatIssueEstimate(estimatePoints)}
    </Badge>
  );
}

export function IssueMemberBadge({
  fallback = "Unassigned",
  member,
}: {
  fallback?: string;
  member: IssueMember | null;
}) {
  const label = member ? getIssueMemberDisplayName(member) : fallback;

  return (
    <span className="inline-flex items-center rounded-full border border-border bg-surface-strong px-2.5 py-1 text-[11px] font-medium text-foreground/85">
      {label}
      {member?.kind === "system" ? " (system)" : ""}
    </span>
  );
}

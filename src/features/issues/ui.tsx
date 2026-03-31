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
  backlog: "border-slate-400/50 bg-slate-900/5 text-slate-700",
  todo: "border-blue-400/45 bg-blue-500/10 text-blue-900",
  in_progress: "border-amber-500/50 bg-amber-500/16 text-amber-950",
  in_review: "border-violet-500/40 bg-violet-500/14 text-violet-950",
  done: "border-emerald-500/45 bg-emerald-500/12 text-emerald-950",
  canceled: "border-rose-400/40 bg-rose-500/10 text-rose-900",
};

const priorityToneClasses: Record<IssuePriority, string> = {
  urgent: "border-rose-500/45 bg-rose-500/12 text-rose-950",
  high: "border-orange-500/45 bg-orange-500/12 text-orange-950",
  medium: "border-amber-500/45 bg-amber-500/12 text-amber-950",
  low: "border-lime-500/45 bg-lime-500/12 text-lime-950",
  none: "border-slate-400/45 bg-slate-900/5 text-slate-700",
};

function Badge({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold capitalize tracking-[0.12em]",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function IssueStatusBadge({ status }: { status: IssueStatus }) {
  return (
    <Badge className={statusToneClasses[status]}>
      {formatIssueStatus(status)}
    </Badge>
  );
}

export function IssuePriorityBadge({ priority }: { priority: IssuePriority }) {
  return (
    <Badge className={priorityToneClasses[priority]}>
      {formatIssuePriority(priority)}
    </Badge>
  );
}

export function IssueEstimateBadge({
  estimatePoints,
}: {
  estimatePoints: number | null;
}) {
  return (
    <Badge className="border-border/80 bg-background/70 text-muted">
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
    <span className="inline-flex items-center rounded-full border border-border/75 bg-surface-strong/70 px-3 py-1 text-sm text-foreground/85">
      {label}
      {member?.kind === "system" ? " (system)" : ""}
    </span>
  );
}

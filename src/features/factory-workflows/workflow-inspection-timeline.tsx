"use client";

import Link from "next/link";
import { useId } from "react";

import { TimeDisplay } from "@/components/shared/time-display";
import { Status, type StatusValue } from "@/components/ui/status";
import type {
  WorkflowInspectionEvent as Event,
  WorkflowInspectionHeader,
} from "@/lib/factory-workflows/inspection-contracts";
import { workspaceRunDetailPath, workspaceSessionDetailPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type EventLink = { href: string; label: string };
type EventRow = { event: Event; children: EventRow[] };
type EventContents = {
  title: string;
  notes?: readonly (string | null | undefined)[];
  links?: readonly (EventLink | null)[];
  commitSha?: string | null;
  validationTreeSha?: string | null;
};
type TimelineContext = {
  idPrefix: string;
  initialNow: string;
  subject: WorkflowInspectionHeader["subject"];
  workspaceSlug: string;
  events: readonly Event[];
};

const statuses: Record<string, { value: StatusValue; label: string }> = {
  admitted: { value: "queued", label: "Admitted" },
  adopted: { value: "complete", label: "Adopted" },
  approved: { value: "approved", label: "Approved" },
  awaiting_review: { value: "awaiting_review", label: "Awaiting human approval" },
  awaiting_validation: { value: "queued", label: "Awaiting validation" },
  blocked: { value: "blocked", label: "Blocked" },
  canceled: { value: "canceled", label: "Canceled" },
  claimed: { value: "running", label: "Publishing" },
  clarification: { value: "needs_attention", label: "Clarification requested" },
  conflict: { value: "blocked", label: "Merge conflict" },
  error: { value: "failed", label: "Failed" },
  failed: { value: "failed", label: "Failed" },
  findings: { value: "needs_attention", label: "Findings reported" },
  historical: { value: "complete", label: "Historical artifact" },
  in_progress: { value: "in_progress", label: "In progress" },
  missing: { value: "needs_attention", label: "Output missing" },
  optional_failure: { value: "needs_attention", label: "Optional output failed" },
  partial: { value: "needs_attention", label: "Partial delivery" },
  pass: { value: "complete", label: "Review passed" },
  paused: { value: "upcoming", label: "Paused" },
  pending: { value: "queued", label: "Pending" },
  queued: { value: "queued", label: "Queued" },
  ready: { value: "complete", label: "Ready" },
  rejected: { value: "rejected", label: "Changes requested" },
  required_blocked: { value: "blocked", label: "Required output blocked" },
  running: { value: "running", label: "Running" },
  started: { value: "running", label: "Starting" },
  success: { value: "complete", label: "Succeeded" },
  succeeded: { value: "complete", label: "Succeeded" },
  validation_failed: { value: "failed", label: "Validation failed" },
};

function readable(value: string) {
  return value.replaceAll(/[_-]/g, " ");
}

function statusFor(event: Event): { value: StatusValue; label: string } {
  let state = event.state;
  if (event.kind === "artifact") state = event.detail.approvalState ?? state;
  if (event.kind === "join" && event.detail.deliveryStatus === "partial") state = "partial";
  if (Object.hasOwn(statuses, state)) return statuses[state];
  const label = readable(state);
  return {
    value: "not_started",
    label: label ? label[0].toUpperCase() + label.slice(1) : "Unavailable",
  };
}

function nestEvents(events: readonly Event[]): EventRow[] {
  const rows = events.map((event): EventRow => ({ event, children: [] }));
  const children = new Map(
    rows.flatMap((row) =>
      row.event.kind === "child" && row.event.detail.childSessionId
        ? [[row.event.detail.childSessionId, row] as const]
        : [],
    ),
  );
  const roots: EventRow[] = [];
  for (const row of rows) {
    const { event } = row;
    const parentId =
      event.kind === "child"
        ? event.detail.parentSessionId
        : event.kind === "attempt" || event.kind === "artifact" || event.kind === "approval"
          ? event.detail.sessionId
          : null;
    const parent = parentId ? children.get(parentId) : null;
    if (parent && parent !== row) parent.children.push(row);
    else roots.push(row);
  }
  return roots;
}

function anchor({ idPrefix }: TimelineContext, { kind, id }: Event) {
  return `${idPrefix}-${kind}-${id}`;
}

function describe({ event, context }: { event: Event; context: TimelineContext }): EventContents {
  const { workspaceSlug } = context;
  const session = (number: number | null | undefined, label = "Session"): EventLink | null =>
    number == null
      ? null
      : { href: workspaceSessionDetailPath(workspaceSlug, number), label: `${label} #${number}` };
  const run = (id: string | null | undefined, label: string): EventLink | null =>
    id ? { href: workspaceRunDetailPath(workspaceSlug, id), label } : null;
  const receipt = (target: Event | undefined, label: string): EventLink | null =>
    target ? { href: `#${encodeURIComponent(anchor(context, target))}`, label } : null;
  const nextReview = (occurrenceId: string | null | undefined) =>
    occurrenceId
      ? receipt(
          context.events.find(
            (item) => item.kind === "review" && item.occurrenceId === occurrenceId,
          ) ??
            context.events.find(
              (item) => item.kind === "occurrence" && item.occurrenceId === occurrenceId,
            ),
          "Next review",
        )
      : null;
  const artifact = (
    {
      sessionNumber,
      stageSlug,
      artifactId,
      artifactVersion,
    }: {
      sessionNumber?: number | null;
      stageSlug?: string | null;
      artifactId?: string | null;
      artifactVersion?: number | null;
    },
    review = false,
  ): EventLink | null =>
    sessionNumber && stageSlug && artifactId && artifactVersion
      ? {
          href: workspaceSessionDetailPath(workspaceSlug, sessionNumber, {
            artifactStage: stageSlug,
            artifactId,
            artifactVersion,
          }),
          label: `${review ? "Review" : "Open"} artifact v${artifactVersion}`,
        }
      : null;

  switch (event.kind) {
    case "occurrence":
      return {
        title: event.nodeId ? `Step · ${event.nodeId}` : "Workflow step",
        notes: [
          event.detail.nodeKind ? readable(event.detail.nodeKind) : null,
          event.detail.entry ? "Workflow entry" : null,
        ],
      };
    case "transition":
      return {
        title: event.detail.edgeId ? `Transition · ${event.detail.edgeId}` : "Transition",
        notes: [event.detail.edgeKind ? readable(event.detail.edgeKind) : null],
      };
    case "route":
      return {
        title: "Route decision",
        notes: [
          event.detail.selectedDestinationId
            ? `Destination ${event.detail.selectedDestinationId}`
            : null,
          event.detail.selectedEdgeId ? `Transition ${event.detail.selectedEdgeId}` : null,
        ],
      };
    case "foreman":
      return {
        title: "Foreman",
        notes: [event.detail.blocker ? readable(event.detail.blocker) : null],
        links: [
          session(event.detail.sessionNumber),
          run(event.detail.checkpointRunId, "Foreman input run"),
        ],
      };
    case "branch": {
      const { admissionBlocker, branchEdgeId, required, runId, sessionNumber } = event.detail;
      const label = required ? "Required branch output" : "Optional branch output";
      return {
        title: branchEdgeId ? `${label} · ${branchEdgeId}` : label,
        notes: [
          admissionBlocker ? readable(admissionBlocker) : null,
          !required &&
          !event.detail.outcomeId &&
          ["missing", "optional_failure"].includes(event.state)
            ? "No accepted output"
            : null,
        ],
        links: [session(sessionNumber, "Child session"), run(runId, "Branch output run")],
      };
    }
    case "child":
      return {
        title: event.detail.sessionNumber
          ? `Child session #${event.detail.sessionNumber}`
          : "Child session",
        notes: [event.detail.repositoryName],
        links: [
          session(event.detail.parentSessionNumber, "Parent session"),
          session(event.detail.sessionNumber, "Open session"),
          run(event.detail.runId, "Admitted run"),
        ],
      };
    case "attempt":
      return {
        title:
          event.detail.attemptCount == null ? "Attempt" : `Attempt ${event.detail.attemptCount}`,
        notes: [
          event.detail.source ? readable(event.detail.source) : null,
          event.detail.retired
            ? "Retired attempt"
            : event.detail.current
              ? "Current attempt"
              : null,
          !event.detail.runId && event.state === "queued" ? "Run not started" : null,
        ],
        links: [session(event.detail.sessionNumber), run(event.detail.runId, "Open exact run")],
      };
    case "join":
      return {
        title: event.nodeId ? `Join · ${event.nodeId}` : "Join",
        notes: [
          event.detail.repositoryName,
          event.detail.deliveryStatus === "partial"
            ? "Primary checkpoint adopted. Secondary delivery is incomplete."
            : event.detail.wholeJoinComplete
              ? "Join completed"
              : null,
          event.detail.omittedBranchEdgeIds?.length
            ? `Omitted optional outputs ${event.detail.omittedBranchEdgeIds.join(", ")}`
            : null,
        ],
        links: [
          run(event.detail.inputRunId, "Join input run"),
          run(event.detail.runId, "Join output run"),
          artifact(event.detail),
        ],
      };
    case "repository":
      return {
        title: event.detail.repositoryName ?? "Repository delivery",
        notes: [
          event.detail.blocker ? readable(event.detail.blocker) : null,
          event.detail.remoteReconciliationRequired ? "Remote reconciliation required" : null,
          event.detail.attempts
            ? `${event.detail.attempts} publication attempt${event.detail.attempts === 1 ? "" : "s"}`
            : null,
        ],
        links: [
          run(event.detail.validationRunId ?? event.detail.runId, "Repository validation run"),
        ],
        commitSha: event.detail.commitSha,
        validationTreeSha: event.detail.validationTreeSha,
      };
    case "review":
      return {
        title: event.nodeId ? `Exact review · ${event.nodeId}` : "Exact review",
        notes: [event.detail.blocker ? readable(event.detail.blocker) : null],
        links: [
          run(event.detail.runId, "Reviewed checkpoint run"),
          artifact(event.detail),
          nextReview(event.detail.nextReviewOccurrenceId),
        ],
        commitSha: event.detail.commitSha,
        validationTreeSha: event.detail.validationTreeSha,
      };
    case "repair":
      return {
        title: "Review repair",
        links: [
          event.detail.reviewReceiptId
            ? receipt(
                context.events.find(
                  (item) =>
                    item.kind === "review" &&
                    item.detail.reviewReceiptId === event.detail.reviewReceiptId,
                ),
                "Review that requested repair",
              )
            : null,
          event.detail.priorRepairReceiptId
            ? receipt(
                context.events.find(
                  (item) =>
                    item.kind === "repair" &&
                    item.detail.repairReceiptId === event.detail.priorRepairReceiptId,
                ),
                "Previous repair",
              )
            : null,
          run(event.detail.runId, "Repair run"),
          event.detail.outputRunId !== event.detail.runId
            ? run(event.detail.outputRunId, "Repaired checkpoint run")
            : null,
          nextReview(event.detail.nextReviewOccurrenceId),
        ],
      };
    case "artifact":
      return {
        title: `Artifact v${event.detail.artifactVersion ?? "—"}`,
        notes: [event.detail.repositoryName],
        links: [
          artifact(event.detail, event.detail.approvalState === "awaiting_review"),
          run(event.detail.runId, "Artifact-producing run"),
        ],
        commitSha: event.detail.commitSha,
      };
    case "approval":
      return {
        title: "Human approval",
        links: [artifact(event.detail), run(event.detail.runId, "Approved artifact run")],
      };
    case "lifecycle":
      return {
        title: "Lifecycle change",
        notes: [
          event.detail.action ? readable(event.detail.action) : null,
          event.detail.generation == null ? null : `Generation ${event.detail.generation}`,
        ],
      };
    default: {
      const unexpected: never = event;
      return unexpected;
    }
  }
}

function EventItem({
  row,
  context,
  level,
}: {
  row: EventRow;
  context: TimelineContext;
  level: number;
}) {
  const { event, children } = row;
  const content = describe({ event, context });
  const selected =
    event.kind === "attempt" &&
    Boolean(context.subject.runId && event.detail.runId === context.subject.runId);
  return (
    <li className="min-w-0">
      <article
        data-focused-run={selected || undefined}
        id={anchor(context, event)}
        className={cn(
          "min-w-0 scroll-mt-8 space-y-1.5 rounded-md border border-border px-3 py-2",
          selected && "border-accent bg-accent-soft",
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <h4 className="min-w-0 font-medium [overflow-wrap:anywhere]">{content.title}</h4>
          <Status compact {...statusFor(event)} />
        </div>
        {selected ? <p className="text-xs font-medium text-accent">Selected run</p> : null}
        <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted [overflow-wrap:anywhere]">
          <TimeDisplay
            absoluteStyle="short"
            initialNow={context.initialNow}
            value={event.recordedAt}
          />
          {content.notes?.map((note, index) => (note ? <span key={index}>{note}</span> : null))}
        </div>
        {content.commitSha || content.validationTreeSha ? (
          <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
            {content.commitSha ? (
              <span>
                Commit <code title={content.commitSha}>{content.commitSha.slice(0, 12)}</code>
              </span>
            ) : null}
            {content.validationTreeSha ? (
              <span>
                Validation tree{" "}
                <code title={content.validationTreeSha}>
                  {content.validationTreeSha.slice(0, 12)}
                </code>
              </span>
            ) : null}
          </div>
        ) : null}
        {content.links?.some(Boolean) ? (
          <ul
            className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs"
            aria-label="Related records"
          >
            {content.links.map((link) =>
              link ? (
                <li key={link.label}>
                  <Link
                    className="text-accent underline underline-offset-4"
                    href={link.href}
                    prefetch={false}
                  >
                    {link.label}
                  </Link>
                </li>
              ) : null,
            )}
          </ul>
        ) : null}
      </article>
      {children.length ? (
        <ol
          aria-label="Child sessions and attempts"
          className={cn(
            "mt-2 grid min-w-0 list-none gap-2",
            level < 2 && "ml-2 border-l border-border pl-2 sm:ml-4 sm:pl-4",
          )}
        >
          {children.map((child) => (
            <EventItem
              key={`${child.event.kind}:${child.event.id}`}
              context={context}
              row={child}
              level={level + 1}
            />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

export function WorkflowInspectionTimeline({
  events,
  initialNow,
  subject,
  workspaceSlug,
}: Omit<TimelineContext, "idPrefix">) {
  const idPrefix = useId();
  const context = { idPrefix, events, initialNow, subject, workspaceSlug };
  return (
    <section aria-label="Workflow timeline" className="min-w-0">
      <h3 className="mb-2 font-medium">Execution history</h3>
      {events.length ? (
        <ol className="grid min-w-0 list-none gap-2">
          {nestEvents(events).map((row) => (
            <EventItem
              key={`${row.event.kind}:${row.event.id}`}
              context={context}
              row={row}
              level={0}
            />
          ))}
        </ol>
      ) : (
        <p className="text-muted">No workflow events recorded yet.</p>
      )}
    </section>
  );
}

import Link from "next/link";

import { PageSection } from "@/components/ui/page-shell";
import type { AutomationHistory } from "@/lib/factory-automations/operator-contracts";
import { workspaceSessionDetailPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

import { automationTriggerLabels } from "./automation-labels";

type Reason = NonNullable<AutomationHistory["occurrences"][number]["reason"]>;
const reasons: Record<Reason, string> = {
  paused: "Automation paused",
  capacity: "Waiting for capacity",
  authority_changing: "Execution authority is changing",
  automation_archived: "Automation archived",
  revision_changed: "Published revision changed",
  event_no_match: "Event did not match",
  recursive_event: "Recursive event blocked",
  invalid_cause: "Causal session unavailable",
  invalid_assignment: "Target or execution authority unavailable",
  budget_exhausted: "Execution budget exhausted",
  retry_exhausted: "Retry limit reached",
  factory_unavailable: "Factory unavailable",
};
const statuses = {
  pending: { label: "Pending", className: "bg-muted/10 text-foreground" },
  admitted: { label: "Admitted", className: "bg-success/10 text-success" },
  denied: { label: "Denied", className: "bg-danger/10 text-danger" },
};

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

function OccurrenceTime({ value }: { value: string }) {
  return <time dateTime={value}>{formatter.format(new Date(value))}</time>;
}

export function AutomationOccurrenceHistory({
  history,
  workspaceSlug,
  revisionHref,
  firstHref,
  nextHref,
}: {
  history: AutomationHistory | null;
  workspaceSlug: string;
  revisionHref: (revisionId: string) => string;
  firstHref?: string;
  nextHref?: string;
}) {
  return (
    <PageSection
      title="Occurrence history"
      tagline="Received events and their decisions about starting work."
    >
      {history ? (
        history.occurrences.length ? (
          <ol className="ui-sheet min-w-0 divide-y divide-border" aria-label="Occurrences">
            {history.occurrences.map((occurrence) => {
              const status = statuses[occurrence.status];
              return (
                <li key={occurrence.id} className="grid min-w-0 gap-3 p-4 text-sm sm:px-6">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span
                      className={cn("rounded px-2 py-0.5 text-xs font-semibold", status.className)}
                    >
                      {status.label}
                    </span>
                    <span className="font-medium">
                      {automationTriggerLabels[occurrence.triggerKind]}
                    </span>
                    {occurrence.revisionId ? (
                      <Link
                        className="font-medium text-accent underline underline-offset-4"
                        href={revisionHref(occurrence.revisionId)}
                      >
                        Revision {occurrence.revisionNumber}
                      </Link>
                    ) : (
                      <span className="text-muted">Revision {occurrence.revisionNumber}</span>
                    )}
                    {occurrence.sessionNumber !== null ? (
                      <Link
                        className="font-medium text-accent underline underline-offset-4"
                        href={workspaceSessionDetailPath(workspaceSlug, occurrence.sessionNumber)}
                      >
                        Session #{occurrence.sessionNumber}
                      </Link>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-muted">
                    <span>
                      Received <OccurrenceTime value={occurrence.recordedAt} />
                    </span>
                    {occurrence.reason ? (
                      <span className="text-foreground">{reasons[occurrence.reason]}</span>
                    ) : null}
                    <span>
                      {occurrence.attemptCount}{" "}
                      {occurrence.attemptCount === 1 ? "attempt" : "attempts"}
                    </span>
                    {occurrence.nextAttemptAt && occurrence.reason !== "paused" ? (
                      <span>
                        Next check <OccurrenceTime value={occurrence.nextAttemptAt} />
                      </span>
                    ) : null}
                    {occurrence.settledAt ? (
                      <span>
                        Decided <OccurrenceTime value={occurrence.settledAt} />
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="ui-sheet p-4 text-sm text-muted sm:px-6">
            No occurrences recorded on this page.
          </p>
        )
      ) : (
        <p className="ui-sheet p-4 text-sm text-danger sm:px-6" role="alert">
          Could not load occurrence history. Refresh this page to try again.
        </p>
      )}
      {firstHref || nextHref ? (
        <nav aria-label="Occurrence history pages" className="mt-3 flex flex-wrap gap-2">
          {firstHref ? (
            <Link className="ui-button" href={firstHref}>
              Newest occurrences
            </Link>
          ) : null}
          {nextHref ? (
            <Link className="ui-button" href={nextHref}>
              Older occurrences
            </Link>
          ) : null}
        </nav>
      ) : null}
    </PageSection>
  );
}

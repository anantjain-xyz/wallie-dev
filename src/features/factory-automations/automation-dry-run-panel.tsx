"use client";

import { useState, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { MetadataItem, MetadataList, PageSection } from "@/components/ui/page-shell";
import { SelectField } from "@/components/ui/select";
import { automationPullRequestActionSchema } from "@/lib/factory-automations/contracts";
import {
  automationDryRunRequestSchema,
  automationDryRunResponseSchema,
  type AutomationDryRunEvent,
  type AutomationDryRunResponse,
} from "@/lib/factory-automations/dry-run-contracts";

type Feedback =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "error"; message: string }
  | { kind: "result"; decision: AutomationDryRunResponse };

const actionLabels: Record<
  Extract<AutomationDryRunEvent, { kind: "pull-request" }>["action"],
  string
> = {
  opened: "Opened",
  reopened: "Reopened",
  synchronize: "New commits",
  ready_for_review: "Ready for review",
  closed: "Closed",
  merged: "Merged",
};
const actionOptions = automationPullRequestActionSchema.options.map((value) => ({
  value,
  label: actionLabels[value],
}));

const checkLabels: Record<AutomationDryRunResponse["checks"][number]["field"], string> = {
  kind: "Trigger",
  repositoryId: "Repository",
  action: "Pull request action",
  baseBranch: "Base branch",
  stateId: "Issue state",
  teamId: "Team",
  projectId: "Project",
};

function readEvent(kind: AutomationDryRunEvent["kind"], form: HTMLFormElement) {
  const fields = new FormData(form);
  const read = (name: string) => {
    const value = fields.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  switch (kind) {
    case "schedule":
      return { kind, scheduledFor: read("scheduledFor") };
    case "pull-request":
      return {
        kind,
        repositoryId: read("repositoryId"),
        action: read("action"),
        baseBranch: read("baseBranch"),
      };
    case "issue-state":
      return {
        kind,
        stateId: read("stateId"),
        teamId: read("teamId") || null,
        projectId: read("projectId") || null,
      };
  }
}

function Eligibility({ decision }: { decision: AutomationDryRunResponse }) {
  const assignment = decision.assignment;
  return (
    <div className="space-y-4" aria-label="Dry run results" role="region">
      <div className="space-y-1">
        <h3 className="type-label text-foreground">
          {decision.matched ? "Event matches" : "Event does not match"}
        </h3>
        {assignment.status === "denied" ? (
          <p className="break-words text-sm text-danger">{assignment.message}</p>
        ) : (
          <p className="text-sm text-muted">The target is eligible for this rule.</p>
        )}
      </div>
      <MetadataList className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
        {assignment.status === "eligible" ? (
          <>
            <MetadataItem label="Agent" value={assignment.agentName} />
            {assignment.workflowName ? (
              <MetadataItem label="Workflow" value={assignment.workflowName} />
            ) : null}
            <MetadataItem
              label="Execution policy revision"
              value={<span className="break-all">{assignment.executionPolicyRevisionId}</span>}
              monospace
            />
          </>
        ) : null}
        <MetadataItem
          label="Budget payer"
          value={<span className="break-all">{decision.budgetPayerMemberId}</span>}
          monospace
        />
      </MetadataList>
      <ul aria-label="Filter checks" className="divide-y divide-border border-y border-border">
        {decision.checks.map((check) => (
          <li
            key={check.field}
            className="grid min-w-0 gap-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)_5rem] sm:gap-4"
          >
            <span className="type-label text-foreground">{checkLabels[check.field]}</span>
            <span className="break-words text-sm text-muted">
              {`Actual ${check.actual ?? "—"}. Expected ${check.expected.length ? check.expected.join(", ") : "any"}.`}
            </span>
            <span className={check.passed ? "text-sm text-success" : "text-sm text-danger"}>
              {check.passed ? "Match" : "No match"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EventFields({
  defaults,
  clearFeedback,
  pending,
}: {
  defaults: AutomationDryRunEvent;
  clearFeedback: () => void;
  pending: boolean;
}) {
  switch (defaults.kind) {
    case "schedule":
      return (
        <label className="block min-w-0 space-y-1.5 sm:col-span-2">
          <span className="type-label">Scheduled time with timezone</span>
          <input
            className="ui-input"
            required
            name="scheduledFor"
            maxLength={35}
            placeholder="2030-01-07T09:00:00Z"
            defaultValue={defaults.scheduledFor}
          />
        </label>
      );
    case "pull-request":
      return (
        <>
          <label className="block min-w-0 space-y-1.5">
            <span className="type-label">Repository ID</span>
            <input
              className="ui-input"
              required
              name="repositoryId"
              maxLength={36}
              defaultValue={defaults.repositoryId}
            />
          </label>
          <SelectField
            label="Pull request action"
            name="action"
            options={actionOptions}
            defaultValue={defaults.action}
            disabled={pending}
            onValueChange={clearFeedback}
            required
          />
          <label className="block min-w-0 space-y-1.5">
            <span className="type-label">Base branch</span>
            <input
              className="ui-input"
              required
              name="baseBranch"
              maxLength={120}
              defaultValue={defaults.baseBranch}
            />
          </label>
        </>
      );
    case "issue-state":
      return (
        <>
          <label className="block min-w-0 space-y-1.5">
            <span className="type-label">Issue state ID</span>
            <input
              className="ui-input"
              required
              name="stateId"
              maxLength={120}
              defaultValue={defaults.stateId}
            />
          </label>
          <label className="block min-w-0 space-y-1.5">
            <span className="type-label">Team ID (optional)</span>
            <input
              className="ui-input"
              name="teamId"
              maxLength={120}
              defaultValue={defaults.teamId ?? ""}
            />
          </label>
          <label className="block min-w-0 space-y-1.5">
            <span className="type-label">Project ID (optional)</span>
            <input
              className="ui-input"
              name="projectId"
              maxLength={120}
              defaultValue={defaults.projectId ?? ""}
            />
          </label>
        </>
      );
  }
}

export function AutomationDryRunPanel({
  automationId,
  defaults,
  endpoint,
  revisionId,
}: {
  automationId: string;
  defaults: AutomationDryRunEvent;
  endpoint: string;
  revisionId: string;
}) {
  const [feedback, setFeedback] = useState<Feedback>({ kind: "idle" });
  const pending = feedback.kind === "pending";

  function clearFeedback() {
    if (feedback.kind === "error" || feedback.kind === "result") setFeedback({ kind: "idle" });
  }

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const request = automationDryRunRequestSchema.safeParse({
      revisionId,
      event: readEvent(defaults.kind, event.currentTarget),
    });
    if (!request.success) {
      const field = request.error.issues[0]?.path.at(-1);
      const message =
        field === "scheduledFor"
          ? "Enter an ISO timestamp with seconds and a timezone, such as 2030-01-07T09:00:00Z."
          : field === "repositoryId"
            ? "Enter a valid repository UUID."
            : "Check the sample event fields and try again.";
      setFeedback({ kind: "error", message });
      return;
    }
    setFeedback({ kind: "pending" });
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.data),
      });
      if (response.status === 404) {
        setFeedback({
          kind: "error",
          message: "This automation revision is unavailable. Choose another revision.",
        });
        return;
      }
      if (!response.ok) throw new Error("Dry run failed.");
      const result = automationDryRunResponseSchema.parse(await response.json());
      if (result.revisionId !== revisionId || result.automationId !== automationId) {
        throw new Error("Dry run returned a different revision.");
      }
      setFeedback({ kind: "result", decision: result });
    } catch {
      setFeedback({ kind: "error", message: "Could not preview this automation. Try again." });
    }
  }

  return (
    <PageSection
      title="Dry run"
      tagline="Test a sample event against the selected revision without starting work."
    >
      <div className="ui-sheet min-w-0 space-y-5 p-4 sm:p-6">
        <form className="space-y-4" onSubmit={preview} onChange={clearFeedback} aria-busy={pending}>
          <fieldset className="grid min-w-0 gap-4 sm:grid-cols-2" disabled={pending}>
            <legend className="sr-only">Sample event</legend>
            <EventFields defaults={defaults} clearFeedback={clearFeedback} pending={pending} />
          </fieldset>
          <button className="ui-button ui-button-primary" type="submit" disabled={pending}>
            <ActionButtonLabel
              idle="Run preview"
              pending={pending}
              pendingLabel="Running preview…"
            />
          </button>
        </form>
        {feedback.kind === "error" ? (
          <p role="alert" className="text-sm text-danger">
            {feedback.message}
          </p>
        ) : null}
        <div role="status">
          {feedback.kind === "result" ? <Eligibility decision={feedback.decision} /> : null}
        </div>
      </div>
    </PageSection>
  );
}

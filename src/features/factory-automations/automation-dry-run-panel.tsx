"use client";

import { useId, useState, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { MetadataItem, MetadataList, PageSection } from "@/components/ui/page-shell";
import { SelectField } from "@/components/ui/select";
import { ResourceIdDetails } from "@/features/settings/connector-settings/catalog";
import {
  automationDryRunNamesHeader,
  automationDryRunRequestSchema,
  automationDryRunResponseSchema,
  type AutomationDryRunEvent,
  type AutomationDryRunResponse,
} from "@/lib/factory-automations/dry-run-contracts";

import { automationPullRequestActionOptions, automationTriggerLabels } from "./automation-labels";
import { useAutomationLinearCatalog } from "./automation-linear-catalog";
import {
  AutomationLinearSample,
  AutomationRepositoryField,
  linearValueLabel,
} from "./automation-resource-fields";

type Feedback =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "error"; message: string; field?: "scheduledFor" | "baseBranch" }
  | { kind: "result"; decision: AutomationDryRunResponse };

const checkLabels: Record<AutomationDryRunResponse["checks"][number]["field"], string> = {
  kind: "Trigger",
  repositoryId: "Repository",
  action: "Pull request action",
  baseBranch: "Base branch",
  stateId: "Issue state",
  teamId: "Team",
  projectId: "Project",
};
type CheckField = keyof typeof checkLabels;
type Repositories = { id: string; name: string }[];
const linearCheckKinds = { stateId: "state", teamId: "team", projectId: "project" } as const;

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

function Eligibility({
  decision,
  repositories,
  savedRepository,
  schedule,
}: {
  decision: AutomationDryRunResponse;
  repositories: Repositories;
  savedRepository?: { id: string; name: string | null };
  schedule: boolean;
}) {
  const linear = useAutomationLinearCatalog();
  const assignment = decision.assignment;
  function name(field: CheckField, value: string | null) {
    if (value === null)
      return field === "teamId" ? "No team" : field === "projectId" ? "No project" : "None";
    switch (field) {
      case "kind":
        return (
          automationTriggerLabels[value as keyof typeof automationTriggerLabels] ??
          "Unknown trigger"
        );
      case "action":
        return (
          automationPullRequestActionOptions.find((option) => option.value === value)?.label ??
          value
        );
      case "repositoryId":
        return (
          repositories.find(({ id }) => id === value)?.name ??
          (savedRepository?.id === value ? savedRepository.name : null) ??
          "Repository name unavailable"
        );
      case "stateId":
      case "teamId":
      case "projectId":
        return linearValueLabel(linear, linearCheckKinds[field], value);
      default:
        return value;
    }
  }
  return (
    <div className="space-y-4" aria-label="Dry run results" role="region">
      <div className="space-y-1">
        <h3 className="type-label text-foreground">
          {schedule
            ? assignment.status === "eligible"
              ? "Target eligible for sample tick"
              : "Target unavailable for sample tick"
            : decision.matched
              ? "Event matches"
              : "Event does not match"}
        </h3>
        {assignment.status === "denied" ? (
          <p className="break-words text-sm text-danger">{assignment.message}</p>
        ) : (
          <p className="text-sm text-muted">
            {schedule
              ? "This checks the assignment only. It does not check whether the sample time matches the cron."
              : "The target is eligible for this rule."}
          </p>
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
              value={
                <>
                  {decision.names?.executionPolicyRevision
                    ? `Workspace execution policy · Revision ${decision.names.executionPolicyRevision}`
                    : "Policy revision unavailable"}
                  <ResourceIdDetails
                    ids={[assignment.executionPolicyRevisionId]}
                    label="Technical ID"
                  />
                </>
              }
            />
          </>
        ) : null}
        <MetadataItem
          label="Budget payer"
          value={
            <>
              {decision.names?.budgetPayer ?? "Member name unavailable"}
              <ResourceIdDetails ids={[decision.budgetPayerMemberId]} label="Technical ID" />
            </>
          }
        />
      </MetadataList>
      {!schedule ? (
        <ul aria-label="Filter checks" className="divide-y divide-border border-y border-border">
          {decision.checks.map((check) => (
            <li
              key={check.field}
              className="grid min-w-0 gap-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)_5rem] sm:gap-4"
            >
              <span className="type-label text-foreground">{checkLabels[check.field]}</span>
              <div className="min-w-0 break-words text-sm text-muted">
                {`Actual ${name(check.field, check.actual)}. Expected ${check.expected.length ? check.expected.map((value) => name(check.field, value)).join(", ") : "any"}.`}
                {["repositoryId", "stateId", "teamId", "projectId"].includes(check.field) ? (
                  <>
                    <ResourceIdDetails
                      ids={check.actual === null ? [] : [check.actual]}
                      label="Actual ID"
                    />
                    <ResourceIdDetails ids={check.expected} label="Expected ID" />
                  </>
                ) : null}
              </div>
              <span className={check.passed ? "text-sm text-success" : "text-sm text-danger"}>
                {check.passed ? "Match" : "No match"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function EventFields({
  defaults,
  clearFeedback,
  pending,
  repositories,
  savedRepositoryName,
  feedback,
  errorId,
}: {
  defaults: AutomationDryRunEvent;
  clearFeedback: () => void;
  pending: boolean;
  repositories: Repositories;
  savedRepositoryName?: string | null;
  feedback: Feedback;
  errorId: string;
}) {
  function validity(field: "scheduledFor" | "baseBranch") {
    if (feedback.kind !== "error" || feedback.field !== field) return {};
    return { "aria-invalid": true, "aria-describedby": errorId };
  }
  switch (defaults.kind) {
    case "schedule":
      return (
        <label className="block min-w-0 space-y-1.5 sm:col-span-2">
          <span className="type-label">Sample tick (ISO timestamp with time zone)</span>
          <input
            {...validity("scheduledFor")}
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
          <AutomationRepositoryField
            label="Sample repository"
            initial={defaults.repositoryId}
            repositories={repositories}
            savedName={savedRepositoryName}
            disabled={pending}
            changed={clearFeedback}
          />
          <SelectField
            label="Pull request action"
            name="action"
            options={automationPullRequestActionOptions}
            defaultValue={defaults.action}
            disabled={pending}
            onValueChange={clearFeedback}
            required
          />
          <label className="block min-w-0 space-y-1.5">
            <span className="type-label">Base branch</span>
            <input
              {...validity("baseBranch")}
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
          <AutomationLinearSample
            kind="state"
            initial={defaults.stateId}
            disabled={pending}
            changed={clearFeedback}
          />
          <AutomationLinearSample
            kind="team"
            initial={defaults.teamId}
            disabled={pending}
            changed={clearFeedback}
          />
          <AutomationLinearSample
            kind="project"
            initial={defaults.projectId}
            disabled={pending}
            changed={clearFeedback}
          />
        </>
      );
  }
}

export function AutomationDryRunPanel({
  automationId,
  defaults,
  endpoint,
  revisionId,
  repositories = [],
  savedRepositoryName,
}: {
  automationId: string;
  defaults: AutomationDryRunEvent;
  endpoint: string;
  revisionId: string;
  repositories?: Repositories;
  savedRepositoryName?: string | null;
}) {
  const [feedback, setFeedback] = useState<Feedback>({ kind: "idle" });
  const errorId = useId();
  const pending = feedback.kind === "pending";
  const schedule = defaults.kind === "schedule";

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
            ? "Choose a sample repository."
            : field === "stateId"
              ? "Choose a sample issue state."
              : field === "baseBranch"
                ? "Enter a base branch name of up to 120 characters."
                : "Check the sample event fields and try again.";
      const input = field === "scheduledFor" || field === "baseBranch" ? field : undefined;
      setFeedback({ kind: "error", message, field: input });
      if (input)
        event.currentTarget.querySelector<HTMLInputElement>(`input[name="${input}"]`)?.focus();
      return;
    }
    setFeedback({ kind: "pending" });
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", [automationDryRunNamesHeader]: "1" },
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
      tagline={
        schedule ? (
          <>
            Check target eligibility for a sample tick without starting work. See{" "}
            <a className="text-accent underline underline-offset-4" href="#automation-schedule">
              Schedule
            </a>{" "}
            to check when this revision would fire.
          </>
        ) : (
          "Test a sample event against the saved revision shown above. This does not start work or check live admission."
        )
      }
    >
      <div className="ui-sheet min-w-0 space-y-5 p-4 sm:p-6">
        <form className="space-y-4" onSubmit={preview} onChange={clearFeedback} aria-busy={pending}>
          <fieldset className="grid min-w-0 gap-4 sm:grid-cols-2" disabled={pending}>
            <legend className="sr-only">Sample event</legend>
            <EventFields
              defaults={defaults}
              clearFeedback={clearFeedback}
              pending={pending}
              repositories={repositories}
              savedRepositoryName={savedRepositoryName}
              feedback={feedback}
              errorId={errorId}
            />
          </fieldset>
          <button className="ui-button ui-button-primary" type="submit" disabled={pending}>
            <ActionButtonLabel
              idle={schedule ? "Check target eligibility" : "Run preview"}
              pending={pending}
              pendingLabel="Running preview…"
            />
          </button>
        </form>
        {feedback.kind === "error" ? (
          <p role="alert" className="text-sm text-danger" id={errorId}>
            {feedback.message}
          </p>
        ) : null}
        <div role="status">
          {feedback.kind === "result" ? (
            <Eligibility
              decision={feedback.decision}
              repositories={repositories}
              savedRepository={
                defaults.kind === "pull-request"
                  ? { id: defaults.repositoryId, name: savedRepositoryName ?? null }
                  : undefined
              }
              schedule={schedule}
            />
          ) : null}
        </div>
      </div>
    </PageSection>
  );
}

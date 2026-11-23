import { automationPullRequestActionSchema } from "@/lib/factory-automations/contracts";
import type { AutomationDryRunEvent } from "@/lib/factory-automations/dry-run-contracts";
import type { AutomationTriggerKind } from "@/lib/factory-automations/operator-contracts";

export const automationTriggerLabels: Record<AutomationTriggerKind, string> = {
  schedule: "Schedule",
  "pull-request": "GitHub pull request",
  "issue-state": "Linear issue state",
};

const pullRequestActionLabels: Record<
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

export const automationPullRequestActionOptions = automationPullRequestActionSchema.options.map(
  (value) => ({ value, label: pullRequestActionLabels[value] }),
);

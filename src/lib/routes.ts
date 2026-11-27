import { titleFromSlug } from "@/lib/utils";

export const workspaceNavSections = ["Work", "Improve", "Configure", "Platform", "Footer"] as const;

export type WorkspaceNavItem = {
  href: string;
  id:
    | "sessions"
    | "inbox"
    | "runs"
    | "activity"
    | "analytics"
    | "benchmarks"
    | "failure-groups"
    | "improvements"
    | "context"
    | "memory"
    | "agents"
    | "scorers"
    | "governance"
    | "factory-definition"
    | "workflows"
    | "automations"
    | "settings";
  label: string;
  section: (typeof workspaceNavSections)[number];
};

type QueryValue = boolean | number | string | undefined;

function withSearchParams(pathname: string, query?: Record<string, QueryValue>) {
  if (!query) {
    return pathname;
  }

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }

    params.set(key, String(value));
  }

  const serialized = params.toString();

  return serialized ? `${pathname}?${serialized}` : pathname;
}

export function workspaceBasePath(workspaceSlug: string) {
  return `/w/${workspaceSlug}`;
}

export function workspaceOnboardingPath(workspaceSlug: string) {
  return `${workspaceBasePath(workspaceSlug)}/onboarding`;
}

export function loginPath(next?: string) {
  return withSearchParams("/login", next ? { next } : undefined);
}

export function onboardingWorkspacePath() {
  return "/onboarding/workspace";
}

export function workspaceSessionsPath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/sessions`, query);
}

export function workspaceSessionDetailPath(
  workspaceSlug: string,
  sessionNumber: number | string,
  query?: Record<string, QueryValue>,
) {
  return withSearchParams(`${workspaceSessionsPath(workspaceSlug)}/${sessionNumber}`, query);
}

export function workspaceRunsPath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/runs`, query);
}

export function workspaceInboxPath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/inbox`, query);
}

export function workspaceRunDetailPath(
  workspaceSlug: string,
  runId: string,
  query?: { attempt?: number },
) {
  return withSearchParams(
    `${workspaceRunsPath(workspaceSlug)}/${encodeURIComponent(runId)}`,
    query,
  );
}

export function workspaceActivityPath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/activity`, query);
}

export function workspaceAnalyticsPath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/analytics`, query);
}

export function workspaceBenchmarksPath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/benchmarks`, query);
}

export function workspaceFailureGroupsPath(
  workspaceSlug: string,
  query?: Record<string, QueryValue>,
) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/failure-groups`, query);
}

export function workspaceFailureGroupPath(
  workspaceSlug: string,
  cohortId: string,
  query?: Record<string, QueryValue>,
) {
  return withSearchParams(
    `${workspaceFailureGroupsPath(workspaceSlug)}/${encodeURIComponent(cohortId)}`,
    query,
  );
}

export function workspaceImprovementsPath(
  workspaceSlug: string,
  query?: Record<string, QueryValue>,
) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/improvements`, query);
}

export function workspaceImprovementPath(
  workspaceSlug: string,
  proposalId: string,
  query?: Record<string, QueryValue>,
) {
  return withSearchParams(
    `${workspaceImprovementsPath(workspaceSlug)}/${encodeURIComponent(proposalId)}`,
    query,
  );
}

export function workspaceBenchmarkSuitePath(
  workspaceSlug: string,
  suiteId: string,
  query?: Record<string, QueryValue>,
) {
  return withSearchParams(
    `${workspaceBenchmarksPath(workspaceSlug)}/${encodeURIComponent(suiteId)}`,
    query,
  );
}

export function workspaceBenchmarkComparisonPath(
  workspaceSlug: string,
  suiteId: string,
  experimentId: string,
  query?: Record<string, QueryValue>,
) {
  return withSearchParams(
    `${workspaceBenchmarkSuitePath(workspaceSlug, suiteId)}/comparisons/${encodeURIComponent(experimentId)}`,
    query,
  );
}

export function workspaceBenchmarkTrialPath(
  workspaceSlug: string,
  suiteId: string,
  experimentId: string,
  trialId: string,
  query?: Record<string, QueryValue>,
) {
  return withSearchParams(
    `${workspaceBenchmarkComparisonPath(workspaceSlug, suiteId, experimentId)}/trials/${encodeURIComponent(trialId)}`,
    query,
  );
}

export function workspaceContextPath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/context`, query);
}

export function workspaceMemoryPath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/memory`, query);
}

export function workspaceGovernancePath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/governance`, query);
}

export function workspaceAgentsPath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/agents`, query);
}

export function workspaceAgentDetailPath(
  workspaceSlug: string,
  agentId: string,
  query?: Record<string, QueryValue>,
) {
  return withSearchParams(
    `${workspaceAgentsPath(workspaceSlug)}/${encodeURIComponent(agentId)}`,
    query,
  );
}

export function workspaceScorersPath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/scorers`, query);
}

export function workspaceScorerDetailPath(
  workspaceSlug: string,
  scorerId: string,
  query?: Record<string, QueryValue>,
) {
  return withSearchParams(
    `${workspaceScorersPath(workspaceSlug)}/${encodeURIComponent(scorerId)}`,
    query,
  );
}

export function workspaceSettingsPath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/settings`, query);
}

export function workspaceFactoriesPath(workspaceSlug: string, factory?: string) {
  const path = workspaceSettingsPath(workspaceSlug, { category: "workspace", factory });
  return `${path}#${factory ? "factory-setup" : "factories"}`;
}

export function workspaceAutomationPreviewPath(
  workspaceSlug: string,
  query?: {
    factory?: string;
    automation?: string;
    revision?: string;
    afterId?: string;
    mode?: "new";
    historyBefore?: string;
    historyBeforeId?: string;
  },
) {
  return withSearchParams(`${workspaceSettingsPath(workspaceSlug)}/automations`, query);
}

export function factoryAutomationApiPath(
  workspaceId: string,
  factoryId: string,
  automationId?: string,
) {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/factories/${encodeURIComponent(factoryId)}/automations`;
  return automationId ? `${base}/${encodeURIComponent(automationId)}` : base;
}

export function automationDryRunApiPath(
  workspaceId: string,
  factoryId: string,
  automationId: string,
) {
  return `${factoryAutomationApiPath(workspaceId, factoryId, automationId)}/dry-run`;
}

export function workspaceWorkflowsPath(
  workspaceSlug: string,
  query?: { factory?: string; after?: string; q?: string },
) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/workflows`, query);
}

export function workspaceWorkflowDetailPath(
  workspaceSlug: string,
  workflowId: string,
  query: { factory: string; draft?: string },
) {
  return withSearchParams(
    `${workspaceWorkflowsPath(workspaceSlug)}/${encodeURIComponent(workflowId)}`,
    query,
  );
}

export function workflowInspectionApiPath(
  sessionId: string,
  query?: { runId?: string; cursor?: string },
) {
  return withSearchParams(
    `/api/sessions/${encodeURIComponent(sessionId)}/workflow-inspection`,
    query,
  );
}

export function workflowAuthoringApiPath(
  workspaceId: string,
  factoryId: string,
  workflowId?: string,
) {
  const list = `/api/workspaces/${encodeURIComponent(workspaceId)}/factories/${encodeURIComponent(factoryId)}/workflows`;
  return workflowId ? `${list}/${encodeURIComponent(workflowId)}` : list;
}

export function workspaceFactoryDefinitionPath(
  workspaceSlug: string,
  query?: {
    factory?: string;
    implementationAgent?: string;
    scorerRevision?: string;
    revision?: string;
    activation?: number;
    restoreFrom?: number;
    draft?: string;
    test?: string;
  },
) {
  return withSearchParams(`${workspaceSettingsPath(workspaceSlug)}/factory-definition`, query);
}

export function getWorkspaceNavItems(
  workspaceSlug: string,
  {
    canManageAutomations = false,
    canManageFactoryDefinition = false,
    canManageGovernance = false,
    canManageWorkflows = false,
  } = {},
): WorkspaceNavItem[] {
  const items: WorkspaceNavItem[] = [
    {
      id: "sessions",
      href: workspaceSessionsPath(workspaceSlug),
      label: "Sessions",
      section: "Work",
    },
    { id: "inbox", href: workspaceInboxPath(workspaceSlug), label: "Inbox", section: "Work" },
    { id: "runs", href: workspaceRunsPath(workspaceSlug), label: "Runs", section: "Work" },
    {
      id: "activity",
      href: workspaceActivityPath(workspaceSlug),
      label: "Activity",
      section: "Work",
    },
    {
      id: "analytics",
      href: workspaceAnalyticsPath(workspaceSlug),
      label: "Analytics",
      section: "Improve",
    },
    {
      id: "benchmarks",
      href: workspaceBenchmarksPath(workspaceSlug),
      label: "Benchmarks",
      section: "Improve",
    },
    {
      id: "failure-groups",
      href: workspaceFailureGroupsPath(workspaceSlug),
      label: "Failure groups",
      section: "Improve",
    },
    {
      id: "improvements",
      href: workspaceImprovementsPath(workspaceSlug),
      label: "Improvements",
      section: "Improve",
    },
    {
      id: "agents",
      href: workspaceAgentsPath(workspaceSlug),
      label: "Agents",
      section: "Configure",
    },
    {
      id: "scorers",
      href: workspaceScorersPath(workspaceSlug),
      label: "Scorers",
      section: "Configure",
    },
  ];
  if (canManageWorkflows) {
    items.push({
      id: "workflows",
      href: workspaceWorkflowsPath(workspaceSlug),
      label: "Workflows",
      section: "Configure",
    });
  }
  if (canManageAutomations) {
    items.push({
      id: "automations",
      href: workspaceAutomationPreviewPath(workspaceSlug),
      label: "Automations",
      section: "Configure",
    });
  }
  if (canManageFactoryDefinition) {
    items.push({
      id: "factory-definition",
      href: workspaceFactoryDefinitionPath(workspaceSlug),
      label: "Factory definition",
      section: "Configure",
    });
  }
  if (canManageGovernance) {
    items.push(
      {
        id: "context",
        href: workspaceContextPath(workspaceSlug),
        label: "Context",
        section: "Improve",
      },
      {
        id: "memory",
        href: workspaceMemoryPath(workspaceSlug),
        label: "Memory",
        section: "Improve",
      },
    );
    items.push({
      id: "governance",
      href: workspaceGovernancePath(workspaceSlug),
      label: "Governance",
      section: "Configure",
    });
  }
  items.push({
    id: "settings",
    href: workspaceSettingsPath(workspaceSlug),
    label: "Settings",
    section: "Footer",
  });
  return items;
}

export function workspaceLabel(workspaceSlug: string) {
  return titleFromSlug(workspaceSlug) || "Untitled Workspace";
}

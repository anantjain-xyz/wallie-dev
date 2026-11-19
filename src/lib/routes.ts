import { titleFromSlug } from "@/lib/utils";

export const workspaceNavSections = ["Work", "Improve", "Configure", "Platform", "Footer"] as const;

export type WorkspaceNavItem = {
  href: string;
  id:
    | "pipeline"
    | "overview"
    | "sessions"
    | "inbox"
    | "runs"
    | "activity"
    | "analytics"
    | "context"
    | "memory"
    | "agents"
    | "governance"
    | "factory-definition"
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

export function workspaceOverviewPath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/overview`, query);
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

export function workspaceRunDetailPath(workspaceSlug: string, runId: string) {
  return `${workspaceRunsPath(workspaceSlug)}/${encodeURIComponent(runId)}`;
}

export function workspaceActivityPath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/activity`, query);
}

export function workspaceAnalyticsPath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/analytics`, query);
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

export function workspaceSettingsPath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/settings`, query);
}

export function workspaceFactoryDefinitionPath(
  workspaceSlug: string,
  query?: {
    factory?: string;
    implementationAgent?: string;
    revision?: string;
    draft?: string;
    test?: string;
  },
) {
  return withSearchParams(`${workspaceSettingsPath(workspaceSlug)}/factory-definition`, query);
}

export function getWorkspaceNavItems(
  workspaceSlug: string,
  { canManageFactoryDefinition = false, canManageGovernance = false } = {},
): WorkspaceNavItem[] {
  const items: WorkspaceNavItem[] = [
    {
      id: "overview",
      href: workspaceOverviewPath(workspaceSlug),
      label: "Overview",
      section: "Work",
    },
    { id: "pipeline", href: workspaceBasePath(workspaceSlug), label: "Pipeline", section: "Work" },
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
      id: "agents",
      href: workspaceAgentsPath(workspaceSlug),
      label: "Agents",
      section: "Configure",
    },
  ];
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

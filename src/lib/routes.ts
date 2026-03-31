import { titleFromSlug } from "@/lib/utils";

export type WorkspaceNavItem = {
  description: string;
  href: string;
  label: string;
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

export function loginPath(next?: string) {
  return withSearchParams("/login", next ? { next } : undefined);
}

export function signupPath(next?: string) {
  return withSearchParams("/signup", next ? { next } : undefined);
}

export function onboardingWorkspacePath() {
  return "/onboarding/workspace";
}

export function workspaceIssuesPath(
  workspaceSlug: string,
  query?: Record<string, QueryValue>,
) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/issues`, query);
}

export function workspaceIssueDetailPath(
  workspaceSlug: string,
  issueNumber: number | string,
) {
  return `${workspaceIssuesPath(workspaceSlug)}/${issueNumber}`;
}

export function workspaceSettingsPath(workspaceSlug: string) {
  return `${workspaceBasePath(workspaceSlug)}/settings`;
}

export function getWorkspaceNavItems(workspaceSlug: string): WorkspaceNavItem[] {
  return [
    {
      label: "Issues",
      href: workspaceIssuesPath(workspaceSlug),
      description: "List, filter, and triage workspace issues.",
    },
    {
      label: "Settings",
      href: workspaceSettingsPath(workspaceSlug),
      description: "Workspace-level settings, billing, and integration entry points.",
    },
  ];
}

export function workspaceLabel(workspaceSlug: string) {
  return titleFromSlug(workspaceSlug) || "Untitled Workspace";
}

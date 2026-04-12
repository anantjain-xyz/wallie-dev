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

export function workspaceSettingsPath(workspaceSlug: string, query?: Record<string, QueryValue>) {
  return withSearchParams(`${workspaceBasePath(workspaceSlug)}/settings`, query);
}

export function getWorkspaceNavItems(workspaceSlug: string): WorkspaceNavItem[] {
  return [
    {
      label: "Pipeline",
      href: workspaceBasePath(workspaceSlug),
      description: "The active six-phase pipeline across every session.",
    },
    {
      label: "Sessions",
      href: workspaceSessionsPath(workspaceSlug),
      description: "All sessions regardless of phase. Search and filter by phase or PRs.",
    },
    {
      label: "Settings",
      href: workspaceSettingsPath(workspaceSlug),
      description: "Workspace-level settings and integration entry points.",
    },
  ];
}

export function workspaceLabel(workspaceSlug: string) {
  return titleFromSlug(workspaceSlug) || "Untitled Workspace";
}

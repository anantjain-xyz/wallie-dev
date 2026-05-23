"use client";

import type { WorkspaceGitHubRepository } from "@/features/github/data";
import type {
  RepositoryOnboardingResponse,
  RepositoryOnboardingState,
} from "@/lib/repo-onboarding/contracts";

type PrepareRepositoryForAnalysisOptions = {
  onChange: (repositoryId: string, onboarding: RepositoryOnboardingState) => void;
  repository: WorkspaceGitHubRepository;
  workspaceId: string;
};

async function parseOnboardingResponse(
  response: Response,
  fallbackError: string,
): Promise<RepositoryOnboardingResponse> {
  const body = (await response.json().catch(() => null)) as
    | (RepositoryOnboardingResponse & { error?: string })
    | null;
  if (!response.ok || !body?.onboarding) {
    throw new Error(body?.error ?? fallbackError);
  }

  return body;
}

async function startRepositoryOnboarding(workspaceId: string, repositoryId: string) {
  const response = await fetch(
    `/api/workspaces/${workspaceId}/repositories/${repositoryId}/onboarding`,
    { method: "POST" },
  );

  return parseOnboardingResponse(response, "Wallie setup failed.");
}

async function markRepositoryOnboardingReady(workspaceId: string, repositoryId: string) {
  const response = await fetch(
    `/api/workspaces/${workspaceId}/repositories/${repositoryId}/onboarding`,
    {
      body: JSON.stringify({ action: "mark_ready" }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    },
  );

  return parseOnboardingResponse(response, "Manual Wallie setup confirmation failed.");
}

export async function prepareRepositoryForAnalysis({
  onChange,
  repository,
  workspaceId,
}: PrepareRepositoryForAnalysisOptions): Promise<RepositoryOnboardingState> {
  if (repository.onboarding.status === "ready") {
    return repository.onboarding;
  }

  const setup = await startRepositoryOnboarding(workspaceId, repository.id);
  onChange(repository.id, setup.onboarding);

  if (setup.onboarding.status === "ready") {
    return setup.onboarding;
  }

  const ready = await markRepositoryOnboardingReady(workspaceId, repository.id);
  onChange(repository.id, ready.onboarding);

  return ready.onboarding;
}

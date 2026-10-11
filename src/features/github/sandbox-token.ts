import "server-only";

import { resolveGitHubAppConfig } from "./config";

export async function mintSandboxRepositoryToken(input: {
  installationId: number;
  repositoryFullName: string;
  repositoryId?: number;
  purpose: "execution" | "capability-check";
}): Promise<string> {
  const [owner, repository, extra] = input.repositoryFullName.split("/");
  if (!owner || !repository || extra !== undefined || /\s/.test(input.repositoryFullName)) {
    throw new Error("A sandbox token requires one owner/repository name.");
  }
  if (
    input.repositoryId !== undefined &&
    (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0)
  )
    throw new Error("A sandbox token requires a valid numeric repository identity.");

  // The worker runs through tsx's CommonJS loader; Octokit only exports an ESM entry.
  const { App } = await import("@octokit/app");
  const app = new App(resolveGitHubAppConfig());
  const { data } = await app.octokit.request(
    "POST /app/installations/{installation_id}/access_tokens",
    {
      installation_id: input.installationId,
      ...(input.repositoryId === undefined
        ? { repositories: [repository] }
        : { repository_ids: [input.repositoryId] }),
      permissions:
        input.purpose === "execution"
          ? { contents: "write", pull_requests: "write" }
          : { contents: "read" },
    },
  );
  return data.token;
}

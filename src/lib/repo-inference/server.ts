import "server-only";

import { App } from "@octokit/app";
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveGitHubAppConfig } from "@/features/github/config";
import type {
  RepositoryProfileSavePayload,
  RepositoryProfileState,
} from "@/lib/repo-inference/contracts";
import { normalizeInferenceSources } from "@/lib/repo-inference/contracts";
import {
  inferRepositoryProfileFromFiles,
  REPOSITORY_INFERENCE_FILE_CANDIDATES,
  type RepositoryInferenceFile,
} from "@/lib/repo-inference/infer";
import type { Database, Json, Tables } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

type InstallationOctokit = {
  request: <T = unknown>(route: string, params?: Record<string, unknown>) => Promise<{ data: T }>;
};

type GitHubAppLike = {
  getInstallationOctokit: (installationId: number) => Promise<InstallationOctokit>;
};

type RepositoryRow = Pick<
  Tables<"github_repositories">,
  "default_branch" | "full_name" | "github_installation_id" | "id" | "is_archived" | "workspace_id"
>;

type InstallationRow = Pick<Tables<"github_installations">, "installation_id">;

type GitHubFileContent = {
  content?: string;
  encoding?: string;
  type?: string;
};

export class RepositoryProfileError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "RepositoryProfileError";
  }
}

function defaultAppFactory(): GitHubAppLike {
  return new App(resolveGitHubAppConfig()) as unknown as GitHubAppLike;
}

function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub repository full_name: ${fullName}`);
  }
  return { owner, repo };
}

function readGitHubStatus(error: unknown): number | null {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : null;
}

export function mapRepositoryProfileRow(
  row: Tables<"workspace_repository_profiles">,
): RepositoryProfileState {
  return {
    buildCommand: row.build_command,
    createdAt: row.created_at,
    envKeySuggestions: row.env_key_suggestions,
    frameworkHints: row.framework_hints,
    githubRepositoryId: row.github_repository_id,
    id: row.id,
    inferenceConfidence:
      row.inference_confidence === "high" ||
      row.inference_confidence === "medium" ||
      row.inference_confidence === "manual"
        ? row.inference_confidence
        : "low",
    inferenceSources: normalizeInferenceSources(row.inference_sources),
    installCommand: row.install_command,
    isPrimary: row.is_primary,
    languageHints: row.language_hints,
    packageManager: row.package_manager,
    setupNotes: row.setup_notes,
    testCommand: row.test_command,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

async function loadRepositoryAndInstallation(
  admin: AdminClient,
  input: { repositoryId: string; workspaceId: string },
): Promise<{ installation: InstallationRow; repository: RepositoryRow }> {
  const { data: repository, error } = await admin
    .from("github_repositories")
    .select("id, workspace_id, github_installation_id, full_name, default_branch, is_archived")
    .eq("id", input.repositoryId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!repository) throw new RepositoryProfileError("Repository not found.", 404);
  if (repository.is_archived) {
    throw new RepositoryProfileError("Archived repositories cannot be selected.", 400);
  }

  const { data: installation, error: installationError } = await admin
    .from("github_installations")
    .select("installation_id")
    .eq("id", repository.github_installation_id)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();

  if (installationError) throw installationError;
  if (!installation) throw new RepositoryProfileError("GitHub installation not found.", 404);

  return { installation, repository };
}

async function readRepositoryFile(input: {
  octokit: InstallationOctokit;
  owner: string;
  path: string;
  ref: string;
  repo: string;
}): Promise<RepositoryInferenceFile | null> {
  try {
    const { data } = await input.octokit.request<GitHubFileContent | GitHubFileContent[]>(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner: input.owner,
        path: input.path,
        ref: input.ref,
        repo: input.repo,
      },
    );

    if (Array.isArray(data) || data.type !== "file") {
      return { content: null, path: input.path };
    }

    const content =
      data.encoding === "base64" && data.content
        ? Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8")
        : null;

    return { content, path: input.path };
  } catch (error) {
    if (readGitHubStatus(error) === 404) return null;
    throw error;
  }
}

export async function inferRepositoryProfileForRepository(input: {
  admin: AdminClient;
  githubAppFactory?: () => GitHubAppLike;
  repositoryId: string;
  workspaceId: string;
}) {
  const { installation, repository } = await loadRepositoryAndInstallation(input.admin, input);
  const { owner, repo } = splitRepo(repository.full_name);
  const app = (input.githubAppFactory ?? defaultAppFactory)();
  const octokit = await app.getInstallationOctokit(installation.installation_id);
  const ref = repository.default_branch ?? "main";
  const files = (
    await Promise.all(
      REPOSITORY_INFERENCE_FILE_CANDIDATES.map((path) =>
        readRepositoryFile({ octokit, owner, path, ref, repo }),
      ),
    )
  ).filter((file): file is RepositoryInferenceFile => Boolean(file));
  const inferred = inferRepositoryProfileFromFiles(files);

  return {
    ...inferred,
    createdAt: null,
    githubRepositoryId: repository.id,
    id: null,
    isPrimary: true as const,
    updatedAt: null,
    workspaceId: input.workspaceId,
  };
}

export async function saveWorkspaceRepositoryProfile(input: {
  admin: AdminClient;
  payload: RepositoryProfileSavePayload;
  workspaceId: string;
}): Promise<RepositoryProfileState> {
  await loadRepositoryAndInstallation(input.admin, {
    repositoryId: input.payload.githubRepositoryId,
    workspaceId: input.workspaceId,
  });

  const clearResult = await input.admin
    .from("workspace_repository_profiles")
    .update({ is_primary: false })
    .eq("workspace_id", input.workspaceId)
    .neq("github_repository_id", input.payload.githubRepositoryId);

  if (clearResult.error) throw clearResult.error;

  const { data, error } = await input.admin
    .from("workspace_repository_profiles")
    .upsert(
      {
        build_command: input.payload.buildCommand,
        env_key_suggestions: input.payload.envKeySuggestions,
        framework_hints: input.payload.frameworkHints,
        github_repository_id: input.payload.githubRepositoryId,
        inference_confidence: input.payload.inferenceConfidence,
        inference_sources: input.payload.inferenceSources as unknown as Json,
        install_command: input.payload.installCommand,
        is_primary: true,
        language_hints: input.payload.languageHints,
        package_manager: input.payload.packageManager,
        setup_notes: input.payload.setupNotes,
        test_command: input.payload.testCommand,
        workspace_id: input.workspaceId,
      },
      { onConflict: "workspace_id,github_repository_id" },
    )
    .select(
      "id, workspace_id, github_repository_id, is_primary, package_manager, language_hints, framework_hints, install_command, build_command, test_command, env_key_suggestions, setup_notes, inference_confidence, inference_sources, created_at, updated_at",
    )
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new RepositoryProfileError(
        "Only one primary repository profile can exist per workspace.",
        409,
      );
    }
    throw error;
  }

  return mapRepositoryProfileRow(data);
}

import "server-only";

import { App } from "@octokit/app";
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveGitHubAppConfig } from "@/features/github/config";
import type { RepositoryOnboardingState } from "@/lib/repo-onboarding/contracts";
import {
  buildRepositoryOnboardingPlan,
  type ExistingRepositoryFile,
} from "@/lib/repo-onboarding/planner";
import {
  DEFAULT_WALLIE_SKILLS,
  WALLIE_AGENTS_INSTRUCTIONS_PATH,
  WALLIE_SKILL_VERSION,
  wallieSkillManifestHash,
} from "@/lib/repo-onboarding/skills";
import type { Database } from "@/lib/supabase/database.types";
import { asLooseSupabaseClient } from "@/lib/supabase/loose";

type AdminClient = SupabaseClient<Database>;

type InstallationOctokit = {
  request: <T = unknown>(route: string, params?: Record<string, unknown>) => Promise<{ data: T }>;
};

type GitHubAppLike = {
  getInstallationOctokit: (installationId: number) => Promise<InstallationOctokit>;
};

type RepositoryRow = {
  default_branch: string | null;
  full_name: string;
  github_installation_id: string;
  id: string;
  is_archived: boolean;
  name: string;
  workspace_id: string;
};

type InstallationRow = {
  installation_id: number;
};

type OnboardingRow = {
  conflict_report: unknown;
  github_repository_id: string;
  installed_skill_hash: string | null;
  installed_skill_version: number | null;
  last_error: string | null;
  setup_branch_name: string | null;
  setup_pr_number: number | null;
  setup_pr_url: string | null;
  status: RepositoryOnboardingState["status"];
  updated_at: string | null;
};

type GitRefResponse = {
  object: { sha: string };
};

type GitCommitResponse = {
  tree: { sha: string };
};

type PullRequestResponse = {
  html_url: string;
  number: number;
};

type GitHubFileContent = {
  content?: string;
  encoding?: string;
  type?: string;
};

export type StartRepositoryOnboardingResult = {
  onboarding: RepositoryOnboardingState;
};

export type MarkRepositoryOnboardingReadyResult = {
  onboarding: RepositoryOnboardingState;
};

function defaultAppFactory(): GitHubAppLike {
  return new App(resolveGitHubAppConfig()) as unknown as GitHubAppLike;
}

function mapOnboardingRow(
  row: OnboardingRow | null,
  repositoryId: string,
): RepositoryOnboardingState {
  const conflictReport = Array.isArray(row?.conflict_report) ? row.conflict_report : [];
  return {
    conflictReport: conflictReport as RepositoryOnboardingState["conflictReport"],
    githubRepositoryId: repositoryId,
    installedSkillHash: row?.installed_skill_hash ?? null,
    installedSkillVersion: row?.installed_skill_version ?? null,
    lastError: row?.last_error ?? null,
    setupBranchName: row?.setup_branch_name ?? null,
    setupPrNumber: row?.setup_pr_number ?? null,
    setupPrUrl: row?.setup_pr_url ?? null,
    status: row?.status ?? "not_set_up",
    updatedAt: row?.updated_at ?? null,
  };
}

function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub repository full_name: ${fullName}`);
  }
  return { owner, repo };
}

function safeBranchSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "repo"
  );
}

function readGitHubStatus(error: unknown): number | null {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : null;
}

async function loadRepository(
  admin: AdminClient,
  input: { repositoryId: string; workspaceId: string },
): Promise<{ installation: InstallationRow; repository: RepositoryRow }> {
  const { data: repository, error } = await admin
    .from("github_repositories")
    .select(
      "id, workspace_id, github_installation_id, name, full_name, default_branch, is_archived",
    )
    .eq("id", input.repositoryId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!repository) throw new Error("Repository not found.");
  if (repository.is_archived)
    throw new Error("Wallie setup is unavailable for archived repositories.");

  const { data: installation, error: installationError } = await admin
    .from("github_installations")
    .select("installation_id")
    .eq("id", repository.github_installation_id)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();

  if (installationError) throw installationError;
  if (!installation) throw new Error("GitHub installation not found for repository.");

  return {
    installation,
    repository: repository as RepositoryRow,
  };
}

export async function getRepositoryOnboardingState(input: {
  admin: AdminClient;
  repositoryId: string;
  workspaceId: string;
}): Promise<RepositoryOnboardingState> {
  const row = await loadOnboardingRow(input);
  return mapOnboardingRow(row, input.repositoryId);
}

export async function markRepositoryOnboardingReady(input: {
  admin: AdminClient;
  repositoryId: string;
  workspaceId: string;
}): Promise<MarkRepositoryOnboardingReadyResult> {
  await loadRepository(input.admin, input);

  const onboarding = await upsertOnboardingState({
    admin: input.admin,
    conflictReport: [],
    installedSkillHash: wallieSkillManifestHash(),
    installedSkillVersion: WALLIE_SKILL_VERSION,
    lastError: null,
    repositoryId: input.repositoryId,
    setupBranchName: null,
    setupPrNumber: null,
    setupPrUrl: null,
    status: "ready",
    workspaceId: input.workspaceId,
  });

  return { onboarding };
}

async function loadOnboardingRow(input: {
  admin: AdminClient;
  repositoryId: string;
  workspaceId: string;
}): Promise<OnboardingRow | null> {
  const loose = asLooseSupabaseClient(input.admin);
  const { data, error } = await loose
    .from("repository_onboarding_status")
    .select(
      "github_repository_id, status, setup_branch_name, setup_pr_number, setup_pr_url, installed_skill_version, installed_skill_hash, conflict_report, last_error, updated_at",
    )
    .eq("workspace_id", input.workspaceId)
    .eq("github_repository_id", input.repositoryId)
    .maybeSingle();

  if (error) throw error;
  return data as OnboardingRow | null;
}

function hasInFlightSetupPullRequest(row: OnboardingRow | null): boolean {
  return Boolean(
    row &&
    (row.status === "pr_open" || row.status === "conflict") &&
    row.setup_branch_name &&
    row.setup_pr_number &&
    row.setup_pr_url,
  );
}

async function upsertOnboardingState(input: {
  admin: AdminClient;
  conflictReport?: unknown;
  installedSkillHash?: string | null;
  installedSkillVersion?: number | null;
  lastError?: string | null;
  repositoryId: string;
  setupBranchName?: string | null;
  setupPrNumber?: number | null;
  setupPrUrl?: string | null;
  status: RepositoryOnboardingState["status"];
  workspaceId: string;
}): Promise<RepositoryOnboardingState> {
  const loose = asLooseSupabaseClient(input.admin);
  const { data, error } = await loose
    .from("repository_onboarding_status")
    .upsert(
      {
        conflict_report: input.conflictReport ?? [],
        github_repository_id: input.repositoryId,
        installed_skill_hash: input.installedSkillHash ?? null,
        installed_skill_version: input.installedSkillVersion ?? null,
        last_error: input.lastError ?? null,
        setup_branch_name: input.setupBranchName ?? null,
        setup_pr_number: input.setupPrNumber ?? null,
        setup_pr_url: input.setupPrUrl ?? null,
        status: input.status,
        workspace_id: input.workspaceId,
      },
      { onConflict: "workspace_id,github_repository_id" },
    )
    .select(
      "github_repository_id, status, setup_branch_name, setup_pr_number, setup_pr_url, installed_skill_version, installed_skill_hash, conflict_report, last_error, updated_at",
    )
    .single();

  if (error) throw error;
  return mapOnboardingRow(data as OnboardingRow, input.repositoryId);
}

async function readExistingFile(input: {
  octokit: InstallationOctokit;
  owner: string;
  path: string;
  ref: string;
  repo: string;
}): Promise<ExistingRepositoryFile> {
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
      return { content: null, exists: true, path: input.path };
    }

    const content =
      data.encoding === "base64" && data.content
        ? Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8")
        : null;

    return { content, exists: true, path: input.path };
  } catch (error) {
    if (readGitHubStatus(error) === 404) {
      return { content: null, exists: false, path: input.path };
    }
    return {
      content: null,
      error: error instanceof Error ? error.message : String(error),
      exists: false,
      path: input.path,
    };
  }
}

async function createSetupPullRequest(input: {
  baseBranch: string;
  files: readonly { content: string; path: string }[];
  octokit: InstallationOctokit;
  owner: string;
  repo: string;
  repositoryName: string;
}): Promise<{ branchName: string; prNumber: number; prUrl: string }> {
  const branchName = `wallie/setup-${safeBranchSegment(input.repositoryName)}-${Date.now().toString(36)}`;

  const { data: baseRef } = await input.octokit.request<GitRefResponse>(
    "GET /repos/{owner}/{repo}/git/ref/{ref}",
    {
      owner: input.owner,
      ref: `heads/${input.baseBranch}`,
      repo: input.repo,
    },
  );

  const { data: baseCommit } = await input.octokit.request<GitCommitResponse>(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    {
      commit_sha: baseRef.object.sha,
      owner: input.owner,
      repo: input.repo,
    },
  );

  const { data: tree } = await input.octokit.request<{ sha: string }>(
    "POST /repos/{owner}/{repo}/git/trees",
    {
      base_tree: baseCommit.tree.sha,
      owner: input.owner,
      repo: input.repo,
      tree: input.files.map((file) => ({
        content: file.content,
        mode: "100644",
        path: file.path,
        type: "blob",
      })),
    },
  );

  const { data: commit } = await input.octokit.request<{ sha: string }>(
    "POST /repos/{owner}/{repo}/git/commits",
    {
      message: "chore: set up Wallie workflow skills",
      owner: input.owner,
      parents: [baseRef.object.sha],
      repo: input.repo,
      tree: tree.sha,
    },
  );

  await input.octokit.request("POST /repos/{owner}/{repo}/git/refs", {
    owner: input.owner,
    ref: `refs/heads/${branchName}`,
    repo: input.repo,
    sha: commit.sha,
  });

  const { data: pr } = await input.octokit.request<PullRequestResponse>(
    "POST /repos/{owner}/{repo}/pulls",
    {
      base: input.baseBranch,
      body: [
        "Wallie setup adds repo-local workflow skills so cloud agents can run the same mechanics every time.",
        "",
        "This PR only adds missing Wallie-owned setup files. Existing skill files are never overwritten.",
      ].join("\n"),
      head: branchName,
      owner: input.owner,
      repo: input.repo,
      title: "Set up Wallie workflow skills",
    },
  );

  return { branchName, prNumber: pr.number, prUrl: pr.html_url };
}

export async function startRepositoryOnboarding(input: {
  admin: AdminClient;
  githubAppFactory?: () => GitHubAppLike;
  repositoryId: string;
  workspaceId: string;
}): Promise<StartRepositoryOnboardingResult> {
  const { installation, repository } = await loadRepository(input.admin, input);
  const { owner, repo } = splitRepo(repository.full_name);
  const app = (input.githubAppFactory ?? defaultAppFactory)();
  const octokit = await app.getInstallationOctokit(installation.installation_id);
  const baseBranch = repository.default_branch ?? "main";
  const paths = [
    ...DEFAULT_WALLIE_SKILLS.map((entry) => entry.path),
    WALLIE_AGENTS_INSTRUCTIONS_PATH,
  ];

  const existingFiles = await Promise.all(
    paths.map((path) => readExistingFile({ octokit, owner, path, ref: baseBranch, repo })),
  );
  const plan = buildRepositoryOnboardingPlan({
    existingFiles,
    skillVersion: WALLIE_SKILL_VERSION,
  });
  const existingOnboarding = await loadOnboardingRow(input);

  if (plan.filesToCreate.length > 0 && hasInFlightSetupPullRequest(existingOnboarding)) {
    return {
      onboarding: mapOnboardingRow(existingOnboarding, input.repositoryId),
    };
  }

  if (plan.conflicts.length > 0 && plan.filesToCreate.length === 0) {
    const onboarding = await upsertOnboardingState({
      admin: input.admin,
      conflictReport: plan.conflicts,
      installedSkillHash: null,
      installedSkillVersion: null,
      repositoryId: input.repositoryId,
      status: "conflict",
      workspaceId: input.workspaceId,
    });
    return { onboarding };
  }

  if (plan.filesToCreate.length === 0) {
    const onboarding = await upsertOnboardingState({
      admin: input.admin,
      conflictReport: [],
      installedSkillHash: plan.manifestHash,
      installedSkillVersion: plan.skillVersion,
      repositoryId: input.repositoryId,
      status: "ready",
      workspaceId: input.workspaceId,
    });
    return { onboarding };
  }

  try {
    const pr = await createSetupPullRequest({
      baseBranch,
      files: plan.filesToCreate,
      octokit,
      owner,
      repo,
      repositoryName: repository.name,
    });

    const onboarding = await upsertOnboardingState({
      admin: input.admin,
      conflictReport: plan.conflicts,
      installedSkillHash: plan.conflicts.length === 0 ? plan.manifestHash : null,
      installedSkillVersion: plan.conflicts.length === 0 ? plan.skillVersion : null,
      repositoryId: input.repositoryId,
      setupBranchName: pr.branchName,
      setupPrNumber: pr.prNumber,
      setupPrUrl: pr.prUrl,
      status: plan.conflicts.length > 0 ? "conflict" : "pr_open",
      workspaceId: input.workspaceId,
    });
    return { onboarding };
  } catch (error) {
    const onboarding = await upsertOnboardingState({
      admin: input.admin,
      conflictReport: plan.conflicts,
      lastError: error instanceof Error ? error.message : String(error),
      repositoryId: input.repositoryId,
      status: "error",
      workspaceId: input.workspaceId,
    });
    return { onboarding };
  }
}

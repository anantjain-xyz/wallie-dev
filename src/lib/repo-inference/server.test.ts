import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RepositoryProfileSavePayload } from "@/lib/repo-inference/contracts";
import {
  inferRepositoryProfileForRepository,
  RepositoryProfileError,
  saveWorkspaceRepositoryProfile,
} from "@/lib/repo-inference/server";
import type { Database, Tables } from "@/lib/supabase/database.types";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const REPOSITORY_ID = "11111111-1111-4111-8111-111111111111";

type InstallationRequest = <T = unknown>(
  route: string,
  params?: Record<string, unknown>,
) => Promise<{ data: T }>;

const payload: RepositoryProfileSavePayload = {
  buildCommand: "pnpm build",
  envKeySuggestions: ["DATABASE_URL"],
  frameworkHints: ["next"],
  githubRepositoryId: REPOSITORY_ID,
  inferenceConfidence: "manual",
  inferenceSources: [{ path: "package.json", reason: "Read for static inference" }],
  installCommand: "pnpm install",
  languageHints: ["typescript"],
  packageManager: "pnpm",
  setupNotes: "Use managed secrets.",
  testCommand: "pnpm test",
};

function profileRow(
  overrides: Partial<Tables<"workspace_repository_profiles">> = {},
): Tables<"workspace_repository_profiles"> {
  return {
    build_command: payload.buildCommand,
    created_at: "2026-05-16T18:00:00.000Z",
    env_key_suggestions: payload.envKeySuggestions,
    framework_hints: payload.frameworkHints,
    github_repository_id: REPOSITORY_ID,
    id: "22222222-2222-4222-8222-222222222222",
    inference_confidence: payload.inferenceConfidence,
    inference_sources: payload.inferenceSources,
    install_command: payload.installCommand,
    is_primary: true,
    language_hints: payload.languageHints,
    package_manager: payload.packageManager,
    setup_notes: payload.setupNotes,
    test_command: payload.testCommand,
    updated_at: "2026-05-16T18:00:00.000Z",
    workspace_id: WORKSPACE_ID,
    ...overrides,
  };
}

function createAdminMock(rpcResult: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(rpcResult);
  const repositoryBuilder = {
    eq: vi.fn(() => repositoryBuilder),
    maybeSingle: vi.fn().mockResolvedValue({
      data: {
        default_branch: "main",
        full_name: "acme/app",
        github_installation_id: "installation-row-1",
        id: REPOSITORY_ID,
        is_archived: false,
        workspace_id: WORKSPACE_ID,
      },
      error: null,
    }),
    select: vi.fn(() => repositoryBuilder),
  };
  const installationBuilder = {
    eq: vi.fn(() => installationBuilder),
    maybeSingle: vi.fn().mockResolvedValue({
      data: { installation_id: 123 },
      error: null,
    }),
    select: vi.fn(() => installationBuilder),
  };
  const from = vi.fn((table: string) => {
    if (table === "github_repositories") return repositoryBuilder;
    if (table === "github_installations") return installationBuilder;
    throw new Error(`Unexpected table access: ${table}`);
  });

  return {
    admin: { from, rpc } as unknown as SupabaseClient<Database>,
    from,
    rpc,
  };
}

describe("saveWorkspaceRepositoryProfile", () => {
  it("validates the repository and saves the profile through the atomic rpc", async () => {
    const row = profileRow();
    const { admin, rpc } = createAdminMock({ data: row, error: null });

    const result = await saveWorkspaceRepositoryProfile({
      admin,
      payload,
      workspaceId: WORKSPACE_ID,
    });

    expect(rpc).toHaveBeenCalledWith("save_workspace_repository_profile", {
      selected_build_command: "pnpm build",
      selected_env_key_suggestions: ["DATABASE_URL"],
      selected_framework_hints: ["next"],
      selected_inference_confidence: "manual",
      selected_inference_sources: payload.inferenceSources,
      selected_install_command: "pnpm install",
      selected_language_hints: ["typescript"],
      selected_package_manager: "pnpm",
      selected_setup_notes: "Use managed secrets.",
      selected_test_command: "pnpm test",
      target_github_repository_id: REPOSITORY_ID,
      target_workspace_id: WORKSPACE_ID,
    });
    expect(result).toMatchObject({
      githubRepositoryId: REPOSITORY_ID,
      inferenceConfidence: "manual",
      isPrimary: true,
      workspaceId: WORKSPACE_ID,
    });
  });

  it("maps active profile uniqueness errors returned by the atomic rpc", async () => {
    const { admin } = createAdminMock({
      data: null,
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    });

    await expect(
      saveWorkspaceRepositoryProfile({
        admin,
        payload,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(RepositoryProfileError);
  });
});

describe("inferRepositoryProfileForRepository", () => {
  it("skips unreadable optional candidate files and returns partial inference", async () => {
    const { admin } = createAdminMock({ data: null, error: null });
    const packageJson = JSON.stringify({
      dependencies: { next: "^16.0.0" },
      packageManager: "pnpm@10.15.0",
      scripts: { build: "next build", test: "vitest" },
    });
    const request = vi.fn(async function request<T = unknown>(
      _route: string,
      params?: Record<string, unknown>,
    ): Promise<{ data: T }> {
      if (params?.path === "package.json") {
        return {
          data: {
            content: Buffer.from(packageJson).toString("base64"),
            encoding: "base64",
            type: "file",
          } as T,
        };
      }
      if (params?.path === "README.md") {
        const error = new Error("GitHub API unavailable") as Error & { status?: number };
        error.status = 500;
        throw error;
      }
      const error = new Error("Not found") as Error & { status?: number };
      error.status = 404;
      throw error;
    });

    const result = await inferRepositoryProfileForRepository({
      admin,
      githubAppFactory: () => ({
        getInstallationOctokit: async () => ({ request: request as InstallationRequest }),
      }),
      repositoryId: REPOSITORY_ID,
      workspaceId: WORKSPACE_ID,
    });

    expect(result).toMatchObject({
      buildCommand: "pnpm build",
      githubRepositoryId: REPOSITORY_ID,
      installCommand: "pnpm install",
      packageManager: "pnpm",
      testCommand: "pnpm test",
    });
    expect(result.inferenceSources.map((source) => source.path)).toContain("package.json");
    expect(result.inferenceSources.map((source) => source.path)).not.toContain("README.md");
  });
});

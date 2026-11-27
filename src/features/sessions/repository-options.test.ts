import { describe, expect, it, vi } from "vitest";

import {
  loadSessionRepositoryOptionsWithPrimary,
  resolveDefaultSessionRepositoryId,
} from "@/features/sessions/repository-options";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const DEFAULT_FACTORY_ID = "00000000-0000-4000-8000-000000000010";

function buildSupabase(rows: Array<Record<string, unknown>>) {
  let selected = rows;
  const query = {
    eq: vi.fn((column: string, value: unknown) => {
      if (column === "factory_id") selected = selected.filter((row) => row.factory_id === value);
      return query;
    }),
    order: vi.fn(() => query),
    range: vi.fn(async () => ({ data: selected, error: null })),
    select: vi.fn(() => query),
  };
  const supabase = {
    from: vi.fn(() => query),
  };
  return { query, supabase };
}

describe("loadSessionRepositoryOptionsWithPrimary", () => {
  it("returns valid default-owned repositories but excludes a non-default repo even for a workspace operator", async () => {
    const { query, supabase } = buildSupabase([
      {
        full_name: "acme/api",
        factory_id: DEFAULT_FACTORY_ID,
        id: "repo-api",
        workspace_repository_profiles: [],
      },
      {
        full_name: "acme/web",
        factory_id: DEFAULT_FACTORY_ID,
        id: "repo-web",
        workspace_repository_profiles: [{ is_primary: true }],
      },
      {
        full_name: "example/bench",
        factory_id: "00000000-0000-4000-8000-000000000020",
        id: "repo-bench",
        workspace_repository_profiles: [{ is_primary: true }],
      },
    ]);

    await expect(
      loadSessionRepositoryOptionsWithPrimary({
        factoryId: DEFAULT_FACTORY_ID,
        supabase: supabase as never,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toEqual({
      primaryGithubRepositoryId: "repo-web",
      repositoryOptions: [
        { fullName: "acme/api", id: "repo-api" },
        { fullName: "acme/web", id: "repo-web" },
      ],
    });
    expect(supabase.from).toHaveBeenCalledTimes(1);
    expect(supabase.from).toHaveBeenCalledWith("github_repositories");
    expect(query.select).toHaveBeenCalledWith(
      "id, full_name, workspace_repository_profiles(is_primary), github_installations!inner(id)",
    );
    expect(query.eq).toHaveBeenCalledWith("factory_id", DEFAULT_FACTORY_ID);
    expect(query.range).toHaveBeenCalledTimes(1);
  });
});

describe("resolveDefaultSessionRepositoryId", () => {
  const repositoryOptions = [
    { fullName: "acme/api", id: "repo-api" },
    { fullName: "acme/web", id: "repo-web" },
  ];

  it("prefers an available primary returned with the option set", () => {
    expect(
      resolveDefaultSessionRepositoryId({
        primaryGithubRepositoryId: "repo-web",
        repositoryOptions,
        selectedGithubRepositoryId: "repo-api",
      }),
    ).toBe("repo-web");
  });

  it("falls back through the selected option, first option, and empty set", () => {
    expect(
      resolveDefaultSessionRepositoryId({
        primaryGithubRepositoryId: "repo-archived",
        repositoryOptions,
        selectedGithubRepositoryId: "repo-web",
      }),
    ).toBe("repo-web");
    expect(
      resolveDefaultSessionRepositoryId({
        primaryGithubRepositoryId: null,
        repositoryOptions,
        selectedGithubRepositoryId: "repo-archived",
      }),
    ).toBe("repo-api");
    expect(
      resolveDefaultSessionRepositoryId({
        primaryGithubRepositoryId: null,
        repositoryOptions: [],
        selectedGithubRepositoryId: null,
      }),
    ).toBeNull();
  });
});

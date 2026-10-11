import { describe, expect, it, vi } from "vitest";

import {
  markRepositoryOnboardingReady,
  startRepositoryOnboarding,
} from "@/lib/repo-onboarding/server";
import { WALLIE_SKILL_VERSION, wallieSkillManifestHash } from "@/lib/repo-onboarding/skills";

function buildAdmin(input: {
  onboardingRow: Record<string, unknown> | null;
  repository?: Record<string, unknown>;
}) {
  const upserts: unknown[] = [];
  const state = { onboardingRow: input.onboardingRow, deleting: false };
  const repository = input.repository ?? {
    default_branch: "main",
    full_name: "acme/app",
    github_installation_id: "installation-row-1",
    id: "repo-1",
    is_archived: false,
    name: "app",
    workspace_id: "ws-1",
  };

  const admin = {
    rpc: vi.fn(async (_name: string, snapshot: Record<string, unknown>) => {
      const row = state.onboardingRow;
      if (!row || row.setup_pr_number !== snapshot.source_pull_request_number)
        return { data: false, error: null };
      if (
        !row.setup_pr_updated_at ||
        String(snapshot.source_updated_at) > String(row.setup_pr_updated_at)
      ) {
        row.setup_pr_state = snapshot.source_pull_request_state;
        row.setup_pr_updated_at = snapshot.source_updated_at;
        row.status =
          snapshot.source_pull_request_state === "closed"
            ? "error"
            : row.status === "conflict"
              ? "conflict"
              : snapshot.source_pull_request_state === "merged"
                ? "ready"
                : "pr_open";
      }
      return { data: true, error: null };
    }),
    from(table: string) {
      return {
        select() {
          const chain = {
            eq() {
              return chain;
            },
            maybeSingle: async () => {
              if (table === "github_repositories") {
                return { data: repository, error: null };
              }
              if (table === "github_installations") {
                return { data: { installation_id: 123 }, error: null };
              }
              if (table === "repository_onboarding_status") {
                return { data: state.onboardingRow, error: null };
              }
              if (table === "workspaces") {
                return {
                  data: { deletion_requested_at: state.deleting ? "2026-10-11T00:00:00Z" : null },
                  error: null,
                };
              }
              throw new Error(`unexpected select from ${table}`);
            },
          };
          return chain;
        },
        upsert(values: Record<string, unknown>) {
          upserts.push(values);
          state.onboardingRow = { ...values };
          return {
            select: () => ({
              single: async () => ({ data: values, error: null }),
            }),
          };
        },
      };
    },
  };

  return { admin, upserts, state };
}

const openSnapshot = {
  draft: false,
  html_url: "https://github.com/acme/app/pull/12",
  merged: false,
  number: 12,
  state: "open",
  updated_at: "2026-10-11T00:00:01Z",
};

function setupGitHub(
  input: {
    snapshot?: () => unknown;
    afterMutation?: (route: string) => void;
    afterBaseRead?: () => void;
    createdRefSha?: string;
    cleanupError?: Error;
  } = {},
) {
  return {
    request: vi.fn(async (route: string, params?: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") throw { status: 404 };
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}")
        return {
          data: {
            object: {
              sha: params?.ref === "heads/main" ? "base" : (input.createdRefSha ?? "created"),
            },
          },
        };
      if (route === "DELETE /repos/{owner}/{repo}/git/refs/{ref}") {
        if (input.cleanupError) throw input.cleanupError;
        return { data: null };
      }
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
        input.afterBaseRead?.();
        return { data: { tree: { sha: "base-tree" } } };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}")
        return { data: input.snapshot?.() ?? openSnapshot };
      if (route.startsWith("POST ")) {
        input.afterMutation?.(route);
        return { data: route.endsWith("/pulls") ? openSnapshot : { sha: "created" } };
      }
      throw new Error(`Unexpected GitHub request ${route}`);
    }),
  };
}

function start(fixture: ReturnType<typeof buildAdmin>, octokit: ReturnType<typeof setupGitHub>) {
  return startRepositoryOnboarding({
    admin: fixture.admin as never,
    githubAppFactory: () => ({
      getInstallationOctokit: async () => octokit as never,
    }),
    repositoryId: "repo-1",
    workspaceId: "ws-1",
  });
}

describe("startRepositoryOnboarding", () => {
  it("reuses an in-flight setup PR instead of opening duplicates", async () => {
    const { admin, upserts } = buildAdmin({
      onboardingRow: {
        conflict_report: [{ path: ".agents/skills/symphony-push/SKILL.md" }],
        github_repository_id: "repo-1",
        installed_skill_hash: null,
        installed_skill_version: null,
        last_error: null,
        setup_branch_name: "wallie/setup-app-existing",
        setup_pr_number: 12,
        setup_pr_url: "https://github.com/acme/app/pull/12",
        status: "conflict",
        updated_at: "2026-05-15T00:00:00.000Z",
      },
    });
    const requests: string[] = [];
    const octokit = {
      request: vi.fn(async (route: string) => {
        requests.push(route);
        if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
          throw { status: 404 };
        }
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}")
          return { data: openSnapshot };
        throw new Error(`unexpected GitHub request: ${route}`);
      }),
    };

    const result = await startRepositoryOnboarding({
      admin: admin as never,
      githubAppFactory: () => ({
        getInstallationOctokit: async () => octokit as never,
      }),
      repositoryId: "repo-1",
      workspaceId: "ws-1",
    });

    expect(result.onboarding).toMatchObject({
      setupBranchName: "wallie/setup-app-existing",
      setupPrNumber: 12,
      setupPrUrl: "https://github.com/acme/app/pull/12",
      status: "conflict",
    });
    expect(
      requests.every(
        (route) =>
          route === "GET /repos/{owner}/{repo}/contents/{path}" ||
          route === "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      ),
    ).toBe(true);
    expect(octokit.request).not.toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/pulls",
      expect.anything(),
    );
    expect(upserts).toHaveLength(0);
  });

  it.each([
    { merged: true, state: "closed", expected: "ready" },
    { merged: false, state: "closed", expected: "error" },
  ])(
    "recovers $expected state when the webhook arrived before the setup identity",
    async (outcome) => {
      const f = buildAdmin({ onboardingRow: null });
      let identityAbsentAtDelivery = false;
      const octokit = setupGitHub({
        afterMutation: (route) => {
          if (route.endsWith("/pulls")) identityAbsentAtDelivery = f.state.onboardingRow === null;
        },
        snapshot: () => ({ ...openSnapshot, ...outcome, updated_at: "2026-10-11T00:00:02Z" }),
      });
      const result = await start(f, octokit);
      expect(identityAbsentAtDelivery).toBe(true);
      expect(f.upserts).toHaveLength(1);
      expect(f.upserts[0]).toMatchObject({ setup_pr_number: 12, status: "pr_open" });
      expect(f.admin.rpc).toHaveBeenCalledWith(
        "apply_github_pull_request_event",
        expect.objectContaining({
          target_workspace_id: "ws-1",
          target_repository_id: "repo-1",
          source_pull_request_number: 12,
          source_pull_request_state: outcome.merged ? "merged" : "closed",
          source_updated_at: "2026-10-11T00:00:02Z",
        }),
      );
      expect(result.onboarding).toMatchObject({ setupPrNumber: 12, status: outcome.expected });
    },
  );

  it("returns newer webhook state when the authoritative read was already stale", async () => {
    const f = buildAdmin({ onboardingRow: null });
    const octokit = setupGitHub({
      snapshot: () => {
        Object.assign(f.state.onboardingRow!, {
          status: "ready",
          setup_pr_state: "merged",
          setup_pr_updated_at: "2026-10-11T00:00:03Z",
        });
        return openSnapshot;
      },
    });
    expect((await start(f, octokit)).onboarding).toMatchObject({
      setupPrNumber: 12,
      status: "ready",
    });
    expect(f.upserts).toHaveLength(1);
    expect(f.admin.rpc).toHaveBeenCalledWith(
      "apply_github_pull_request_event",
      expect.objectContaining({ source_pull_request_state: "open" }),
    );
  });

  it("retains a saved identity when refresh fails and reconciles it on retry", async () => {
    const f = buildAdmin({ onboardingRow: null });
    await expect(
      start(
        f,
        setupGitHub({
          snapshot: () => {
            throw new Error("GitHub unavailable");
          },
        }),
      ),
    ).rejects.toThrow("GitHub unavailable");
    expect(f.state.onboardingRow).toMatchObject({ setup_pr_number: 12, status: "pr_open" });
    expect(f.upserts).toHaveLength(1);
    const retry = setupGitHub({
      snapshot: () => ({
        ...openSnapshot,
        merged: true,
        state: "closed",
        updated_at: "2026-10-11T00:00:02Z",
      }),
    });
    expect((await start(f, retry)).onboarding.status).toBe("ready");
    expect(retry.request.mock.calls.some(([route]) => route.startsWith("POST "))).toBe(false);
    expect(f.upserts).toHaveLength(1);
  });

  it("surfaces a failed setup request without persisting a generic error", async () => {
    const f = buildAdmin({ onboardingRow: null });
    await expect(
      start(
        f,
        setupGitHub({
          afterMutation: () => {
            throw new Error("GitHub unavailable");
          },
        }),
      ),
    ).rejects.toThrow("GitHub unavailable");
    expect(f.state.onboardingRow).toBeNull();
    expect(f.upserts).toEqual([]);
  });

  it("preserves a concurrent setup identity when this request fails", async () => {
    const f = buildAdmin({ onboardingRow: null });
    await expect(
      start(
        f,
        setupGitHub({
          afterMutation: () => {
            f.state.onboardingRow = {
              setup_branch_name: "wallie/setup-concurrent",
              setup_pr_number: 24,
              setup_pr_state: "merged",
              status: "ready",
            };
            throw new Error("GitHub unavailable");
          },
        }),
      ),
    ).rejects.toThrow("GitHub unavailable");
    expect(f.state.onboardingRow).toEqual({
      setup_branch_name: "wallie/setup-concurrent",
      setup_pr_number: 24,
      setup_pr_state: "merged",
      status: "ready",
    });
    expect(f.upserts).toEqual([]);
    expect(f.admin.rpc).not.toHaveBeenCalled();
  });

  it("refuses malformed provider state without erasing its saved PR identity", async () => {
    const f = buildAdmin({ onboardingRow: null });
    await expect(
      start(f, setupGitHub({ snapshot: () => ({ ...openSnapshot, updated_at: null }) })),
    ).rejects.toThrow();
    expect(f.state.onboardingRow).toMatchObject({ setup_pr_number: 12, status: "pr_open" });
    expect(f.admin.rpc).not.toHaveBeenCalled();
    expect(f.upserts).toHaveLength(1);
  });

  it("stops before GitHub mutations when deletion begins during setup reads", async () => {
    const f = buildAdmin({ onboardingRow: null });
    const octokit = setupGitHub({
      afterBaseRead: () => {
        f.state.deleting = true;
      },
    });
    await expect(start(f, octokit)).rejects.toThrow("Workspace deletion is in progress.");
    expect(octokit.request.mock.calls.some(([route]) => route.startsWith("POST "))).toBe(false);
    expect(f.upserts).toEqual([]);
  });

  it("rechecks deletion between GitHub mutations", async () => {
    const f = buildAdmin({ onboardingRow: null });
    const octokit = setupGitHub({
      afterMutation: () => {
        f.state.deleting = true;
      },
    });
    await expect(start(f, octokit)).rejects.toThrow("Workspace deletion is in progress.");
    expect(
      octokit.request.mock.calls
        .filter(([route]) => route.startsWith("POST "))
        .map(([route]) => route),
    ).toEqual(["POST /repos/{owner}/{repo}/git/trees"]);
    expect(f.upserts).toEqual([]);
  });

  it("removes its exact created ref when deletion starts before PR creation", async () => {
    const f = buildAdmin({ onboardingRow: null });
    const octokit = setupGitHub({
      afterMutation: (route) => {
        if (route.endsWith("/git/refs")) f.state.deleting = true;
      },
    });
    await expect(start(f, octokit)).rejects.toThrow("Workspace deletion is in progress.");
    const created = octokit.request.mock.calls.find(([route]) => route.endsWith("/git/refs"))![1]!;
    expect(octokit.request).toHaveBeenCalledWith("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
      owner: "acme",
      repo: "app",
      ref: String(created.ref).replace(/^refs\//, ""),
    });
    expect(octokit.request).not.toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/pulls",
      expect.anything(),
    );
    expect(f.upserts).toEqual([]);
  });

  it("never deletes a ref when creation failed because it already existed", async () => {
    const f = buildAdmin({ onboardingRow: null });
    const failure = Object.assign(new Error("Reference already exists"), { status: 422 });
    const octokit = setupGitHub({
      afterMutation: (route) => {
        if (route.endsWith("/git/refs")) throw failure;
      },
    });
    await expect(start(f, octokit)).rejects.toBe(failure);
    expect(octokit.request.mock.calls.some(([route]) => route.startsWith("DELETE "))).toBe(false);
  });

  it("preserves a moved ref and reports that cleanup requires attention", async () => {
    const f = buildAdmin({ onboardingRow: null });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const octokit = setupGitHub({
        createdRefSha: "someone-elses-commit",
        afterMutation: (route) => {
          if (route.endsWith("/git/refs")) f.state.deleting = true;
        },
      });
      await expect(start(f, octokit)).rejects.toThrow("Workspace deletion is in progress.");
      expect(octokit.request.mock.calls.some(([route]) => route.startsWith("DELETE "))).toBe(false);
      expect(log).toHaveBeenCalledWith(
        "Setup branch cleanup failed; the branch may require manual removal.",
        expect.objectContaining({
          repository: "acme/app",
          branch: expect.stringMatching(/^wallie\/setup-app-/),
        }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("preserves the admission error and reports failed cleanup without provider diagnostics", async () => {
    const f = buildAdmin({ onboardingRow: null });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const octokit = setupGitHub({
        cleanupError: new Error("sensitive provider diagnostic"),
        afterMutation: (route) => {
          if (route.endsWith("/git/refs")) f.state.deleting = true;
        },
      });
      await expect(start(f, octokit)).rejects.toThrow("Workspace deletion is in progress.");
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive provider diagnostic");
      expect(f.upserts).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it("does not save a late setup response after workspace deletion starts", async () => {
    const f = buildAdmin({ onboardingRow: null });
    const octokit = setupGitHub({
      afterMutation: (route) => {
        if (route.endsWith("/pulls")) f.state.deleting = true;
      },
    });
    await expect(start(f, octokit)).rejects.toThrow("Workspace deletion is in progress.");
    expect(f.upserts).toEqual([]);
    expect(f.admin.rpc).not.toHaveBeenCalled();
  });
});

describe("markRepositoryOnboardingReady", () => {
  it("records a manual ready state for a valid repository", async () => {
    const { admin, upserts } = buildAdmin({
      onboardingRow: null,
    });

    const result = await markRepositoryOnboardingReady({
      admin: admin as never,
      repositoryId: "repo-1",
      workspaceId: "ws-1",
    });

    expect(result.onboarding).toMatchObject({
      conflictReport: [],
      githubRepositoryId: "repo-1",
      installedSkillHash: wallieSkillManifestHash(),
      installedSkillVersion: WALLIE_SKILL_VERSION,
      lastError: null,
      setupBranchName: null,
      setupPrNumber: null,
      setupPrUrl: null,
      status: "ready",
    });
    expect(upserts).toMatchObject([
      {
        conflict_report: [],
        github_repository_id: "repo-1",
        installed_skill_hash: wallieSkillManifestHash(),
        installed_skill_version: WALLIE_SKILL_VERSION,
        last_error: null,
        setup_branch_name: null,
        setup_pr_number: null,
        setup_pr_url: null,
        status: "ready",
        workspace_id: "ws-1",
      },
    ]);
  });
});

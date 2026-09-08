import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Tables } from "@/lib/supabase/database.types";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  request: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));
vi.mock("@/features/github/config", () => ({
  resolveGitHubAppConfig: () => ({}),
}));
vi.mock("@octokit/app", () => ({
  App: class {
    octokit = { request: mocked.request };
  },
}));

import { upsertGitHubInstallationForWorkspace } from "./service";

const workspaceA = "10000000-0000-4000-8000-000000000001";
const workspaceB = "10000000-0000-4000-8000-000000000002";

function installationRow(
  workspaceId = workspaceA,
  installationId = 42,
): Tables<"github_installations"> {
  return {
    app_id: 123,
    created_at: "2026-09-08T00:00:00Z",
    id: `20000000-0000-4000-8000-${String(installationId).padStart(12, "0")}`,
    installation_id: installationId,
    installation_url: "https://github.com/settings/installations/42",
    permissions: { contents: "write" },
    suspended: false,
    target_name: "original-name",
    target_type: "Organization",
    updated_at: "2026-09-08T00:00:00Z",
    workspace_id: workspaceId,
  };
}

function createAdmin(initialRows: Tables<"github_installations">[] = []) {
  const rows = initialRows.map((row) => ({ ...row }));
  const deleted = vi.fn();
  const updates: Array<{
    filters: Record<string, unknown>;
    patch: Record<string, unknown>;
  }> = [];
  const inserts: Record<string, unknown>[] = [];

  const admin = {
    from(table: string) {
      expect(table).toBe("github_installations");
      return {
        delete: deleted,
        select() {
          return {
            async or(filter: string) {
              const [workspaceFilter, installationFilter] = filter.split(",");
              const workspace = workspaceFilter!.replace("workspace_id.eq.", "");
              const installation = Number(installationFilter!.replace("installation_id.eq.", ""));
              return {
                data: rows.filter(
                  (row) => row.workspace_id === workspace || row.installation_id === installation,
                ),
                error: null,
              };
            },
          };
        },
        insert(record: Tables<"github_installations">) {
          inserts.push(record);
          return {
            select() {
              return {
                async single() {
                  if (
                    rows.some(
                      (row) =>
                        row.installation_id === record.installation_id ||
                        row.workspace_id === record.workspace_id,
                    )
                  ) {
                    return { data: null, error: { code: "23505", message: "Duplicate claim" } };
                  }
                  const row = { ...installationRow(), ...record };
                  rows.push(row);
                  return { data: row, error: null };
                },
              };
            },
          };
        },
        update(patch: Partial<Tables<"github_installations">>) {
          const filters: Record<string, unknown> = {};
          updates.push({ filters, patch });
          const chain = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return chain;
            },
            select() {
              return {
                async single() {
                  const row = rows.find((candidate) =>
                    Object.entries(filters).every(
                      ([column, value]) =>
                        candidate[column as keyof Tables<"github_installations">] === value,
                    ),
                  );
                  if (!row) {
                    return { data: null, error: { code: "PGRST116", message: "Missing row" } };
                  }
                  Object.assign(row, patch);
                  return { data: row, error: null };
                },
              };
            },
          };
          return chain;
        },
      };
    },
  };
  mocked.createSupabaseAdminClient.mockReturnValue(admin);
  return { deleted, inserts, rows, updates };
}

describe("GitHub installation ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.request.mockImplementation(async (_route, input: { installation_id: number }) => ({
      data: {
        account: { login: "updated-name" },
        app_id: 123,
        html_url: `https://github.com/settings/installations/${input.installation_id}`,
        id: input.installation_id,
        permissions: { contents: "write", pull_requests: "write" },
        suspended_at: null,
        target_type: "Organization",
      },
    }));
  });

  it("claims a previously unconnected installation", async () => {
    const db = createAdmin();

    const result = await upsertGitHubInstallationForWorkspace(
      { installationId: 42, workspaceId: workspaceA },
      {},
    );

    expect(result).toMatchObject({ installationId: 42, targetName: "updated-name" });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ workspace_id: workspaceA, installation_id: 42 });
    expect(db.deleted).not.toHaveBeenCalled();
  });

  it("refreshes metadata only for the same workspace and installation", async () => {
    const original = installationRow();
    const db = createAdmin([original]);

    await upsertGitHubInstallationForWorkspace({ installationId: 42, workspaceId: workspaceA }, {});

    expect(db.rows[0]).toMatchObject({ ...original, target_name: "updated-name" });
    expect(db.updates[0]!.filters).toEqual({
      id: original.id,
      installation_id: 42,
      workspace_id: workspaceA,
    });
    expect(db.updates[0]!.patch).not.toHaveProperty("workspace_id");
    expect(db.updates[0]!.patch).not.toHaveProperty("installation_id");
    expect(db.inserts).toHaveLength(0);
    expect(db.deleted).not.toHaveBeenCalled();
  });

  it("retains a suspended installation's status when refreshing metadata", async () => {
    const db = createAdmin([installationRow()]);
    mocked.request.mockResolvedValueOnce({
      data: {
        account: { login: "updated-name" },
        app_id: 123,
        html_url: "https://github.com/settings/installations/42",
        id: 42,
        permissions: {},
        suspended_at: "2026-09-08T00:00:00Z",
        target_type: "Organization",
      },
    });

    await upsertGitHubInstallationForWorkspace({ installationId: 42, workspaceId: workspaceA }, {});

    expect(db.rows[0]!.suspended).toBe(true);
  });

  it.each([false, true])(
    "refuses another workspace's installation without mutation (existing connection: %s)",
    async (hasConnection) => {
      const original = [
        installationRow(workspaceB, 42),
        ...(hasConnection ? [installationRow(workspaceA, 99)] : []),
      ];
      const db = createAdmin(original);

      await expect(
        upsertGitHubInstallationForWorkspace({ installationId: 42, workspaceId: workspaceA }, {}),
      ).rejects.toThrow("already connected to another workspace");

      expect(db.rows).toEqual(original);
      expect(db.deleted).not.toHaveBeenCalled();
      expect(db.updates).toHaveLength(0);
      expect(db.inserts).toHaveLength(0);
      expect(mocked.request).not.toHaveBeenCalled();
    },
  );

  it("requires explicit disconnection before replacing a workspace installation", async () => {
    const original = installationRow(workspaceA, 99);
    const db = createAdmin([original]);

    await expect(
      upsertGitHubInstallationForWorkspace({ installationId: 42, workspaceId: workspaceA }, {}),
    ).rejects.toThrow("Disconnect the current GitHub installation");

    expect(db.rows).toEqual([original]);
    expect(db.deleted).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it("lets only one workspace win concurrent initial claims for an installation", async () => {
    const db = createAdmin();

    const results = await Promise.allSettled(
      [workspaceA, workspaceB].map((workspaceId) =>
        upsertGitHubInstallationForWorkspace({ installationId: 42, workspaceId }, {}),
      ),
    );

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({
      reason: new Error("This GitHub installation is already connected to another workspace."),
    });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]!.workspace_id).toBe(workspaceA);
    expect(db.deleted).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });

  it("refreshes safely when concurrent initial claims have identical ownership", async () => {
    const db = createAdmin();

    const results = await Promise.all([
      upsertGitHubInstallationForWorkspace({ installationId: 42, workspaceId: workspaceA }, {}),
      upsertGitHubInstallationForWorkspace({ installationId: 42, workspaceId: workspaceA }, {}),
    ]);

    expect(results[0]!.id).toBe(results[1]!.id);
    expect(db.rows).toHaveLength(1);
    expect(db.updates).toHaveLength(1);
    expect(db.deleted).not.toHaveBeenCalled();
  });

  it("lets a workspace claim only one installation even when the requests race", async () => {
    const db = createAdmin();

    const results = await Promise.allSettled(
      [42, 99].map((installationId) =>
        upsertGitHubInstallationForWorkspace({ installationId, workspaceId: workspaceA }, {}),
      ),
    );

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]!.installation_id).toBe(42);
    expect(db.deleted).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LINEAR_ROUTING_CONFIG,
  type LinearRoutingUpdateInput,
} from "@/lib/linear-routing/contracts";
import {
  loadLinearRoutingConfig,
  loadLinearRoutingSnapshot,
  saveLinearRoutingConfig,
} from "@/lib/linear-routing/server";

function buildAdmin(row: Record<string, unknown> | null) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({ data: row, error: null });
    },
    from(table: string) {
      if (table !== "workspace_linear_routing") {
        throw new Error(`unexpected table: ${table}`);
      }

      return {
        select() {
          const query = {
            eq() {
              return query;
            },
            maybeSingle: async () => ({ data: row, error: null }),
          };
          return query;
        },
      };
    },
  };

  return { admin, calls };
}

describe("loadLinearRoutingConfig", () => {
  it("returns defaults when the workspace has no routing row", async () => {
    const { admin } = buildAdmin(null);

    await expect(loadLinearRoutingConfig(admin as never, "workspace-1")).resolves.toEqual(
      DEFAULT_LINEAR_ROUTING_CONFIG,
    );
  });

  it("loads a persisted routing configuration", async () => {
    const { admin } = buildAdmin({
      land_stage_slug: "deploy",
      rework_stage_slug: "implement",
      status_mappings: {
        backlog: ["Icebox"],
        canceled: ["Canceled"],
        done: ["Done"],
        in_progress: ["Started"],
        in_review: ["Review"],
        merging: ["Merging"],
        rework: ["Changes Requested"],
        todo: ["Ready"],
      },
    });

    await expect(loadLinearRoutingConfig(admin as never, "workspace-1")).resolves.toEqual({
      landStageSlug: "deploy",
      reworkStageSlug: "implement",
      statusMappings: {
        backlog: ["Icebox"],
        canceled: ["Canceled"],
        done: ["Done"],
        in_progress: ["Started"],
        in_review: ["Review"],
        merging: ["Merging"],
        rework: ["Changes Requested"],
        todo: ["Ready"],
      },
    });
  });

  it("loads manual merge routing when no land stage is configured", async () => {
    const { admin } = buildAdmin({
      land_stage_slug: null,
      rework_stage_slug: "build",
      status_mappings: DEFAULT_LINEAR_ROUTING_CONFIG.statusMappings,
    });

    await expect(loadLinearRoutingConfig(admin as never, "workspace-1")).resolves.toEqual(
      DEFAULT_LINEAR_ROUTING_CONFIG,
    );
  });
});

describe("saveLinearRoutingConfig", () => {
  const reworkStageId = "00000000-0000-4000-8000-000000000003";

  it("saves normalized mappings and returns the resolved stage identities", async () => {
    const statusMappings = { ...DEFAULT_LINEAR_ROUTING_CONFIG.statusMappings, backlog: ["Icebox"] };
    const { admin, calls } = buildAdmin({
      land_stage_slug: null,
      rework_stage_slug: "implement",
      rework_stage_id: reworkStageId,
      status_mappings: statusMappings,
    });
    const config: LinearRoutingUpdateInput = {
      expectedFactoryRevisionId: null,
      landStageSlug: null,
      reworkStageSlug: "implement",
      statusMappings: { ...statusMappings, backlog: [" Icebox ", "icebox"] },
    };

    await expect(
      saveLinearRoutingConfig({
        actorUserId: "user-1",
        admin: admin as never,
        config,
        workspaceId: "workspace-1",
      }),
    ).resolves.toEqual({
      landStageSlug: null,
      reworkStageId,
      reworkStageSlug: "implement",
      statusMappings,
    });
    expect(calls).toEqual([
      {
        name: "save_linear_routing_config",
        args: {
          p_actor_user_id: "user-1",
          p_workspace_id: "workspace-1",
          p_land_slug: undefined,
          p_rework_slug: "implement",
          p_status_mappings: statusMappings,
          p_check_revision: true,
          p_expected_revision_id: undefined,
        },
      },
    ]);
  });
});

describe("loadLinearRoutingSnapshot", () => {
  it("returns a validated config and its exact revision", async () => {
    const { admin } = buildAdmin({
      land_stage_slug: null,
      rework_stage_slug: "build",
      status_mappings: DEFAULT_LINEAR_ROUTING_CONFIG.statusMappings,
      updated_at: "2026-10-02T00:00:00Z",
    });
    await expect(loadLinearRoutingSnapshot(admin as never, "workspace")).resolves.toEqual({
      config: DEFAULT_LINEAR_ROUTING_CONFIG,
      updatedAt: "2026-10-02T00:00:00Z",
    });
  });
  it("rejects missing config instead of routing with defaults", async () => {
    const { admin } = buildAdmin(null);
    await expect(loadLinearRoutingSnapshot(admin as never, "workspace")).rejects.toThrow("missing");
  });
  it("rejects malformed persisted config instead of routing with defaults", async () => {
    const { admin } = buildAdmin({
      land_stage_slug: null,
      rework_stage_slug: "build",
      status_mappings: {},
      updated_at: "2026-10-02T00:00:00Z",
    });
    await expect(loadLinearRoutingSnapshot(admin as never, "workspace")).rejects.toThrow();
  });
});

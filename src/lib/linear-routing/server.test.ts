import { describe, expect, it } from "vitest";

import {
  DEFAULT_LINEAR_ROUTING_CONFIG,
  type LinearRoutingUpdateInput,
} from "@/lib/linear-routing/contracts";
import { loadLinearRoutingConfig, upsertLinearRoutingConfig } from "@/lib/linear-routing/server";

function buildAdmin(row: Record<string, unknown> | null) {
  const upserts: Array<{
    options: Record<string, unknown> | undefined;
    values: Record<string, unknown>;
  }> = [];

  const admin = {
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
        upsert(values: Record<string, unknown>, options?: Record<string, unknown>) {
          upserts.push({ options, values });
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  return { admin, upserts };
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

describe("upsertLinearRoutingConfig", () => {
  it("persists normalized mappings with the workspace conflict target", async () => {
    const { admin, upserts } = buildAdmin(null);
    const config: LinearRoutingUpdateInput = {
      landStageSlug: "deploy",
      reworkStageSlug: "implement",
      statusMappings: {
        backlog: [" Icebox ", "icebox"],
        canceled: ["Canceled"],
        done: ["Done"],
        in_progress: ["Started"],
        in_review: ["Review"],
        merging: ["Merging"],
        rework: ["Changes Requested"],
        todo: ["Ready"],
      },
    };

    await expect(
      upsertLinearRoutingConfig({
        admin: admin as never,
        config,
        workspaceId: "workspace-1",
      }),
    ).resolves.toMatchObject({
      landStageSlug: "deploy",
      reworkStageSlug: "implement",
      statusMappings: { backlog: ["Icebox"] },
    });
    expect(upserts).toEqual([
      {
        options: { onConflict: "workspace_id" },
        values: {
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
          workspace_id: "workspace-1",
        },
      },
    ]);
  });

  it("persists a null land stage for manual merge routing", async () => {
    const { admin, upserts } = buildAdmin(null);

    await expect(
      upsertLinearRoutingConfig({
        admin: admin as never,
        config: DEFAULT_LINEAR_ROUTING_CONFIG,
        workspaceId: "workspace-1",
      }),
    ).resolves.toEqual(DEFAULT_LINEAR_ROUTING_CONFIG);

    expect(upserts[0]?.values).toMatchObject({
      land_stage_slug: null,
      rework_stage_slug: "build",
    });
  });
});

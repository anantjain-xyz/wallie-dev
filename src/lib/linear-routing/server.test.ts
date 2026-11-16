import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_LINEAR_ROUTING_CONFIG,
  type LinearRoutingUpdateInput,
} from "@/lib/linear-routing/contracts";
import {
  loadLinearRoutingConfig,
  loadLinearRoutingSnapshot,
  upsertLinearRoutingConfig,
  validateLinearRoutingStages,
} from "@/lib/linear-routing/server";

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

describe("validateLinearRoutingStages", () => {
  const workspaceId = "54500000-0001-4000-8000-000000000001";
  const factoryId = "54500000-0001-4000-8000-000000000002";
  const revisionId = "54500000-0001-4000-8000-000000000003";
  const pipelineId = "54500000-0001-4000-8000-000000000004";
  const repositoryId = "54500000-0001-4000-8000-000000000005";
  const stageId = "54500000-0001-4000-8000-000000000006";

  function buildValidationAdmin(options: {
    activeDefinitionJson?: string | null;
    liveSlugs?: string[];
  }) {
    const digest = options.activeDefinitionJson
      ? createHash("sha256").update(options.activeDefinitionJson, "utf8").digest("hex")
      : null;
    return {
      from(table: string) {
        let isNullArchived = false;
        const query = {
          eq() {
            return query;
          },
          order() {
            return query;
          },
          limit() {
            return query;
          },
          is(col: string, val: unknown) {
            if (col === "archived_at" && val === null) isNullArchived = true;
            return query;
          },
          in(_col: string, values: string[]) {
            if (table === "pipeline_stages") {
              const rows = (options.liveSlugs ?? [])
                .filter((slug) => isNullArchived && values.includes(slug))
                .map((slug) => ({ slug }));
              return Promise.resolve({ data: rows, error: null });
            }
            return Promise.resolve({ data: [], error: null });
          },
          select() {
            return query;
          },
          maybeSingle: async () => {
            if (table === "factories") return { data: { id: factoryId }, error: null };
            if (table === "factory_definition_activations") {
              return {
                data: options.activeDefinitionJson ? { revision_id: revisionId } : null,
                error: null,
              };
            }
            if (table === "factory_definition_revisions") {
              return {
                data: options.activeDefinitionJson
                  ? { definition_json: options.activeDefinitionJson, canonical_digest: digest }
                  : null,
                error: null,
              };
            }
            if (table === "pipelines") return { data: { id: pipelineId }, error: null };
            return { data: null, error: null };
          },
        };
        return query;
      },
    };
  }

  it("accepts definition-owned stages from a published activation even when backing rows are archived", async () => {
    const definitionJson = JSON.stringify({
      schemaVersion: 1,
      kind: "serial",
      pipelineId,
      repositoryId,
      sandboxProvider: "vercel",
      executionPolicyRevisionId: null,
      deliveryPolicyRevisionId: null,
      skillIds: [],
      toolIds: [],
      operatingRulesMd: "",
      operatingRuleStageIds: [],
      agent: {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        concurrencyLimit: 1,
        stallTimeoutMs: 900000,
        maxRetries: 3,
        maxTurns: 5,
      },
      stages: [
        {
          id: stageId,
          slug: "ship-verify",
          name: "Ship verify",
          description: "",
          promptTemplateMd: "Verify {{session.prompt}}",
          anyoneCanApprove: true,
          approverMemberIds: [],
          previousStageIds: [],
        },
      ],
    });
    const admin = buildValidationAdmin({
      activeDefinitionJson: definitionJson,
      liveSlugs: ["plan"],
    });

    await expect(
      validateLinearRoutingStages({
        admin: admin as never,
        workspaceId,
        config: {
          ...DEFAULT_LINEAR_ROUTING_CONFIG,
          reworkStageSlug: "ship-verify",
          landStageSlug: "ship-verify",
        },
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      validateLinearRoutingStages({
        admin: admin as never,
        workspaceId,
        config: {
          ...DEFAULT_LINEAR_ROUTING_CONFIG,
          reworkStageSlug: "plan",
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Unknown pipeline stage slug: plan",
    });
  });

  it("falls back to unarchived pipeline_stages when no factory activation exists", async () => {
    const admin = buildValidationAdmin({
      activeDefinitionJson: null,
      liveSlugs: ["build"],
    });

    await expect(
      validateLinearRoutingStages({
        admin: admin as never,
        workspaceId,
        config: {
          ...DEFAULT_LINEAR_ROUTING_CONFIG,
          reworkStageSlug: "build",
        },
      }),
    ).resolves.toEqual({ ok: true });
  });
});

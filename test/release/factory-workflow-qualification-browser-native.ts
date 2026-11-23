import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { join } from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { compileWorkflowGraph } from "@/lib/factory-definitions/workflow-compiler";
import {
  workflowPublishReceiptSchema,
  workflowSaveReceiptSchema,
} from "@/lib/factory-workflows/authoring-contracts";
import { materializeWorkflowTemplate } from "@/lib/factory-workflows/workflow-templates";
import type { Database } from "@/lib/supabase/database.types";

type Admin = SupabaseClient<Database>;
type BrowserAdmission = { sessionId: string; jobId: string };
const uuid = z.string().uuid();
const profile = z.object({
  promptRevisionId: uuid,
  profile: z.object({
    definitionRevisionId: uuid,
    definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
const seedSchema = z.object({
  workspaceId: uuid,
  factoryId: uuid,
  workspaceSlug: z.string(),
  ownerEmail: z.string().email(),
  outsiderEmail: z.string().email(),
  outsiderWorkspaceSlug: z.string(),
  baseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  baseActivation: uuid,
  baseRevision: uuid,
  preparationStageIds: uuid.array().nonempty(),
  owner: uuid,
  approver: uuid,
  grant: z.object({ id: uuid, version: z.number().int().positive().safe() }),
  implementation: profile,
  supporting: profile,
  reviewer: z.object({ promptRevisionId: uuid, ruleIds: z.string().array().nonempty() }),
});

async function row<T>(operation: PromiseLike<{ data: T; error: unknown }>) {
  const { data, error } = await operation;
  if (error) throw error;
  assert(data !== null, "The exact browser fixture receipt is unavailable.");
  return data;
}

export function createBrowserNativeFixture(admin: Admin, database: string | undefined) {
  const databaseUrl = new URL(database ?? "");
  assert(
    ["postgresql:", "postgres:"].includes(databaseUrl.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) &&
      !databaseUrl.search &&
      !databaseUrl.hash &&
      /^[a-zA-Z0-9_]+$/.test(databaseUrl.username) &&
      /^\/[a-zA-Z0-9_]+$/.test(databaseUrl.pathname),
    "Browser fixture writes require a disposable loopback Postgres database.",
  );
  const namespace = String(randomInt(65_700_000, 65_790_000));
  const releaseReason = `Disposable M11 browser fixture ${randomUUID()}`;
  let releaseToRestore: number | undefined;

  function runSql(phase: "seed" | "advance", variables: Record<string, string> = {}) {
    const result = spawnSync(
      "psql",
      [
        "-XqAtw",
        "-h",
        databaseUrl.hostname.replace(/^\[|\]$/g, ""),
        "-p",
        databaseUrl.port || "5432",
        "-U",
        databaseUrl.username,
        "-d",
        databaseUrl.pathname.slice(1),
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        `op651_fixture_namespace=${namespace}`,
        ...Object.entries(variables).flatMap(([key, value]) => ["-v", `${key}=${value}`]),
        "-f",
        join("test", "release", `factory-workflow-qualification-browser-${phase}.psql`),
      ],
      {
        timeout: 30_000,
        encoding: "utf8",
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          PGPASSWORD: decodeURIComponent(databaseUrl.password),
        },
      },
    );
    if (result.status !== 0) {
      const line = result.stderr?.match(
        /factory-workflow-qualification-browser-[^\n]*:\d+: (?:error|ERROR): [^\n]+/,
      )?.[0];
      throw new Error(
        line
          ? `Local browser fixture ${phase} failed. ${line}`
          : `Local browser fixture ${phase} failed.`,
      );
    }
    const output = result.stdout.trim().split("\n");
    assert(
      !output.some((line) => line.startsWith("not ok ")),
      `Native browser ${phase} assertions failed.`,
    );
    const json = output.findLast((line) => line.startsWith("{"));
    assert(json, `The browser ${phase} witness is missing.`);
    return JSON.parse(json) as unknown;
  }

  async function prepare() {
    const initialRelease = await row(admin.rpc("get_git_continuity_release_state").single());
    // Know the only revision we can own before the seed can commit, even if
    // its response is lost or cannot be parsed.
    if (!initialRelease.enabled) releaseToRestore = initialRelease.revision + 1;
    const fixture = seedSchema.parse(
      runSql("seed", {
        release_expected_revision: String(initialRelease.revision),
        release_was_enabled: String(initialRelease.enabled),
        release_reason: releaseReason,
      }),
    );
    const graph = materializeWorkflowTemplate({
      templateId: "scoped-fix",
      grant: fixture.grant,
      finalApprovers: { anyoneCanApprove: false, memberIds: [fixture.approver] },
      budget: {
        maxChildren: 2,
        maxConcurrentChildren: 2,
        maxAttempts: 12,
        maxTotalTokens: 1_000,
        maxTokensPerAttempt: 50,
        maxCostUsd: 2,
        maxCostUsdPerAttempt: 0.2,
      },
      implementation: fixture.implementation,
      supporting: fixture.supporting,
      reviewer: fixture.reviewer,
    });
    const prompts = [
      fixture.implementation.promptRevisionId,
      fixture.supporting.promptRevisionId,
      fixture.reviewer.promptRevisionId,
    ];
    const compiled = compileWorkflowGraph(
      { kind: "structured", value: graph },
      {
        workspaceId: fixture.workspaceId,
        approvers: [{ id: fixture.approver, workspaceId: fixture.workspaceId }],
        agentPromptRevisions: [...new Set(prompts)].map((id) => ({
          id,
          workspaceId: fixture.workspaceId,
        })),
        approvedGrants: [{ ...fixture.grant, workspaceId: fixture.workspaceId }],
      },
    );
    assert(compiled.ok, "The fixture template could not compile with its scoped references.");
    const identity = {
      p_workspace_id: fixture.workspaceId,
      p_factory_id: fixture.factoryId,
      p_actor_user_id: fixture.owner,
      p_workflow_id: randomUUID(),
    };
    const base = {
      p_expected_base_activation_id: fixture.baseActivation,
      p_expected_base_revision_id: fixture.baseRevision,
      p_expected_base_digest: fixture.baseDigest,
    };
    await row(
      admin.rpc("create_factory_workflow_authoring", {
        ...identity,
        p_display_name: "M11 scoped fix qualification",
        p_template_id: "scoped-fix",
        p_template_version: 1,
      }),
    );
    const draft = workflowSaveReceiptSchema.parse(
      await row(
        admin.rpc("save_factory_workflow_authoring_draft", {
          ...identity,
          ...base,
          p_request_id: randomUUID(),
          p_workflow_json: compiled.definitionJson,
          p_workflow_digest: compiled.canonicalDigest,
        }),
      ),
    );
    const activation = workflowPublishReceiptSchema.parse(
      await row(
        admin.rpc("publish_factory_workflow_authoring_draft", {
          ...identity,
          ...base,
          p_request_id: randomUUID(),
          p_expected_draft_id: draft.draftId,
          p_verified_draft_digest: compiled.canonicalDigest,
        }),
      ),
    );
    return {
      ...fixture,
      workflow: {
        workflowId: identity.p_workflow_id,
        activationId: activation.activationId,
        graphRevisionId: activation.graphRevisionId,
      },
    };
  }

  function advance(serial: BrowserAdmission, graph: BrowserAdmission) {
    return runSql("advance", {
      serial_session: serial.sessionId,
      serial_job: serial.jobId,
      graph_session: graph.sessionId,
      graph_job: graph.jobId,
    });
  }

  async function restoreRelease() {
    if (releaseToRestore === undefined) return;
    const release = await row(admin.rpc("get_git_continuity_release_state").single());
    if (
      !release.enabled ||
      release.revision !== releaseToRestore ||
      release.reason !== releaseReason
    )
      return;
    await row(
      admin
        .rpc("set_git_continuity_release", {
          p_enabled: false,
          p_expected_revision: releaseToRestore,
          p_reason: "Finish the disposable M11 browser fixture",
        })
        .single(),
    );
  }

  return { prepare, advance, restoreRelease };
}

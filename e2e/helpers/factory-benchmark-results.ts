import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { compiledFactoryDefinitionSchema } from "@/lib/factory-definitions/schema";
import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import type { Database } from "@/lib/supabase/database.types";

import { seedFactoryAnalytics } from "./factory-analytics";

export function checked<T>(result: { data: T; error: unknown }): NonNullable<T> {
  if (result.data == null) throw result.error ?? new Error("Missing fixture data.");
  return result.data;
}

export async function seedBenchmarkResults(
  baseURL: string | undefined,
  retained?: {
    inputCommitSha: string;
    inputTreeSha: string;
    outputCommitSha: string;
    outputTreeSha: string;
    patch: string;
    patchSha256: string;
  },
) {
  const fixture = await seedFactoryAnalytics(baseURL);
  const admin = createClient<Database>(
    z.url().parse(process.env.NEXT_PUBLIC_SUPABASE_URL),
    z.string().min(1).parse(process.env.SUPABASE_SECRET_KEY),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  let storagePath: string | undefined;
  async function cleanup() {
    await fixture.cleanup();
    if (storagePath) {
      checked(await admin.storage.from("session-source-checkpoints").remove([storagePath]));
    }
  }

  try {
    const [repositoryResult, stageResult] = await Promise.all([
      admin
        .from("github_repositories")
        .select("id")
        .eq("workspace_id", fixture.workspaceId)
        .eq("factory_id", fixture.factoryId)
        .single(),
      admin
        .from("pipeline_stages")
        .select("slug,name")
        .eq("workspace_id", fixture.workspaceId)
        .eq("id", fixture.stageId)
        .single(),
    ]);
    const repository = checked(repositoryResult);
    const stage = checked(stageResult);
    const sourceId = randomUUID();
    const candidateId = randomUUID();
    const experimentId = randomUUID();
    const sourceModel = "gpt-4.1-2025-04-14";
    const candidateModel = "gpt-4.1-mini-2025-04-14";
    function definition(model: string) {
      return serializeFactoryDefinition(
        compiledFactoryDefinitionSchema.parse({
          schemaVersion: 1,
          kind: "serial",
          pipelineId: fixture.pipelineId,
          repositoryId: repository.id,
          sandboxProvider: "vercel",
          agent: {
            provider: "codex",
            model,
            effort: null,
            concurrencyLimit: 1,
            stallTimeoutMs: 120_000,
            maxRetries: 1,
            maxTurns: 5,
          },
          executionPolicyRevisionId: null,
          deliveryPolicyRevisionId: null,
          skillIds: [],
          toolIds: [],
          operatingRulesMd: "",
          operatingRuleStageIds: [],
          stages: [
            {
              id: fixture.stageId,
              slug: stage.slug,
              name: stage.name,
              description: "",
              promptTemplateMd: "Reconcile the invoice and verify the saved totals.",
              anyoneCanApprove: false,
              approverMemberIds: [],
              previousStageIds: [],
            },
          ],
        }),
      );
    }
    const source = definition(sourceModel);
    const candidate = definition(candidateModel);
    const saved = z
      .object({
        suiteId: z.uuid(),
        suiteRevisionId: z.uuid(),
        scorerRevisionId: z.uuid(),
        taskRevisionIds: z.array(z.uuid()).length(2),
        storagePath: z.string(),
        successfulTrialId: z.uuid(),
        successfulRunId: z.uuid(),
      })
      .parse(
        await fixture.runFixtureFile("factory-benchmark-results-seed.sql", {
          workspace_id: fixture.workspaceId,
          factory_id: fixture.factoryId,
          owner_id: fixture.ownerId,
          pipeline_id: fixture.pipelineId,
          stage_id: fixture.stageId,
          stage_slug: stage.slug,
          repository_id: repository.id,
          experiment_id: experimentId,
          excluded_run_id: fixture.failedRunId,
          source_definition_id: sourceId,
          source_definition_json: source.definitionJson,
          source_definition_digest: source.canonicalDigest,
          candidate_definition_id: candidateId,
          candidate_definition_json: candidate.definitionJson,
          candidate_definition_digest: candidate.canonicalDigest,
          input_commit_sha: retained?.inputCommitSha ?? "a".repeat(40),
          input_tree_sha: retained?.inputTreeSha ?? "a".repeat(40),
          output_commit_sha: retained?.outputCommitSha ?? "b".repeat(40),
          output_tree_sha: retained?.outputTreeSha ?? "b".repeat(40),
          output_patch: retained?.patch ?? "",
          output_patch_sha256: retained?.patchSha256 ?? "",
        }),
      );
    storagePath = saved.storagePath;
    return {
      ...fixture,
      admin,
      saved,
      experimentId,
      sourceId,
      candidateId,
      sourceModel,
      candidateModel,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

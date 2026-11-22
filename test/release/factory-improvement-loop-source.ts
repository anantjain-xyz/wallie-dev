import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { createFactoryAgent } from "@/lib/factory-agents/service";
import { loadFactoryDefinitionCatalog } from "@/lib/factory-definitions/authority";
import {
  compileFactoryDefinition,
  factoryComponentRevisionsForSource,
  type FactoryDefinitionSource,
} from "@/lib/factory-definitions/compiler";
import { recompileStoredFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import { diagnosisReceiptSchema } from "@/lib/factory-diagnosis/contracts";
import { drainFactoryDiagnoses } from "@/lib/factory-diagnosis/worker";
import { saveFactoryJudgeProfile } from "@/lib/factory-evaluations/judge-profile-controls";
import { getFailureCohort, listFailureCohorts } from "@/lib/factory-failures/cohorts";
import { saveFactoryImprovementProposal } from "@/lib/factory-proposals/server";
import { FakeSandbox } from "@/lib/sandbox/fake";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";
import {
  captureValidationEvidence,
  readValidationIdentity,
} from "@/lib/validation-evidence/capture";
import type { ValidationPlan } from "@/lib/validation-evidence/contracts";
import { persistValidationEvidence } from "@/lib/validation-evidence/service";
import { saveVercelSandboxConnection } from "@/lib/vercel-sandbox/server";

import {
  improvementQualificationDatabaseEnvironment,
  improvementQualificationFixtureId,
  improvementQualificationInstallationSlot,
  type ImprovementLoopContext,
  type ImprovementLoopSource,
} from "./factory-improvement-loop-contract";
import { assertImprovementLoopProject } from "./factory-improvement-loop-project";
import { improvementLoopFixtureJudge } from "./factory-improvement-loop-replay-contract";

export { assertImprovementLoopProject } from "./factory-improvement-loop-project";

const runnerModel = "gpt-4.1-2025-04-14";
const baselinePrompt = "Implement {{session.prompt}}.";
const candidatePrompt = "Implement {{session.prompt}} and check the required acceptance marker.";
const validationPlan: ValidationPlan = {
  version: 1,
  commands: [
    {
      key: "acceptance-marker",
      command: "printf 'Required acceptance marker is missing.\\n'; test -f acceptance-marker.txt",
      timeoutSeconds: 10,
      reports: [],
    },
  ],
};

function sourceSql(env: NodeJS.ProcessEnv, input: string, variables: Record<string, string>) {
  return execFileSync(
    "psql",
    [
      "-XqAt",
      "--no-password",
      "--set=ON_ERROR_STOP=1",
      "--single-transaction",
      "--file=-",
      ...Object.entries(variables).map(([name, value]) => `--set=${name}=${value}`),
    ],
    {
      input,
      encoding: "utf8",
      timeout: 30_000,
      env,
    },
  ).trim();
}

async function receipt<T>(
  request: PromiseLike<{ data: T | null; error: unknown }>,
  action: string,
) {
  const { data, error } = await request;
  if (error || data === null) throw new Error(action, { cause: error });
  return data;
}

function authenticatedReader(context: ImprovementLoopContext, userId: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({
      sub: userId,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  ].join(".");
  const signature = createHmac("sha256", context.jwtSecret).update(claims).digest("base64url");
  return createClient<Database>(context.apiUrl, context.anonymousKey, {
    accessToken: async () => `${claims}.${signature}`,
    global: { fetch },
  });
}

async function runSyntheticDiagnosis(
  context: ImprovementLoopContext,
  databaseEnv: NodeJS.ProcessEnv,
  queued: z.infer<typeof diagnosisReceiptSchema>,
) {
  const members = queued.evidence ?? [];
  assert.equal(members.length, 3);
  // The global claim also expires pending rows in other workspaces.
  const solePendingDiagnosis = sourceSql(
    databaseEnv,
    `set transaction read only;
    select count(*) = 1 and count(*) filter (where
      (workspace_id,factory_id,id) = (:'workspace_id'::uuid,:'factory_id'::uuid,:'diagnosis_id'::uuid)
      and status = 'queued' and requested_at + interval '10 minutes' > clock_timestamp()) = 1
    from internal.factory_diagnoses where status in ('queued','claimed','running');`,
    {
      workspace_id: queued.workspace_id,
      factory_id: queued.factory_id,
      diagnosis_id: queued.diagnosis_id,
    },
  );
  assert.equal(
    solePendingDiagnosis,
    "t",
    "Diagnosis qualification requires the exact fixture diagnosis to be the only pending job in an exclusive database.",
  );
  const loopbackOrigin = new URL(context.apiUrl).origin;
  const fetchBefore = globalThis.fetch;
  let requests = 0;
  let requestError: unknown;
  globalThis.fetch = async (input, options) => {
    const request = new Request(input, options);
    if (new URL(request.url).origin === loopbackOrigin) return fetchBefore(input, options);
    try {
      assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
      assert(request.headers.get("Authorization") === `Bearer ${improvementLoopFixtureJudge.key}`);
      requests += 1;
      const body = await request.text();
      assert(!body.includes(improvementLoopFixtureJudge.key));
      assert(!body.includes('"tools":'));
      for (const member of members) {
        assert(body.includes(member.member_id));
        assert(body.includes(member.run_id));
      }
      return Response.json({
        model: queued.model_id,
        provider: improvementLoopFixtureJudge.provider,
        id: "synthetic-m10-diagnosis",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                version: 1,
                claims: [
                  {
                    member_ids: members.map((member) => member.member_id),
                    inferred_cause: "The producing prompt may omit the required acceptance marker.",
                    uncertainty: "Only these three retained validation failures were inspected.",
                  },
                ],
              }),
            },
          },
        ],
        usage: { completion_tokens: 64 },
      });
    } catch (error) {
      requestError = error;
      throw error;
    }
  };
  try {
    assert.equal(await drainFactoryDiagnoses(context.admin, "node"), true);
    if (requestError) throw requestError;
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = fetchBefore;
  }
}

export async function prepareImprovementLoopSource(
  context: ImprovementLoopContext,
): Promise<ImprovementLoopSource> {
  const { admin } = context;
  const workspaceId = z.uuid().parse(context.runId);
  await assertImprovementLoopProject(context);
  const databaseEnv = improvementQualificationDatabaseEnvironment(context.dbUrl);
  const slot = (value: number) => improvementQualificationFixtureId(workspaceId, value);
  const workspaceSlug = `m10-${workspaceId}`;
  const ownerEmail = `${workspaceSlug}@example.test`;
  const actorUserId = slot(1);
  const memberId = slot(21);
  const pipelineId = slot(31);
  const stageId = slot(32);
  const repositoryId = slot(41);
  const baselineId = slot(51);
  const repositoryNumber = 642_000_000_000 + Number.parseInt(workspaceId.slice(0, 8), 16);
  const installation = context.githubInstallation ?? {
    id: repositoryNumber - 1,
    appId: 64200,
    url: `https://github.test/installations/${repositoryNumber - 1}`,
    targetType: "Organization",
    owner: "Loop qualification",
  };
  const factoryId = z.uuid().parse(
    sourceSql(
      databaseEnv,
      readFileSync(new URL("./factory-improvement-loop-source.psql", import.meta.url), "utf8"),
      {
        actor_id: actorUserId,
        workspace_id: workspaceId,
        workspace_slug: workspaceSlug,
        owner_email: ownerEmail,
        member_id: memberId,
        pipeline_id: pipelineId,
        stage_id: stageId,
        baseline_prompt: baselinePrompt,
        installation_id: slot(improvementQualificationInstallationSlot),
        installation_number: String(installation.id),
        installation_app_id: String(installation.appId),
        installation_url: installation.url,
        installation_type: installation.targetType,
        installation_owner: installation.owner,
        repository_id: repositoryId,
        repository_number: String(repositoryNumber),
        codex_ciphertext: encryptSecretValue("synthetic-m10-codex-credential"),
      },
    ),
  );
  const scope = { p_workspace_id: workspaceId, p_factory_id: factoryId };
  const actor = { ...scope, p_actor_user_id: actorUserId };
  const actorScope = { workspaceId, factoryId, actorUserId };
  const reader = authenticatedReader(context, actorUserId);

  const agent = z.object({ id: z.uuid(), agent_id: z.uuid() });
  const [builder, reviewer] = z.tuple([agent, agent]).parse(
    await Promise.all([
      createFactoryAgent(admin, {
        ...actorScope,
        name: "Builder",
        slug: "m10-builder",
        promptMd: "Implement the frozen task and report its result.",
      }),
      createFactoryAgent(admin, {
        ...actorScope,
        name: "Reviewer",
        slug: "m10-reviewer",
        promptMd: "Cite the exact frozen failure evidence and retain uncertainty.",
      }),
    ]),
  );
  await saveVercelSandboxConnection({
    admin,
    workspaceId,
    createdByMemberId: memberId,
    projectName: "M10 synthetic sandbox",
    credentials: {
      token: "synthetic-m10-vercel-token",
      teamId: "team_m10_fixture",
      projectId: "prj_m10_fixture",
    },
  });
  await saveFactoryJudgeProfile(admin, actorScope, {
    expectedRevision: 0,
    modelId: improvementLoopFixtureJudge.model,
    providerRoute: improvementLoopFixtureJudge.provider,
    allowImages: false,
    allowVideo: false,
    apiKey: improvementLoopFixtureJudge.key,
  });

  const definition: FactoryDefinitionSource = {
    kind: "structured",
    value: {
      schemaVersion: 1,
      kind: "serial",
      sandboxProvider: "vercel",
      pipeline: pipelineId,
      repository: repositoryId,
      agent: {
        provider: "codex",
        model: runnerModel,
        concurrencyLimit: 2,
        stallTimeoutMs: 120_000,
        maxRetries: 0,
        maxTurns: 10,
      },
      implementationAgent: builder.id,
      stages: [
        {
          id: stageId,
          slug: "build",
          name: "Build",
          promptTemplateMd: baselinePrompt,
          anyoneCanApprove: true,
        },
      ],
      modelRouting: {
        version: 1,
        taskClasses: [{ id: slot(45), slug: "build", name: "Build" }],
        rules: [],
        onUnmatched: { kind: "escalate" },
      },
    },
  };
  const signal = AbortSignal.timeout(120_000);
  const catalog = await loadFactoryDefinitionCatalog(
    admin,
    { workspaceId, factoryId, ...factoryComponentRevisionsForSource(definition) },
    signal,
  );
  const compiled = compileFactoryDefinition(definition, catalog);
  assert(compiled.ok, compiled.ok ? undefined : JSON.stringify(compiled.diagnostics));
  sourceSql(
    databaseEnv,
    `
    insert into public.factory_definition_revisions(id,workspace_id,factory_id,schema_version,
      definition_json,canonical_digest,created_by)
    values (:'revision_id'::uuid,:'workspace_id'::uuid,:'factory_id'::uuid,:'schema_version'::integer,
      :'definition_json',:'canonical_digest',:'actor_id'::uuid);
    insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
    values (:'workspace_id'::uuid,:'factory_id'::uuid,:'revision_id'::uuid,1,:'actor_id'::uuid);
    `,
    {
      revision_id: baselineId,
      workspace_id: workspaceId,
      factory_id: factoryId,
      schema_version: String(compiled.bundle.schemaVersion),
      definition_json: compiled.definitionJson,
      canonical_digest: compiled.canonicalDigest,
      actor_id: actorUserId,
    },
  );
  const saved = z
    .object({ id: z.uuid(), definition_json: z.string(), canonical_digest: z.string() })
    .parse(
      await receipt(
        admin
          .from("factory_definition_revisions")
          .select("id,definition_json,canonical_digest")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .eq("id", baselineId)
          .single(),
        "Could not read the canonical fixture baseline.",
      ),
    );
  assert.equal(saved.definition_json, compiled.definitionJson);
  assert.equal(saved.canonical_digest, compiled.canonicalDigest);
  assert(
    recompileStoredFactoryDefinition(saved.definition_json, saved.canonical_digest, catalog).ok,
  );
  const baseline = {
    activationNumber: 1,
    revisionId: saved.id,
    digest: saved.canonical_digest,
    definitionJson: saved.definition_json,
  };

  const startAttempt = readFileSync(
    new URL("./factory-improvement-loop-attempt.psql", import.meta.url),
    "utf8",
  );
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  const sourceRunIds: string[] = [];
  try {
    const identity = await readValidationIdentity(sandbox, signal);
    for (const number of [1, 2, 3]) {
      const [created] = await receipt(
        admin.rpc("create_session_with_first_job", {
          target_workspace_id: workspaceId,
          creator_member_id: memberId,
          session_title: `M10 repeated validation failure ${number}`,
          session_prompt_md: "Implement the fixture change.",
          agent_model_provider: "codex",
          agent_model_name: runnerModel,
          session_github_repository_id: repositoryId,
          selected_pipeline_id: pipelineId,
          selected_stage_ids: [stageId],
        }),
        "Could not create a scoped production session.",
      );
      assert(created);
      const runId = z.uuid().parse(
        sourceSql(databaseEnv, startAttempt, {
          workspace_id: workspaceId,
          job_id: created.job_id,
          session_id: created.session_id,
          stage_id: stageId,
          runner_model: runnerModel,
          repository_id: repositoryId,
          commit_sha: identity.commitSha,
          tree_sha: identity.treeSha,
          plan: JSON.stringify(validationPlan),
        }),
      );
      const evidence = await captureValidationEvidence({
        sandbox,
        commitSha: identity.commitSha,
        plan: validationPlan,
        signal,
      });
      assert.equal(evidence.records[0]?.status, "failed");
      assert.equal(evidence.records[0]?.exitCode, 1);
      await persistValidationEvidence({ admin, workspaceId, runId, evidence, signal });
      assert.equal(
        await receipt(
          admin.rpc("fail_session_job_attempt", {
            p_job_id: created.job_id,
            p_attempt_count: 1,
            p_run_id: runId,
            p_error: "The required acceptance marker was missing.",
            p_retry: false,
            p_max_retries: 0,
          }),
          "Could not settle the exact failed attempt.",
        ),
        "error",
      );
      sourceRunIds.push(runId);
    }
  } finally {
    await sandbox.stop();
  }

  for (let processed = 1; processed > 0; ) {
    signal.throwIfAborted();
    processed = await receipt(
      admin.rpc("process_factory_failure_cohorts", { p_batch_size: 100 }).abortSignal(signal),
      "Could not process failure cohorts.",
    );
  }
  const publicScope = { workspaceId, factoryId };
  const listed = await listFailureCohorts(reader, publicScope, { symptom: "validation" });
  assert.equal(listed?.cohorts.length, 1);
  const cohortId = listed?.cohorts[0]?.id;
  assert(cohortId);
  const cohort = await getFailureCohort(reader, publicScope, cohortId, {});
  assert(cohort);
  assert.equal(cohort.cohort.qualification, "qualified");
  assert.equal(cohort.cohort.support_count, 3);
  assert.equal(cohort.cohort.version_count, 1);
  assert.deepEqual(new Set(cohort.members.map((member) => member.run_id)), new Set(sourceRunIds));
  assert.equal(new Set(cohort.members.map((member) => member.session_id)).size, 3);
  const queued = diagnosisReceiptSchema.parse(
    await receipt(
      admin.rpc("request_factory_diagnosis", {
        ...actor,
        p_cohort_id: cohortId,
        p_prompt_revision_id: reviewer.id,
        p_request_id: randomUUID(),
      }),
      "Could not request a scoped diagnosis.",
    ),
  );
  assert.equal(queued.status, "queued");
  assert(queued.evidence?.every((member) => member.producing_agent_id === builder.agent_id));
  await runSyntheticDiagnosis(context, databaseEnv, queued);
  const diagnosed = diagnosisReceiptSchema.parse(
    await receipt(
      reader.rpc("get_factory_diagnosis", { ...scope, p_diagnosis_id: queued.diagnosis_id }),
      "Could not read the completed scoped diagnosis.",
    ),
  );
  assert.equal(diagnosed.status, "completed");
  assert.equal(diagnosed.evidence_digest, queued.evidence_digest);
  assert.equal(diagnosed.trace?.provider_request_id, "synthetic-m10-diagnosis");
  assert.deepEqual(
    new Set(diagnosed.result?.claims[0]?.member_ids),
    new Set(cohort.members.map((member) => member.id)),
  );

  const proposalScope = { client: admin, ...publicScope, signal };
  const command = {
    requestId: randomUUID(),
    diagnosisId: diagnosed.diagnosis_id,
    base: {
      activationNumber: baseline.activationNumber,
      revisionId: baseline.revisionId,
      digest: baseline.digest,
    },
    rationale: "Retained validation repeatedly found the acceptance marker missing.",
    expectedBenefit: "Make the acceptance check explicit in the producing stage.",
    regressionRisks: "An unrelated task should still preserve its own acceptance criteria.",
    edits: [
      {
        kind: "stage_prompt" as const,
        stageId,
        expectedPromptSha256: createHash("sha256").update(baselinePrompt).digest("hex"),
        promptTemplateMd: candidatePrompt,
      },
    ],
  };
  await assert.rejects(
    saveFactoryImprovementProposal(proposalScope, actorUserId, {
      ...command,
      requestId: randomUUID(),
      base: { ...command.base, digest: "0".repeat(64) },
    }),
    { code: "PT409" },
  );
  const { proposal } = await saveFactoryImprovementProposal(proposalScope, actorUserId, command);
  assert.equal(proposal.status, "compiled");
  assert.notEqual(proposal.candidate.digest, baseline.digest);
  assert(
    recompileStoredFactoryDefinition(
      proposal.candidate.definitionJson,
      proposal.candidate.digest,
      catalog,
    ).ok,
  );
  const active = z
    .object({ activation_number: z.number(), revision_id: z.uuid() })
    .parse(
      await receipt(
        admin
          .from("factory_definition_activations")
          .select("activation_number,revision_id")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .order("activation_number", { ascending: false })
          .limit(1)
          .single(),
        "Could not inspect the active definition after compilation.",
      ),
    );
  assert.equal(active.activation_number, baseline.activationNumber);
  assert.equal(active.revision_id, baseline.revisionId);

  return {
    workspaceId,
    workspaceSlug,
    factoryId,
    actorUserId,
    ownerEmail,
    cohortId,
    diagnosisId: diagnosed.diagnosis_id,
    proposalId: proposal.proposalId,
    proposalRevisionId: proposal.revisionId,
    sourceRunIds,
    baseline,
    candidate: proposal.candidate,
  };
}

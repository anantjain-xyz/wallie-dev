import assert from "node:assert/strict";
import { createHash, randomInt, randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { compiledFactoryDefinitionSchema } from "@/lib/factory-definitions/schema";
import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import { runContextInspectionSchema, runContextManifestSchema } from "@/lib/run-context/contracts";
import { getSandboxProviderContract } from "@/lib/sandbox/provider-contract";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";
import {
  browserCaptureReceiptSchema,
  evaluateBrowserRequirement,
} from "@/lib/validation-evidence/browser-contract";
import { validationPlanSchema, type ValidationPlan } from "@/lib/validation-evidence/contracts";
import { resumeWorkspaceDeletion } from "@/lib/workspaces/deletion";

import {
  approveM05Memory,
  correctM05Memory,
  type createM05ContextProvider,
  M05_ORIGINAL_DOCUMENT,
  M05_ORIGINAL_MEMORY,
  M05_UPDATED_DOCUMENT,
  M05_UPDATED_MEMORY,
  registerM05BrowserTools,
  registerM05ContextRepository,
  registerM05ContextSource,
  syncM05ContextRevision,
} from "./factory-m05-inputs";
import {
  BASE_SHA,
  FIXTURE_AGENT_EXIT,
  HOSTED_SANDBOX_KEY,
  QUALIFICATION_COMMAND,
  TREE_SHA,
  type FactoryRuntimeTransport,
} from "./factory-runtime-transport";

const provider = "e2b";
const agent = "codex";
const humanModel = "gpt-5.5";
const pinnedModel = "gpt-5.6-sol";
const replacementModel = "gpt-5.6-astra";
const humanKey = "synthetic-local-human-key";
const serviceKey = "synthetic-local-scoped-key";
const siblingKey = "synthetic-local-sibling-key";
const fixtureWorkspaceName = "Factory runtime qualification";

const fixtureSchema = z.object({
  url: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    }),
  serviceKey: z.string().min(1),
  publishableKey: z.string().min(1),
  m05: z.boolean().default(false),
});

type Admin = SupabaseClient<Database>;
type Job = { job_id: string; run_id: string; session_id: string };
type BrowserTools = Awaited<ReturnType<typeof registerM05BrowserTools>>;
type ContextRevision = Awaited<ReturnType<typeof syncM05ContextRevision>>;
type MemoryApproval = Awaited<ReturnType<typeof approveM05Memory>>;

export type FixtureBrowserRun = Pick<BrowserTools, "screenshotScopeId" | "videoScopeId"> & {
  runId: string;
  commitSha: string;
  treeSha: string;
  mode: "capture" | "reject";
};

export type FactoryBrowserReviewFixture = {
  owner: { email: string; password: string };
  workspaceId: string;
  workspaceSlug: string;
  factoryId: string;
  sessionId: string;
  sessionNumber: number;
  artifact: { id: string; stageSlug: string; version: number };
  run: { id: string; otherRunId: string; commitSha: string; validationTreeSha: string };
  screenshot: { id: string; sha256: string };
  recording: { id: string; sha256: string; stepOffsetMs: number };
  context: { sourceId: string; revisionId: string; sha256: string };
  memory: { entryId: string; approvedRevisionId: string; sha256: string };
};

type QualificationInput = {
  admin: Admin;
  viewer: Admin;
  runtime: "node" | "workerd";
  transport: FactoryRuntimeTransport;
  execute: (job: Job, browser?: FixtureBrowserRun) => Promise<void>;
  m05?: {
    upstream: ReturnType<typeof createM05ContextProvider>;
    inspectReview?: (fixture: FactoryBrowserReviewFixture) => Promise<void>;
  };
};

export function createFactoryRuntimeClients(rawFixture: string) {
  const config = fixtureSchema.parse(JSON.parse(rawFixture));
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  return {
    config,
    admin: createClient<Database>(config.url, config.serviceKey, options),
    viewer: createClient<Database>(config.url, config.publishableKey, options),
  };
}

async function checked<T>(
  request: PromiseLike<{ data: T; error: unknown }>,
  operation: string,
): Promise<NonNullable<T>> {
  const { data, error } = await request;
  if (error) {
    const message = typeof error === "object" && "message" in error ? String(error.message) : "";
    throw new Error(operation + ": " + message);
  }
  // Inserts without a returning clause have no response representation.
  return data as NonNullable<T>;
}

async function deleteFixtureUser(admin: Admin, userId: string) {
  let result = await admin.auth.admin.deleteUser(userId);
  if (result.error?.name === "AuthRetryableFetchError") {
    result = await admin.auth.admin.deleteUser(userId);
  }
  if (result.error && result.error.code !== "user_not_found") throw result.error;
}

async function openReleaseGate(admin: Admin) {
  const [state] = await checked(admin.rpc("get_git_continuity_release_state"), "read release gate");
  assert(state);
  if (state.enabled) return async () => {};
  const [enabled] = await checked(
    admin.rpc("set_git_continuity_release", {
      p_enabled: true,
      p_expected_revision: state.revision,
      p_reason: "Disposable factory runtime qualification",
    }),
    "enable fixture release gate",
  );
  assert(enabled?.enabled);
  return async () => {
    await checked(
      admin.rpc("set_git_continuity_release", {
        p_enabled: state.enabled,
        p_expected_revision: enabled.revision,
        p_reason: state.reason,
      }),
      "restore fixture release gate",
    );
  };
}

async function createWorkspace(admin: Admin, actorId: string, slug: string) {
  const { id: workspaceId } = await checked(
    admin.rpc("create_workspace", {
      actor_user_id: actorId,
      requested_slug: slug,
      workspace_name: fixtureWorkspaceName,
    }),
    "create workspace",
  );
  return workspaceId;
}

async function seedWorkspace(admin: Admin, workspaceId: string, actorId: string, slug: string) {
  const [factory, sibling, member, pipeline] = await Promise.all([
    checked(
      admin
        .from("factories")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("is_default", true)
        .single(),
      "find default factory",
    ),
    checked(
      admin.rpc("create_factory", {
        p_workspace_id: workspaceId,
        p_actor_user_id: actorId,
        p_slug: "sibling",
        p_name: "Sibling",
      }),
      "create sibling factory",
    ),
    checked(
      admin
        .from("workspace_members")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("user_id", actorId)
        .single(),
      "find invoking member",
    ),
    checked(
      admin
        .from("pipelines")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("is_default", true)
        .single(),
      "find default pipeline",
    ),
  ]);
  const [stage, installation, connection] = await Promise.all([
    checked(
      admin
        .from("pipeline_stages")
        .select("id,slug,name")
        .eq("pipeline_id", pipeline.id)
        .order("position")
        .limit(1)
        .single(),
      "find first stage",
    ),
    checked(
      admin
        .from("github_installations")
        .insert({
          workspace_id: workspaceId,
          installation_id: randomInt(100_000_000, 2_000_000_000),
          installation_url: "https://github.com/settings/installations/1",
          app_id: 1,
          target_type: "Organization",
          target_name: slug,
          permissions: { contents: "write", pull_requests: "write" },
        })
        .select("id")
        .single(),
      "create fixture installation",
    ),
    checked(
      admin
        .from("workspace_e2b_sandbox_connections")
        .insert({
          workspace_id: workspaceId,
          encrypted_api_key: encryptSecretValue(HOSTED_SANDBOX_KEY),
        })
        .select("connection_revision")
        .single(),
      "save encrypted E2B connection",
    ),
  ]);
  async function repo(factoryId: string, name: string) {
    return checked(
      admin
        .from("github_repositories")
        .insert({
          workspace_id: workspaceId,
          factory_id: factoryId,
          github_installation_id: installation.id,
          repo_id: randomInt(100_000_000, 2_000_000_000),
          name,
          full_name: slug + "/" + name,
          private: true,
          html_url: "https://github.com/" + slug + "/" + name,
          default_branch: "main",
        })
        .select("id,full_name")
        .single(),
      "save scoped repository",
    );
  }
  const [repository, siblingRepository] = await Promise.all([
    repo(factory.id, "default"),
    repo(sibling.id, "sibling"),
    checked(
      admin.from("workspace_sandbox_settings").upsert({
        workspace_id: workspaceId,
        active_provider: provider,
      }),
      "select connected sandbox",
    ),
    checked(
      admin.from("workspace_agent_config").upsert([
        { workspace_id: workspaceId, key: "agent_provider", value_json: agent },
        { workspace_id: workspaceId, key: "agent_model", value_json: humanModel },
        { workspace_id: workspaceId, key: "max_retries", value_json: 0 },
      ]),
      "configure legacy agent",
    ),
    checked(
      admin.from("user_codex_credentials").insert({
        user_id: actorId,
        credential_type: "platform_api_key",
        encrypted_credential: encryptSecretValue(humanKey),
      }),
      "save human credential",
    ),
  ]);
  return {
    workspaceId,
    actorId,
    memberId: member.id,
    factoryId: factory.id,
    siblingId: sibling.id,
    stage,
    pipelineId: pipeline.id,
    installationId: installation.id,
    slug,
    repository,
    siblingRepository,
    connectionRevision: connection.connection_revision,
  };
}

type Workspace = Awaited<ReturnType<typeof seedWorkspace>>;

async function recordCapability(
  admin: Admin,
  workspace: Workspace,
  model: string,
  digest?: string,
) {
  const probes = getSandboxProviderContract(provider).capabilityProbes;
  await checked(
    admin.from("sandbox_capability_checks").insert({
      workspace_id: workspace.workspaceId,
      github_repository_id: workspace.repository.id,
      sandbox_provider: provider,
      sandbox_connection_revision: workspace.connectionRevision,
      agent_provider: agent,
      agent_model: model,
      factory_definition_digest: digest,
      status: "success",
      capabilities: Object.fromEntries(
        [...probes.required, ...probes.requiredByAgent[agent]].map((probe) => [
          probe,
          { ok: true, detail: null },
        ]),
      ),
    }),
    "record fixture sandbox capability receipt",
  );
}

function admissionArgs(workspace: Workspace, title: string) {
  return {
    target_workspace_id: workspace.workspaceId,
    creator_member_id: workspace.memberId,
    session_title: title,
    session_prompt_md: "Qualify this exact admission.",
    session_github_repository_id: workspace.repository.id,
    agent_model_provider: agent,
    agent_model_name: humanModel,
  };
}

async function admit(admin: Admin, workspace: Workspace, title: string): Promise<Job> {
  const [job] = await checked(
    admin.rpc("create_session_with_first_job", admissionArgs(workspace, title)),
    "admit " + title,
  );
  assert(job);
  return job;
}

async function seedAuthority(
  admin: Admin,
  workspace: Workspace,
  m05?: { contextRepositoryId: string; tools: BrowserTools },
) {
  const scope = {
    p_actor_user_id: workspace.actorId,
    p_workspace_id: workspace.workspaceId,
    p_factory_id: workspace.factoryId,
  };
  const [policy, principal, implementationAgent, siblingPrincipal] = await Promise.all([
    checked(
      admin.rpc("save_execution_policy", {
        p_workspace_id: workspace.workspaceId,
        p_actor_user_id: workspace.actorId,
        p_expected_revision: 0,
        p_requirements: {
          version: 1,
          maxRepairAttempts: m05 ? 1 : 0,
          maxExecutionMs: 120000,
          maxTotalTokens: 10000,
          // The synthetic Codex provider reports measured tokens and has no billed spend.
          maxCostUsd: m05 ? null : 5,
        },
      }),
      "save service budget",
    ),
    checked(
      admin.rpc("create_service_principal", {
        ...scope,
        p_name: "Qualified service",
        p_slug: "qualified-service",
      }),
      "save service principal",
    ),
    checked(
      admin
        .from("factory_agents")
        .select("id")
        .eq("workspace_id", workspace.workspaceId)
        .eq("factory_id", workspace.factoryId)
        .eq("is_default", true)
        .single(),
      "load implementation agent",
    ),
    checked(
      admin.rpc("create_service_principal", {
        ...scope,
        p_factory_id: workspace.siblingId,
        p_name: "Sibling service",
        p_slug: "sibling-service",
      }),
      "save sibling principal",
    ),
  ]);
  function approve(factoryId: string, principalId: string, repositoryId: string) {
    const qualificationScope = factoryId === workspace.factoryId ? m05 : undefined;
    return admin.rpc("approve_factory_execution_grant", {
      ...scope,
      p_factory_id: factoryId,
      p_service_principal_id: principalId,
      p_budget_payer_member_id: workspace.memberId,
      p_execution_policy_revision_id: policy.id,
      p_github_repository_id: repositoryId,
      p_expected_version: 0,
      p_expires_at: new Date(Date.now() + 600000).toISOString(),
      p_read_context_repository_ids: qualificationScope
        ? [qualificationScope.contextRepositoryId]
        : [],
      p_tool_ids: qualificationScope
        ? [qualificationScope.tools.screenshotScopeId, qualificationScope.tools.videoScopeId]
        : [],
    });
  }
  const [grant, siblingGrant, prompt, scopedSecret, siblingSecret, siblingAgent] =
    await Promise.all([
      checked(
        approve(workspace.factoryId, principal.id, workspace.repository.id),
        "approve service grant",
      ),
      checked(
        approve(workspace.siblingId, siblingPrincipal.id, workspace.siblingRepository.id),
        "approve sibling grant",
      ),
      checked(
        admin.rpc("save_factory_agent_prompt_revision", {
          ...scope,
          p_agent_id: implementationAgent.id,
          p_expected_revision_number: 1,
          p_prompt_md: "Initial fixture implementation instructions.",
        }),
        "save exact agent prompt revision",
      ),
      checked(
        admin
          .from("workspace_secrets")
          .insert({
            workspace_id: workspace.workspaceId,
            key: "RUNTIME_PROVIDER",
            encrypted_value: encryptSecretValue(serviceKey),
          })
          .select("id")
          .single(),
        "save scoped credential source",
      ),
      checked(
        admin
          .from("workspace_secrets")
          .insert({
            workspace_id: workspace.workspaceId,
            key: "SIBLING_PROVIDER",
            encrypted_value: encryptSecretValue(siblingKey),
          })
          .select("id")
          .single(),
        "save sibling credential source",
      ),
      checked(
        admin
          .from("factory_agents")
          .select("id")
          .eq("workspace_id", workspace.workspaceId)
          .eq("factory_id", workspace.siblingId)
          .eq("is_default", true)
          .single(),
        "load sibling implementation agent",
      ),
    ]);
  async function bind(grantRow: typeof grant, agentId: string, secretId: string) {
    return checked(
      admin.rpc("create_factory_secret_binding", {
        ...scope,
        p_factory_id: grantRow.factory_id,
        p_execution_grant_id: grantRow.id,
        p_execution_grant_version: grantRow.version,
        p_factory_agent_id: agentId,
        p_agent_provider: agent,
        p_workspace_secret_id: secretId,
      }),
      "bind scoped provider credential",
    );
  }
  const [binding, siblingBinding] = await Promise.all([
    bind(grant, implementationAgent.id, scopedSecret.id),
    bind(siblingGrant, siblingAgent.id, siblingSecret.id),
  ]);
  return { grant, binding, siblingBinding, principal, implementationAgent, prompt, policy };
}

type Authority = Awaited<ReturnType<typeof seedAuthority>>;

async function activate(
  admin: Admin,
  workspace: Workspace,
  authority: Authority,
  model: string,
  activation: number,
  m05?: { context: ContextRevision; tools: BrowserTools },
) {
  const bundle = compiledFactoryDefinitionSchema.parse({
    schemaVersion: 1,
    kind: "serial",
    sandboxProvider: provider,
    agent: {
      provider: agent,
      model,
      effort: "high",
      maxRetries: 0,
      concurrencyLimit: 1,
      stallTimeoutMs: 900000,
      maxTurns: 20,
    },
    pipelineId: workspace.pipelineId,
    repositoryId: workspace.repository.id,
    executionPolicyRevisionId: authority.policy.id,
    deliveryPolicyRevisionId: null,
    executionGrant: { id: authority.grant.id, version: authority.grant.version },
    credentialBindingId: authority.binding.id,
    implementationAgent: {
      agentId: authority.implementationAgent.id,
      promptRevisionId: authority.prompt.id,
      promptMd: authority.prompt.prompt_md,
      promptSha256: authority.prompt.prompt_sha256,
    },
    operatingRulesMd: "Fixture operating rules.",
    operatingRuleStageIds: [],
    skillIds: [],
    toolIds: m05 ? [m05.tools.screenshotScopeId, m05.tools.videoScopeId] : [],
    ...(m05
      ? {
          contextDocuments: [
            { sourceId: m05.context.sourceId, revisionId: m05.context.revisionId },
          ],
          mcpManifest: m05.tools.mcpManifest,
        }
      : {}),
    stages: [
      {
        ...workspace.stage,
        description: "",
        promptTemplateMd: "Pinned stage " + model + " for {{session.title}}.",
        approverMemberIds: [],
        anyoneCanApprove: true,
        previousStageIds: [],
      },
    ],
  });
  const { definitionJson, canonicalDigest } = serializeFactoryDefinition(bundle);
  const scope = {
    p_workspace_id: workspace.workspaceId,
    p_factory_id: workspace.factoryId,
    p_actor_user_id: workspace.actorId,
    p_expected_activation_number: activation - 1,
  };
  const probes = getSandboxProviderContract(provider).capabilityProbes;
  const requirements = {
    p_enabled_sandbox_providers: [provider],
    p_required_probes: [...probes.required, ...probes.requiredByAgent[agent]],
  };
  const draft = await checked(
    admin.rpc("save_factory_definition_draft", {
      ...scope,
      p_definition_json: definitionJson,
      p_canonical_digest: canonicalDigest,
    }),
    "save sealed fixture definition",
  );
  await recordCapability(admin, workspace, model, canonicalDigest);
  const smoke = await checked(
    admin.rpc("start_factory_definition_smoke_test", {
      ...scope,
      ...requirements,
      p_target_kind: "draft",
      p_target_id: draft.id,
      p_definition_digest: canonicalDigest,
    }),
    "reserve exact candidate receipt",
  );
  assert.equal(smoke.status, "running", smoke.error_text ?? undefined);
  const finished = await checked(
    admin.rpc("finish_factory_definition_smoke_test", {
      p_workspace_id: workspace.workspaceId,
      p_test_id: smoke.id,
      p_status: "passed",
      p_evidence: {
        runtimeProfile: provider,
        stageCount: 1,
        completedStageCount: 1,
        stages: [
          {
            stageId: workspace.stage.id,
            promptDigest: createHash("sha256").update(canonicalDigest).digest("hex"),
          },
        ],
      },
    }),
    "complete fixture candidate qualification",
  );
  assert(finished);
  const published = await checked(
    admin.rpc("publish_factory_definition_draft", {
      ...scope,
      ...requirements,
      p_draft_id: draft.id,
    }),
    "publish exact definition",
  );
  return { id: published.revision_id, canonicalDigest };
}

async function readRunEvidence(admin: Admin, job: Job) {
  const run = await checked(
    admin
      .from("agent_runs")
      .select(
        "id,attempt_count,model_name,status,sandbox_provider,agent_id,agent_prompt_revision_id",
      )
      .eq("id", job.run_id)
      .single(),
    "read exact run",
  );
  const receipt = await checked(
    admin
      .from("session_attempt_manifests")
      .select(
        "worker_runtime,definition_revision_id,definition_digest,model_name,agent_effort,sandbox_provider,credential_owner_member_id,repository_id,checkout_sha",
      )
      .eq("run_id", job.run_id)
      .eq("attempt_count", 1)
      .single(),
    "read exact attempt receipt",
  );
  const terminal = await checked(
    admin.from("agent_jobs").select("last_error,status").eq("id", job.job_id).single(),
    "read terminal job",
  );
  assert.equal(run.status, "error");
  assert.equal(run.attempt_count, 1);
  assert.equal(run.sandbox_provider, provider);
  assert.equal(terminal.status, "error");
  assert(
    terminal.last_error?.includes(FIXTURE_AGENT_EXIT),
    terminal.last_error ?? "No CLI outcome",
  );
  assert.equal(receipt.checkout_sha, BASE_SHA);
  return { run, receipt };
}

const browserPlan = {
  version: 2,
  commands: [
    {
      key: "qualification-command",
      command: QUALIFICATION_COMMAND,
      timeoutSeconds: 5,
      reports: [],
    },
  ],
  browser: [
    {
      key: "qualification",
      path: "/qualification",
      timeoutSeconds: 15,
      interactions: [{ action: "click", testId: "qualification-action" }],
      regionTestId: "qualification-region",
      excludedTestIds: ["private-canary"],
      evidence: [
        { kind: "screenshot", required: true },
        { kind: "video", required: true },
      ],
    },
  ],
} satisfies ValidationPlan;

async function readFrozenContext(admin: Admin, job: Job) {
  const row = await checked(
    admin
      .from("session_run_context_manifests")
      .select("origin_run_id,manifest_sha256,manifest")
      .eq("run_id", job.run_id)
      .eq("attempt_count", 1)
      .single(),
    "read immutable attempt context",
  );
  const manifest = runContextManifestSchema.parse(row.manifest);
  assert.equal(manifest.version, 2);
  return { ...row, manifest };
}

function assertSelectedContext(
  manifest: Awaited<ReturnType<typeof readFrozenContext>>["manifest"],
  revision: ContextRevision,
  memory: MemoryApproval,
) {
  assert.equal(manifest.documents.length, 1);
  const [document] = manifest.documents;
  assert(document.status === "selected");
  assert.equal(document.sourceId, revision.sourceId);
  assert.equal(document.revisionId, revision.revisionId);
  assert.equal(document.contentSha256, revision.contentSha256);
  assert.equal(document.upstreamRevision, revision.upstreamRevision);
  assert.equal(manifest.memories.length, 1);
  const [approval] = manifest.memories;
  assert(approval.status === "selected");
  assert.equal(approval.memoryId, memory.memoryId);
  assert.equal(approval.revisionId, memory.revisionId);
  assert.equal(approval.approvalId, memory.approvalId);
  assert.equal(approval.sha256, memory.contentSha256);
}

async function readMediaOutcome(
  admin: Admin,
  job: Job,
  runtime: QualificationInput["runtime"],
  mode: FixtureBrowserRun["mode"],
  originRunId: string,
) {
  const [run, evidence, planRow, receipt, assets] = await Promise.all([
    checked(
      admin.from("agent_runs").select("status").eq("id", job.run_id).single(),
      "read completed media run",
    ),
    checked(
      admin
        .from("session_validation_evidence")
        .select("attempt_count,commit_sha,validation_tree_sha,records")
        .eq("run_id", job.run_id)
        .single(),
      "read command evidence for media run",
    ),
    checked(
      admin
        .from("session_validation_plans")
        .select("run_id,attempt_count,commit_sha,validation_tree_sha,plan")
        .eq("run_id", job.run_id)
        .single(),
      "read the frozen browser validation plan",
    ),
    checked(
      admin
        .from("session_browser_verification_receipts")
        .select("records")
        .eq("run_id", job.run_id)
        .single(),
      "read exact browser receipt",
    ),
    checked(
      admin
        .from("session_browser_verification_assets")
        .select("id,sha256,content_type")
        .eq("run_id", job.run_id),
      "read exact browser assets",
    ),
  ]);
  assert.equal(run.status, "success");
  const identity = { runId: job.run_id, attemptCount: 1, commitSha: BASE_SHA, treeSha: TREE_SHA };
  assert.equal(evidence.attempt_count, identity.attemptCount);
  assert.equal(evidence.commit_sha, identity.commitSha);
  assert.equal(evidence.validation_tree_sha, identity.treeSha);
  const recordedIdentity = {
    runId: planRow.run_id,
    attemptCount: planRow.attempt_count,
    commitSha: planRow.commit_sha,
    treeSha: planRow.validation_tree_sha,
  };
  assert.deepEqual(recordedIdentity, identity);
  const validatedPlan = validationPlanSchema.parse(planRow.plan);
  assert.equal(validatedPlan.version, 2);
  assert.deepEqual(validatedPlan.browser, browserPlan.browser);
  assert(Array.isArray(evidence.records));
  assert(
    evidence.records.some(
      (record) =>
        record &&
        typeof record === "object" &&
        "key" in record &&
        record.key === "qualification-command" &&
        record.status === "passed",
    ),
  );
  const receipts = z.array(browserCaptureReceiptSchema).length(2).parse(receipt.records);
  const screenshot = receipts.find(({ kind }) => kind === "screenshot");
  const recording = receipts.find(({ kind }) => kind === "video");
  assert(screenshot?.kind === "screenshot" && recording?.kind === "video");
  const evidenceForRun = {
    expectedIdentity: identity,
    recordedIdentity,
    plan: validatedPlan.browser,
    receipts,
    accessibleAssetDigests: new Map(assets.map((asset) => [asset.id, asset.sha256])),
  };
  if (runtime === "workerd" || mode === "reject") {
    assert.deepEqual(assets, []);
    for (const item of receipts) {
      assert.equal(item.status, "unavailable");
      assert.equal(
        item.reason,
        runtime === "workerd" ? "runtime_unavailable" : "isolated_target_unavailable",
      );
      assert.equal(
        evaluateBrowserRequirement(`browser:${item.kind}:qualification`, evidenceForRun),
        "unavailable",
      );
    }
    return null;
  }
  assert.equal(screenshot.status, "captured");
  assert.equal(recording.status, "captured");
  assert.deepEqual(recording.manifest.frameOffsetsMs, [0, 500]);
  assert.equal(assets.length, 2);
  for (const item of [screenshot, recording]) {
    assert(
      assets.some(
        (asset) =>
          asset.id === item.manifest.assetId &&
          asset.sha256 === item.manifest.sha256 &&
          asset.content_type === item.manifest.contentType,
      ),
    );
    const requirement = `browser:${item.kind}:qualification`;
    assert.equal(evaluateBrowserRequirement(requirement, evidenceForRun), "passed");
    for (const expectedIdentity of [
      { ...identity, runId: originRunId },
      { ...identity, attemptCount: identity.attemptCount + 1 },
      { ...identity, commitSha: "0".repeat(40) },
      { ...identity, treeSha: "0".repeat(40) },
    ]) {
      assert.equal(
        evaluateBrowserRequirement(requirement, { ...evidenceForRun, expectedIdentity }),
        "stale",
      );
    }
  }
  return { identity, screenshot: screenshot.manifest, recording: recording.manifest };
}

async function qualifyM05(
  input: QualificationInput,
  workspace: Workspace,
  authority: Authority,
  repository: Awaited<ReturnType<typeof registerM05ContextRepository>>,
  tools: BrowserTools,
  owner: FactoryBrowserReviewFixture["owner"],
) {
  const { admin, viewer, transport, execute, runtime, m05 } = input;
  assert(m05);
  const { upstream } = m05;
  upstream.bind(repository);
  const sourceId = await registerM05ContextSource(admin, workspace, authority.grant, repository);
  const original = await syncM05ContextRevision(admin, workspace, sourceId, repository.old);
  await activate(admin, workspace, authority, pinnedModel, 3, { context: original, tools });

  const producer = await admit(admin, workspace, "Publish a reviewed memory proposal");
  transport.completeAttempt(producer.run_id, {
    artifact: "Qualification memory proposal source",
    memoryProposal: M05_ORIGINAL_MEMORY,
  });
  await execute(producer);
  const produced = await checked(
    admin.from("agent_jobs").select("status,last_error").eq("id", producer.job_id).single(),
    "read memory producer outcome",
  );
  assert.equal(
    produced.status,
    "success",
    produced.last_error ?? "The memory producer must publish.",
  );
  const priorApproval = await approveM05Memory(viewer, admin, workspace, producer.run_id);

  async function prepareRetry(title: string) {
    const job = await admit(admin, workspace, title);
    transport.failAttemptAfterUsage(job.run_id);
    await execute(job);
    await readRunEvidence(admin, job);
    const frozen = await readFrozenContext(admin, job);
    assertSelectedContext(frozen.manifest, original, priorApproval);
    const prompt = transport.invocations.at(-1)?.prompt;
    assert(prompt?.includes(M05_ORIGINAL_DOCUMENT.trim()) && prompt?.includes(M05_ORIGINAL_MEMORY));
    return job;
  }

  async function enqueueRetry(previous: Job): Promise<Job> {
    const [retry] = await checked(
      admin.rpc("enqueue_session_retry_with_checkpoint", {
        p_session_id: previous.session_id,
        p_workspace_id: workspace.workspaceId,
        p_expected_stage_id: workspace.stage.id,
        p_requested_by_member_id: workspace.memberId,
        p_retry_run_id: previous.run_id,
        p_agent_model_provider: agent,
        p_agent_model_name: pinnedModel,
        p_run_type: "code",
      }),
      "queue real manual retry",
    );
    assert(
      retry?.created && retry.run_id !== previous.run_id,
      `Manual retry did not create a new run (${JSON.stringify({ retry, previousRunId: previous.run_id })}).`,
    );
    return { ...retry, session_id: previous.session_id };
  }

  async function assertDeniedRetry(previous: Job, reason: RegExp) {
    const count = transport.invocations.length;
    const retry = await enqueueRetry(previous);
    await execute(retry);
    assert.equal(
      transport.invocations.length,
      count,
      "Ineligible frozen input must stop before agent launch.",
    );
    const terminal = await checked(
      admin.from("agent_jobs").select("status,last_error").eq("id", retry.job_id).single(),
      "read denied retry",
    );
    assert.equal(terminal.status, "error");
    assert.match(terminal.last_error ?? "", reason);
    const replacement = await checked(
      admin.from("session_run_context_manifests").select("run_id").eq("run_id", retry.run_id),
      "inspect denied attempt context",
    );
    assert.deepEqual(replacement, []);
  }

  function browserRun(job: Job, mode: FixtureBrowserRun["mode"]): FixtureBrowserRun {
    return {
      runId: job.run_id,
      commitSha: BASE_SHA,
      treeSha: TREE_SHA,
      screenshotScopeId: tools.screenshotScopeId,
      videoScopeId: tools.videoScopeId,
      mode,
    };
  }

  const origin = await prepareRetry("Replay frozen context with trusted browser evidence");
  const toRevoke = await prepareRetry("Reject replay after context access revocation");
  const toCorrect = await prepareRetry("Reject replay after a reviewed memory correction");
  assert(
    transport.sandboxes.every(({ stopped }) => stopped),
    "Replay starts after the original sandboxes have stopped.",
  );
  const originContext = await readFrozenContext(admin, origin);
  upstream.setHead(repository.new.commit);
  const updated = await syncM05ContextRevision(admin, workspace, sourceId, repository.new);
  assert.notEqual(original.contentSha256, updated.contentSha256);
  const retry = await enqueueRetry(origin);
  transport.completeAttempt(retry.run_id, {
    artifact: "Synthetic browser verification after retry",
    plan: browserPlan,
  });
  await execute(retry, browserRun(retry, "capture"));
  const replay = await readFrozenContext(admin, retry);
  assert.equal(replay.origin_run_id, origin.run_id);
  assert.equal(replay.manifest_sha256, originContext.manifest_sha256);
  assert.deepEqual(replay.manifest, originContext.manifest);
  const replayPrompt = transport.invocations.at(-1)?.prompt;
  assert(
    replayPrompt?.includes(M05_ORIGINAL_DOCUMENT.trim()) &&
      replayPrompt?.includes(M05_ORIGINAL_MEMORY),
  );
  assert(!replayPrompt?.includes(M05_UPDATED_DOCUMENT.trim()));
  const media = await readMediaOutcome(admin, retry, runtime, "capture", origin.run_id);

  upstream.setAccess("revoked");
  await assertDeniedRetry(toRevoke, /external document.*access_revoked/i);
  upstream.setAccess("available");
  const correction = await correctM05Memory(viewer, workspace, priorApproval, M05_UPDATED_MEMORY);
  assert.notEqual(correction.contentSha256, priorApproval.contentSha256);
  await assertDeniedRetry(toCorrect, /recorded factory memory.*no longer eligible/i);
  await activate(admin, workspace, authority, pinnedModel, 4, { context: updated, tools });

  const fresh = await admit(
    admin,
    workspace,
    "Use corrected memory and reject a malformed browser fixture",
  );
  transport.completeAttempt(fresh.run_id, {
    artifact: "Synthetic browser failure with valid command evidence",
    plan: browserPlan,
  });
  await execute(fresh, browserRun(fresh, "reject"));
  assertSelectedContext((await readFrozenContext(admin, fresh)).manifest, updated, correction);
  const freshPrompt = transport.invocations.at(-1)?.prompt;
  assert(
    freshPrompt?.includes(M05_UPDATED_DOCUMENT.trim()) && freshPrompt?.includes(M05_UPDATED_MEMORY),
  );
  assert(!freshPrompt?.includes(M05_ORIGINAL_MEMORY));
  await readMediaOutcome(admin, fresh, runtime, "reject", origin.run_id);

  upstream.setAccess("revoked");
  const freshRevoked = await admit(
    admin,
    workspace,
    "Omit inaccessible context from a fresh request",
  );
  await execute(freshRevoked);
  await readRunEvidence(admin, freshRevoked);
  const revokedManifest = (await readFrozenContext(admin, freshRevoked)).manifest;
  assert.deepEqual(revokedManifest.documents, [
    { sourceId, revisionId: updated.revisionId, status: "unavailable", reason: "access_revoked" },
  ]);
  assert.equal(revokedManifest.memories[0]?.revisionId, correction.revisionId);
  const revokedPrompt = transport.invocations.at(-1)?.prompt;
  assert(
    revokedPrompt?.includes(M05_UPDATED_MEMORY) &&
      !revokedPrompt.includes(M05_UPDATED_DOCUMENT.trim()),
  );

  const deletedSource = await checked(
    admin.rpc("delete_factory_context_source", {
      p_actor_user_id: workspace.actorId,
      p_factory_id: workspace.factoryId,
      p_workspace_id: workspace.workspaceId,
      p_source_id: sourceId,
    }),
    "delete the disposable context source",
  );
  assert(deletedSource.deleted_at);
  const afterDeletion = await admit(admin, workspace, "Omit deleted context from a fresh request");
  await execute(afterDeletion);
  await readRunEvidence(admin, afterDeletion);
  const deleted = (await readFrozenContext(admin, afterDeletion)).manifest;
  assert.deepEqual(deleted.documents, [
    {
      sourceId,
      revisionId: updated.revisionId,
      status: "unavailable",
      reason: "source_unavailable",
    },
  ]);
  assert.equal(deleted.memories[0]?.revisionId, correction.revisionId);
  assert((transport.invocations.at(-1)?.prompt ?? "").includes(M05_UPDATED_MEMORY));
  assert.deepEqual(await readFrozenContext(admin, origin), originContext);
  assert(
    transport.sandboxes.every(({ stopped }) => stopped),
    "Review starts after sandbox teardown.",
  );

  const inspection = runContextInspectionSchema.parse(
    await checked(
      viewer.rpc("get_run_context_inputs", {
        target_workspace_id: workspace.workspaceId,
        target_run_id: retry.run_id,
        target_attempt_count: 1,
      }),
      "review exact historical input after context erasure",
    ),
  );
  assert.equal(inspection.manifestSha256, originContext.manifest_sha256);
  assert.deepEqual(inspection.manifest, originContext.manifest);
  assert.equal(inspection.originRunId, origin.run_id);
  if (runtime === "node") {
    assert(media && m05.inspectReview);
    const accepted = await checked(
      admin
        .from("sessions")
        .select("number,current_artifact_id,phase_status")
        .eq("id", retry.session_id)
        .single(),
      "read reviewable media session after teardown",
    );
    assert.equal(accepted.phase_status, "awaiting_review");
    assert(accepted.current_artifact_id);
    const artifact = await checked(
      admin
        .from("session_artifacts")
        .select("id,stage_slug,version")
        .eq("id", accepted.current_artifact_id)
        .single(),
      "read exact accepted media artifact",
    );
    await m05.inspectReview({
      owner,
      workspaceId: workspace.workspaceId,
      workspaceSlug: workspace.slug,
      factoryId: workspace.factoryId,
      sessionId: retry.session_id,
      sessionNumber: accepted.number,
      artifact: { id: artifact.id, stageSlug: artifact.stage_slug, version: artifact.version },
      run: {
        id: retry.run_id,
        otherRunId: origin.run_id,
        commitSha: media.identity.commitSha,
        validationTreeSha: media.identity.treeSha,
      },
      screenshot: { id: media.screenshot.assetId, sha256: media.screenshot.sha256 },
      recording: { id: media.recording.assetId, sha256: media.recording.sha256, stepOffsetMs: 500 },
      context: { sourceId, revisionId: original.revisionId, sha256: original.contentSha256 },
      memory: {
        entryId: priorApproval.memoryId,
        approvedRevisionId: priorApproval.revisionId,
        sha256: priorApproval.contentSha256,
      },
    });
  }
}

export async function qualifyFactoryRuntime(input: QualificationInput) {
  const { admin, viewer, runtime, transport, execute, m05 } = input;
  // Both real claim RPCs select from the global queue.
  const queue = await admin
    .from("agent_jobs")
    .select("id", { head: true, count: "exact" })
    .in("status", ["queued", "running"]);
  assert(!queue.error, queue.error?.message);
  assert.equal(queue.count, 0, "Use the disposable factory runtime database with an empty queue.");
  const slug = "factory-runtime-" + runtime + "-" + randomUUID().slice(0, 8);
  const email = slug + "@example.test";
  const password = "local-fixture-" + randomUUID();
  const account = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (account.error) throw account.error;
  const actorId = account.data.user.id;
  let workspaceId: string | undefined;
  let workspaceMemberId: string | undefined;
  let restoreReleaseGate: (() => Promise<void>) | undefined;
  try {
    restoreReleaseGate = await openReleaseGate(admin);
    workspaceId = await createWorkspace(admin, actorId, slug);
    const workspace = await seedWorkspace(admin, workspaceId, actorId, slug);
    workspaceMemberId = workspace.memberId;
    const signedIn = await viewer.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw signedIn.error;
    await recordCapability(admin, workspace, humanModel);
    const legacy = await admit(admin, workspace, "Legacy default factory");
    await execute(legacy);
    const { receipt: legacyReceipt } = await readRunEvidence(admin, legacy);
    assert.equal(legacyReceipt.definition_revision_id, null);
    assert.equal(legacyReceipt.model_name, humanModel);
    assert.equal(legacyReceipt.credential_owner_member_id, workspace.memberId);
    assert.equal(legacyReceipt.worker_runtime, runtime);
    assert.equal(transport.invocations[0]?.secret === humanKey, true);
    assert.equal(transport.invocations[0]?.scoped, false);

    const contextRepository = m05
      ? await registerM05ContextRepository(admin, workspace)
      : undefined;
    const browserTools = m05 ? await registerM05BrowserTools(admin, workspace) : undefined;
    const authority = await seedAuthority(
      admin,
      workspace,
      contextRepository && browserTools
        ? { contextRepositoryId: contextRepository.id, tools: browserTools }
        : undefined,
    );
    const pinnedRevision = await activate(admin, workspace, authority, pinnedModel, 1);
    const wrongRepository = await admin.rpc("create_session_with_first_job", {
      ...admissionArgs(workspace, "Sibling repository must be rejected"),
      session_github_repository_id: workspace.siblingRepository.id,
    });
    assert.equal(wrongRepository.error?.code, "P0003");
    const wrongBinding = await checked(
      admin.rpc("check_factory_credential_binding", {
        p_workspace_id: workspace.workspaceId,
        p_factory_id: workspace.factoryId,
        p_binding_id: authority.siblingBinding.id,
        p_execution_grant_id: authority.grant.id,
        p_execution_grant_version: authority.grant.version,
        p_factory_agent_id: authority.implementationAgent.id,
        p_agent_provider: agent,
        p_agent_model: pinnedModel,
      }),
      "check sibling binding in the active factory",
    );
    assert.equal(wrongBinding, "missing");
    const pinned = await admit(admin, workspace, "Pinned service execution");
    const replacementPrompt = await checked(
      admin.rpc("save_factory_agent_prompt_revision", {
        p_actor_user_id: actorId,
        p_workspace_id: workspace.workspaceId,
        p_factory_id: workspace.factoryId,
        p_agent_id: authority.implementationAgent.id,
        p_expected_revision_number: authority.prompt.revision_number,
        p_prompt_md: "Replacement fixture implementation instructions.",
      }),
      "save replacement prompt revision",
    );
    const replacement = await activate(
      admin,
      workspace,
      { ...authority, prompt: replacementPrompt },
      replacementModel,
      2,
    );
    assert.notEqual(pinnedRevision.id, replacement.id);
    await execute(pinned);
    const { run, receipt } = await readRunEvidence(admin, pinned);
    assert.equal(run.agent_id, authority.implementationAgent.id);
    assert.equal(run.agent_prompt_revision_id, authority.prompt.id);
    assert.deepEqual(receipt, {
      worker_runtime: runtime,
      definition_revision_id: pinnedRevision.id,
      definition_digest: pinnedRevision.canonicalDigest,
      model_name: pinnedModel,
      agent_effort: "high",
      sandbox_provider: provider,
      credential_owner_member_id: null,
      repository_id: workspace.repository.id,
      checkout_sha: BASE_SHA,
    });
    const invocation = transport.invocations[1];
    assert(invocation);
    assert.equal(invocation.secret === serviceKey, true);
    assert.equal(invocation.scoped, true);
    assert.equal(invocation.repo, workspace.repository.full_name);
    assert(invocation.command.includes(pinnedModel));
    assert(!invocation.command.includes(replacementModel));
    assert(invocation.prompt.includes("Pinned stage " + pinnedModel));
    assert(invocation.prompt.includes("Pinned service execution"));
    assert(!invocation.prompt.includes("Pinned stage " + replacementModel));
    assert(invocation.prompt.startsWith(authority.prompt.prompt_md));
    assert(!invocation.prompt.includes(replacementPrompt.prompt_md));
    assert.equal(transport.scopedMaterial.size, 0);
    const profile = await checked(
      viewer.rpc("get_run_execution_profile", {
        target_workspace_id: workspace.workspaceId,
        target_run_id: pinned.run_id,
        target_attempt_count: 1,
      }),
      "read viewer-safe persisted profile",
    );
    assert(profile && typeof profile === "object" && !Array.isArray(profile));
    assert.equal(profile.definitionRevisionId, pinnedRevision.id);
    assert.equal(profile.workerRuntime, runtime);
    assert.equal(profile.model, pinnedModel);
    assert.equal(profile.factoryId, workspace.factoryId);
    assert.equal(profile.agentId, authority.implementationAgent.id);
    assert.equal(profile.promptRevisionId, authority.prompt.id);
    assert.equal(profile.invokingMemberId, workspace.memberId);
    assert.equal(profile.triggeredByMemberId, workspace.memberId);
    assert.equal(profile.sandboxConnectionRevision, workspace.connectionRevision);
    assert.deepEqual(profile.authority, {
      kind: "service",
      grantId: authority.grant.id,
      grantVersion: authority.grant.version,
      bindingId: authority.binding.id,
      servicePrincipalId: authority.principal.id,
    });

    assert.equal(transport.sandboxes.length, 2);
    assert.equal(transport.invocations.length, 2);
    if (contextRepository && browserTools) {
      await qualifyM05(input, workspace, authority, contextRepository, browserTools, {
        email,
        password,
      });
    }
    const priorSandboxCount = transport.sandboxes.length;
    const priorInvocationCount = transport.invocations.length;

    const revoked = await admit(admin, workspace, "Revoked before claim");
    await checked(
      admin.rpc("revoke_factory_execution_grant", {
        p_actor_user_id: actorId,
        p_workspace_id: workspace.workspaceId,
        p_factory_id: workspace.factoryId,
        p_grant_id: authority.grant.id,
        p_expected_version: authority.grant.version,
        p_reason: "Runtime qualification",
      }),
      "revoke queued job authority",
    );
    await execute(revoked);
    const denied = await checked(
      admin.from("agent_jobs").select("last_error,status").eq("id", revoked.job_id).single(),
      "read denied job",
    );
    assert.equal(denied.status, "error");
    assert.match(denied.last_error ?? "", /Execution grant is unavailable/);
    const credentialReceipts = admin
      .from("factory_run_credential_receipts")
      .select("run_id,binding_id")
      .eq("workspace_id", workspace.workspaceId);
    const [attempts, credentials] = await Promise.all([
      checked(
        admin
          .from("session_attempt_manifests")
          .select("run_id")
          .eq("session_id", revoked.session_id),
        "lookup denied manifests",
      ),
      checked(
        m05 ? credentialReceipts.in("run_id", [pinned.run_id, revoked.run_id]) : credentialReceipts,
        "lookup exact credential receipts",
      ),
    ]);
    assert.deepEqual(attempts, []);
    assert.deepEqual(credentials, [{ run_id: pinned.run_id, binding_id: authority.binding.id }]);
    assert.equal(transport.sandboxes.length, priorSandboxCount);
    assert.equal(transport.invocations.length, priorInvocationCount);
    assert(transport.sandboxes.every((sandbox) => sandbox.stopped));
    assert.equal(transport.scopedMaterial.size, 0);
  } finally {
    try {
      if (m05 && workspaceId && workspaceMemberId) {
        await checked(
          admin.rpc("begin_workspace_deletion", {
            p_workspace_id: workspaceId,
            p_owner_member_id: workspaceMemberId,
            p_confirmation: fixtureWorkspaceName,
          }),
          "fence disposable workspace and media cleanup",
        );
        assert(
          await resumeWorkspaceDeletion(admin, workspaceId),
          "Disposable media cleanup did not complete.",
        );
      } else if (workspaceId) {
        await checked(
          admin.from("workspaces").delete().eq("id", workspaceId),
          "delete fixture workspace",
        );
      }
    } finally {
      try {
        await deleteFixtureUser(admin, actorId);
      } finally {
        await restoreReleaseGate?.();
      }
    }
  }
}

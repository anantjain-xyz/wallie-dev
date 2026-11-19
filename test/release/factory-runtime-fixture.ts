import assert from "node:assert/strict";
import { createHash, randomInt, randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { compiledFactoryDefinitionSchema } from "@/lib/factory-definitions/schema";
import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import { getSandboxProviderContract } from "@/lib/sandbox/provider-contract";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import {
  BASE_SHA,
  FIXTURE_AGENT_EXIT,
  HOSTED_SANDBOX_KEY,
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
});

type Admin = SupabaseClient<Database>;
type Job = { job_id: string; run_id: string; session_id: string };

export function createFactoryRuntimeClients(rawFixture: string) {
  const config = fixtureSchema.parse(JSON.parse(rawFixture));
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  return {
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
      workspace_name: "Factory runtime qualification",
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

async function seedAuthority(admin: Admin, workspace: Workspace) {
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
          maxRepairAttempts: 0,
          maxExecutionMs: 120000,
          maxTotalTokens: 10000,
          maxCostUsd: 5,
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
    return admin.rpc("approve_factory_execution_grant", {
      ...scope,
      p_factory_id: factoryId,
      p_service_principal_id: principalId,
      p_budget_payer_member_id: workspace.memberId,
      p_execution_policy_revision_id: policy.id,
      p_github_repository_id: repositoryId,
      p_expected_version: 0,
      p_expires_at: new Date(Date.now() + 600000).toISOString(),
      p_read_context_repository_ids: [],
      p_tool_ids: [],
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
    toolIds: [],
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

export async function qualifyFactoryRuntime(input: {
  admin: Admin;
  viewer: Admin;
  runtime: "node" | "workerd";
  transport: FactoryRuntimeTransport;
  execute: (job: Job) => Promise<void>;
}) {
  const { admin, viewer, runtime, transport, execute } = input;
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
  let restoreReleaseGate: (() => Promise<void>) | undefined;
  try {
    restoreReleaseGate = await openReleaseGate(admin);
    workspaceId = await createWorkspace(admin, actorId, slug);
    const workspace = await seedWorkspace(admin, workspaceId, actorId, slug);
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

    const authority = await seedAuthority(admin, workspace);
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
    const [attempts, credentials] = await Promise.all([
      checked(
        admin
          .from("session_attempt_manifests")
          .select("run_id")
          .eq("session_id", revoked.session_id),
        "lookup denied manifests",
      ),
      checked(
        admin
          .from("factory_run_credential_receipts")
          .select("run_id,binding_id")
          .eq("workspace_id", workspace.workspaceId),
        "lookup exact credential receipts",
      ),
    ]);
    assert.deepEqual(attempts, []);
    assert.deepEqual(credentials, [{ run_id: pinned.run_id, binding_id: authority.binding.id }]);
    assert.equal(transport.sandboxes.length, 2);
    assert.equal(transport.invocations.length, 2);
    assert(transport.sandboxes.every((sandbox) => sandbox.stopped));
  } finally {
    try {
      if (workspaceId) {
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

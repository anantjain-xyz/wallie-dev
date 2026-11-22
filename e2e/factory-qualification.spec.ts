import { createHash, randomInt, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { RECOMMENDED_AGENT_EFFORT } from "@/lib/agent-config/contracts";
import { candidateSmokeStartSchema } from "@/lib/factory-definitions/candidate-smoke-contracts";
import {
  compiledFactoryDefinitionSchema,
  serialFactoryDefinitionSchema,
  type SerialFactoryDefinition,
} from "@/lib/factory-definitions/schema";
import { mcpOperationScopeId } from "@/lib/factory-mcp/manifest";
import { getSandboxProviderContract } from "@/lib/sandbox/provider-contract";
import type { Database } from "@/lib/supabase/database.types";

import { signInViaMagicLink } from "./helpers/auth";
import { openDropdownListbox } from "./helpers/select";

type Admin = SupabaseClient<Database>;
const provider = "e2b";
const firstModel = "gpt-5.5";
const secondModel = "gpt-5.6";
const toolOperation = "read_release";
const probes = getSandboxProviderContract(provider).capabilityProbes;
const requiredProbes = [...new Set([...probes.required, ...probes.requiredByAgent.codex])];
const agentRevisionResponseSchema = z.object({
  revision: z.object({
    id: z.string().uuid(),
    agent_id: z.string().uuid(),
    revision_number: z.number().int().positive(),
    prompt_md: z.string(),
  }),
});
const skillRevisionResponseSchema = z.object({
  revision: z.object({
    id: z.string().uuid(),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

function localUrl(value: string | undefined) {
  if (!value) throw new Error("Set the disposable local app and Supabase URLs.");
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Factory browser qualification requires loopback services.");
  }
  return url.origin;
}

async function checked<T>(
  operation: PromiseLike<{ data: T; error: unknown }>,
): Promise<NonNullable<T>> {
  const { data, error } = await operation;
  if (error) throw error;
  // PostgREST mutations without a select succeed with no response representation.
  return data as NonNullable<T>;
}

async function setupDraftWorkspace(admin: Admin, workspaceId: string, userId: string) {
  const repoNumber = randomInt(100_000_000, 1_000_000_000);
  const installation = await checked(
    admin
      .from("github_installations")
      .insert({
        workspace_id: workspaceId,
        installation_id: repoNumber,
        installation_url: "https://github.com/apps/factory-qualification/installations/1",
        app_id: 1,
        target_type: "Organization",
        target_name: "factory-qualification",
        permissions: { contents: "write", pull_requests: "write" },
      })
      .select("id")
      .single(),
  );
  const factory = await checked(
    admin
      .from("factories")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("is_default", true)
      .single(),
  );
  const repository = await checked(
    admin
      .from("github_repositories")
      .insert({
        workspace_id: workspaceId,
        factory_id: factory.id,
        github_installation_id: installation.id,
        repo_id: repoNumber,
        name: "fixture",
        full_name: "factory-qualification/fixture",
        private: true,
        html_url: "https://github.com/factory-qualification/fixture",
        default_branch: "main",
      })
      .select("id")
      .single(),
  );
  const connection = await checked(
    admin
      .from("workspace_e2b_sandbox_connections")
      .insert({ workspace_id: workspaceId, encrypted_api_key: "unused-local-fixture" })
      .select("connection_revision")
      .single(),
  );
  await Promise.all([
    checked(
      admin
        .from("workspace_sandbox_settings")
        .upsert({ workspace_id: workspaceId, active_provider: provider }),
    ),
    checked(
      admin.from("user_codex_credentials").insert({
        user_id: userId,
        credential_type: "codex_access_token",
        encrypted_credential: "unused-local-fixture",
      }),
    ),
    checked(
      admin
        .from("pipeline_stages")
        .update({ anyone_can_approve: true, prompt_template_md: "Review {{session.title}}." })
        .eq("workspace_id", workspaceId),
    ),
    checked(
      admin
        .from("workspace_onboarding")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          selected_github_repository_id: repository.id,
        })
        .eq("workspace_id", workspaceId),
    ),
  ]);
  return {
    factoryId: factory.id,
    repositoryId: repository.id,
    installationId: installation.id,
    connectionRevision: connection.connection_revision,
  };
}

async function substituteCandidateExecution({
  page,
  admin,
  workspaceId,
  factoryId,
  legacyDefault = false,
  userId,
  connectionRevision,
}: {
  page: Page;
  admin: Admin;
  workspaceId: string;
  factoryId: string;
  legacyDefault?: boolean;
  userId: string;
  connectionRevision: string;
}) {
  // Run the real reservation and receipt writes, substituting the hosted provider result.
  // The editor's eligibility, evidence reads, publish, rollback and admission stay real.
  const path = `factories/${factoryId}/definition`;
  await page.route(
    `**/api/workspaces/${workspaceId}/${legacyDefault ? `{factory-definition,${path}}` : path}/candidate-tests`,
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const command = candidateSmokeStartSchema.parse(route.request().postDataJSON());
      const table =
        command.target.kind === "draft"
          ? "factory_definition_drafts"
          : "factory_definition_revisions";
      const target = await checked(
        admin
          .from(table)
          .select("definition_json,canonical_digest")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .eq("id", command.target.id)
          .single(),
      );
      expect(target.canonical_digest).toBe(command.expectedDigest);
      const definition = compiledFactoryDefinitionSchema.parse(JSON.parse(target.definition_json));
      await checked(
        admin.from("sandbox_capability_checks").insert({
          workspace_id: workspaceId,
          github_repository_id: definition.repositoryId,
          sandbox_provider: provider,
          sandbox_connection_revision: connectionRevision,
          agent_provider: definition.agent.provider,
          agent_model: definition.agent.model,
          factory_definition_digest: command.expectedDigest,
          status: "success",
          capabilities: Object.fromEntries(
            requiredProbes.map((probe) => [probe, { ok: true, detail: null }]),
          ),
        }),
      );
      const reservation = await checked(
        admin.rpc("start_factory_definition_smoke_test", {
          p_workspace_id: workspaceId,
          p_factory_id: factoryId,
          p_actor_user_id: userId,
          p_expected_activation_number: command.expectedActivationNumber,
          p_target_kind: command.target.kind,
          p_target_id: command.target.id,
          p_definition_digest: command.expectedDigest,
          p_enabled_sandbox_providers: [provider],
          p_required_probes: requiredProbes,
        }),
      );
      expect(reservation.status, reservation.error_text ?? undefined).toBe("running");
      expect(
        await checked(
          admin.rpc("finish_factory_definition_smoke_test", {
            p_workspace_id: workspaceId,
            p_test_id: reservation.id,
            p_status: "passed",
            p_evidence: {
              runtimeProfile: provider,
              stageCount: definition.stages.length,
              completedStageCount: definition.stages.length,
              stages: definition.stages.map(({ id, promptTemplateMd }) => ({
                stageId: id,
                promptDigest: createHash("sha256").update(promptTemplateMd).digest("hex"),
              })),
            },
          }),
        ),
      ).toBe(true);
      const detail = new URL(`${route.request().url()}/${reservation.id}`);
      detail.search = new URLSearchParams({
        targetKind: command.target.kind,
        targetId: command.target.id,
        digest: command.expectedDigest,
      }).toString();
      const receipt = await page.request.get(detail.href);
      expect(receipt.ok()).toBe(true);
      await route.fulfill({ response: receipt, status: 202 });
    },
  );
}

async function fixtureRepository(
  admin: Admin,
  scope: {
    workspaceId: string;
    factoryId: string;
    installationId: string;
  },
  name: string,
) {
  return checked(
    admin
      .from("github_repositories")
      .insert({
        workspace_id: scope.workspaceId,
        factory_id: scope.factoryId,
        github_installation_id: scope.installationId,
        repo_id: randomInt(100_000_000, 1_000_000_000),
        name,
        full_name: `factory-qualification/${name}`,
        html_url: `https://github.com/factory-qualification/${name}`,
        private: true,
        default_branch: "main",
      })
      .select("id")
      .single(),
  );
}

async function registerTool(page: Page, api: string, slug: string) {
  const response = await page.request.post(`${api}/tools`, {
    data: {
      action: "register",
      name: slug,
      slug,
      endpoint: `https://fixture.example.test/${slug}`,
      operationNames: [toolOperation, "inspect_fixture"],
      authKind: "none",
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return z.object({ revision: z.object({ id: z.string().uuid() }) }).parse(await response.json())
    .revision.id;
}

async function setupServiceAuthority(
  admin: Admin,
  scope: {
    workspaceId: string;
    factoryId: string;
    actorId: string;
    memberId: string;
    agentId: string;
    writableId: string;
    contextId: string;
    toolId: string;
    policyId: string;
    slug: string;
  },
) {
  const actor = {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_actor_user_id: scope.actorId,
  };
  const principal = await checked(
    admin.rpc("create_service_principal", {
      ...actor,
      p_name: scope.slug,
      p_slug: scope.slug,
    }),
  );
  const grant = await checked(
    admin.rpc("approve_factory_execution_grant", {
      ...actor,
      p_service_principal_id: principal.id,
      p_github_repository_id: scope.writableId,
      p_read_context_repository_ids: [scope.contextId],
      p_tool_ids: [mcpOperationScopeId(scope.toolId, toolOperation)],
      p_execution_policy_revision_id: scope.policyId,
      p_budget_payer_member_id: scope.memberId,
      p_expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      p_expected_version: 0,
    }),
  );
  const ciphertext = `unused-${scope.slug}-fixture-ciphertext`;
  const secret = await checked(
    admin
      .from("workspace_secrets")
      .insert({
        workspace_id: scope.workspaceId,
        key: `MODEL_${scope.slug.replaceAll("-", "_").toUpperCase()}`,
        encrypted_value: ciphertext,
      })
      .select("id")
      .single(),
  );
  const binding = await checked(
    admin.rpc("create_factory_secret_binding", {
      ...actor,
      p_execution_grant_id: grant.id,
      p_execution_grant_version: grant.version,
      p_factory_agent_id: scope.agentId,
      p_agent_provider: "codex",
      p_workspace_secret_id: secret.id,
    }),
  );
  return {
    principalId: principal.id,
    bindingId: binding.id,
    ciphertext,
    grant: { id: grant.id, version: grant.version },
    definition: {
      repository: scope.writableId,
      readContextRepositories: [scope.contextId],
      executionPolicy: scope.policyId,
      executionGrant: { id: grant.id, version: grant.version },
      credentialBindingId: binding.id,
      mcpBindings: [{ toolRevisionId: scope.toolId, operations: [toolOperation] }],
    } satisfies Partial<SerialFactoryDefinition>,
  };
}

async function expectForeignBindingsRejected(
  page: Page,
  api: string,
  source: SerialFactoryDefinition,
  foreign: {
    repositoryId: string;
    contextId: string;
    skillId: string;
    toolId: string;
  },
  activationNumber: number,
) {
  const preview = await page.request.post(`${api}/definition/editor`, {
    data: {
      expectedActivationNumber: activationNumber,
      expectedDraftId: null,
      source: {
        kind: "structured",
        value: {
          ...source,
          repository: foreign.repositoryId,
          readContextRepositories: [foreign.contextId],
          skills: [foreign.skillId],
          mcpBindings: [{ toolRevisionId: foreign.toolId, operations: [toolOperation] }],
        },
      },
    },
  });
  expect(preview.status()).toBe(422);
  const { diagnostics } = z
    .object({
      diagnostics: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])) })),
    })
    .parse(await preview.json());
  expect(diagnostics.map(({ path }) => path[0])).toEqual(
    expect.arrayContaining(["repository", "readContextRepositories", "skills", "mcpBindings"]),
  );
}

async function editAndSave(
  page: Page,
  model: string,
  reorder: boolean,
  bindings?: Partial<Omit<SerialFactoryDefinition, "schemaVersion">>,
  beforeSave?: (source: SerialFactoryDefinition) => Promise<void>,
) {
  await page.getByRole("button", { name: "JSON source" }).click();
  const input = page.getByRole("textbox", { name: "Definition JSON" });
  const source = serialFactoryDefinitionSchema.parse(JSON.parse(await input.inputValue()));
  const stages = (reorder ? [...source.stages].reverse() : source.stages).map((stage) => ({
    ...stage,
    promptTemplateMd: `${model} ${stage.name} reviews {{session.title}}.`,
  }));
  const next = { ...source, ...bindings, agent: { ...source.agent, model }, stages };
  await beforeSave?.(next);
  await input.fill(JSON.stringify(next, null, 2));
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
  return stages[0]!;
}

async function startSession(page: Page, prompt: string, stageName: string) {
  await page.getByRole("button", { name: "New session" }).click();
  const dialog = page.getByRole("dialog", { name: "Start a new session" });
  await dialog.getByLabel("Prompt", { exact: true }).fill(prompt);
  const admission = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/sessions" &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Start session" }).click();
  const response = await admission;
  expect(response.status(), await response.text()).toBe(201);
  await expect(page).toHaveURL(/\/sessions\/\d+$/);
  await expect(page.getByRole("heading", { name: prompt, exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading session" })).toBeHidden();
  const stages = page.getByRole("navigation", { name: "Pipeline stages" });
  await expect(
    stages.getByRole("button", { name: `${stageName}: Queued`, exact: true }),
  ).toBeVisible();
}

async function expectSessionPin(
  admin: Admin,
  workspaceId: string,
  {
    title,
    revisionId,
    activationNumber,
    model,
    stageId,
    agentId,
    promptRevisionId,
    status = "queued",
  }: {
    title: string;
    revisionId: string;
    activationNumber: number;
    model: string;
    stageId: string;
    agentId: string;
    promptRevisionId: string;
    status?: "queued" | "running";
  },
) {
  const session = await checked(
    admin
      .from("sessions")
      .select("id,execute_pinned_definition,factory_definition_revision_id,current_stage_id")
      .eq("workspace_id", workspaceId)
      .eq("title", title)
      .single(),
  );
  expect(session).toMatchObject({
    execute_pinned_definition: true,
    factory_definition_revision_id: revisionId,
    current_stage_id: stageId,
  });
  const admission = await checked(
    admin
      .from("session_factory_admission_inputs")
      .select("activation_number,definition_revision_id")
      .eq("workspace_id", workspaceId)
      .eq("session_id", session.id)
      .single(),
  );
  expect(admission).toEqual({
    activation_number: activationNumber,
    definition_revision_id: revisionId,
  });
  const run = await checked(
    admin
      .from("agent_runs")
      .select("model_provider,model_name,stage_id,status,agent_id,agent_prompt_revision_id")
      .eq("workspace_id", workspaceId)
      .eq("session_id", session.id)
      .single(),
  );
  expect(run).toMatchObject({
    model_provider: "codex",
    model_name: model,
    stage_id: stageId,
    status,
    agent_id: agentId,
    agent_prompt_revision_id: promptRevisionId,
  });
}

async function recordSkillPromptManifest(
  admin: Admin,
  workspaceId: string,
  title: string,
  skillBody: string,
  connectionRevision: string,
  service?: { bindingId: string; principalId: string },
) {
  const session = await checked(
    admin
      .from("sessions")
      .select("id,current_stage_id,current_artifact_version,creator_member_id,github_repository_id")
      .eq("workspace_id", workspaceId)
      .eq("title", title)
      .single(),
  );
  if (!session.current_stage_id || !session.github_repository_id)
    throw new Error("The qualification session has no stage or repository.");
  const [release] = await checked(admin.rpc("get_git_continuity_release_state"));
  if (!release) throw new Error("The local release control is unavailable.");
  const [enabled] = release.enabled
    ? [release]
    : await checked(
        admin.rpc("set_git_continuity_release", {
          p_enabled: true,
          p_expected_revision: release.revision,
          p_reason: "Local skill revision inspector qualification",
        }),
      );
  if (!enabled?.enabled) throw new Error("The local release control did not enable dispatch.");

  try {
    const job = await checked(
      admin
        .from("agent_jobs")
        .update({
          status: "running",
          attempt_count: 1,
          git_continuity_release_revision: enabled.revision,
        })
        .eq("workspace_id", workspaceId)
        .eq("session_id", session.id)
        .eq("status", "queued")
        .select("id")
        .single(),
    );
    const runId = await checked(
      admin.rpc("start_session_job_attempt", {
        p_job_id: job.id,
        p_attempt_count: 1,
        p_expected_stage_id: session.current_stage_id,
        p_expected_artifact_version: session.current_artifact_version,
        p_model_provider: "codex",
        p_model_name: secondModel,
        p_run_type: "code",
        p_branch_name: "wallie/local-skill-inspector",
      }),
    );
    if (!runId) throw new Error("The qualification attempt did not start.");
    await checked(
      admin
        .from("agent_runs")
        .update({ sandbox_provider: provider, sandbox_connection_revision: connectionRevision })
        .eq("id", runId)
        .eq("workspace_id", workspaceId),
    );
    const checkoutSha = "a".repeat(40);
    const [input] = await checked(
      admin.rpc("pin_session_job_git_input", {
        p_job_id: job.id,
        p_attempt_count: 1,
        p_run_id: runId,
        p_repository_id: session.github_repository_id,
        p_base_branch: "main",
        p_observed_sha: checkoutSha,
      }),
    );
    expect(input?.input_sha).toBe(checkoutSha);

    // Browser proof uses the same durable RPC as a worker. Worker transport
    // and actual prompt materialization are exercised by the continuity fixture.
    const prompt = `Synthetic prompt supplied by the local qualification worker.\n\n${skillBody}`;
    expect(
      await checked(
        admin.rpc("pin_session_attempt_manifest", {
          p_job_id: job.id,
          p_run_id: runId,
          p_attempt_count: 1,
          p_prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
          p_prompt_utf8_bytes: Buffer.byteLength(prompt),
          p_renderer_version: 3,
          p_checkout_sha: checkoutSha,
          p_predecessors: [],
          p_worker_runtime: "node",
          p_agent_effort: RECOMMENDED_AGENT_EFFORT,
          ...(!service && session.creator_member_id
            ? { p_credential_owner_member_id: session.creator_member_id }
            : {}),
        }),
      ),
    ).toBe(true);
    if (service) {
      const receipts = await checked(
        admin.rpc("resolve_factory_run_credential", {
          p_workspace_id: workspaceId,
          p_job_id: job.id,
          p_run_id: runId,
          p_attempt_count: 1,
        }),
      );
      expect(
        receipts.map(({ binding_id, service_principal_id }) => ({
          bindingId: binding_id,
          principalId: service_principal_id,
        })),
      ).toEqual([service]);
    }
    return runId;
  } finally {
    if (!release.enabled) {
      await checked(
        admin.rpc("set_git_continuity_release", {
          p_enabled: false,
          p_expected_revision: enabled.revision,
          p_reason: "Restore local Git continuity release control",
        }),
      );
    }
  }
}

test("qualifies definition edit, test, publish, run admission and rollback", async ({
  browser,
  page,
  baseURL,
}, testInfo) => {
  test.skip(
    process.env.WALLIE_FACTORY_QUALIFICATION !== "1",
    "Requires a disposable local Supabase stack.",
  );
  test.setTimeout(150_000);
  const app = localUrl(baseURL);
  const supabase = localUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Export the disposable local Supabase keys.");
  }
  if (process.env.WALLIE_WORKER_WAKE_URL || process.env.OPENROUTER_API_KEY) {
    throw new Error("Disable external worker wake and title generation for this fixture.");
  }
  const admin = createClient<Database>(supabase, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const slug = `factory-qualification-${randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;
  const readerEmail = `${slug}-reader@example.test`;
  const account = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (account.error) throw account.error;
  const user = account.data.user;
  let workspaceId: string | undefined;
  let readerId: string | undefined;
  try {
    const workspace = await checked(
      admin.rpc("create_workspace", {
        actor_user_id: user.id,
        actor_email: email,
        requested_slug: slug,
        workspace_name: "Factory qualification",
      }),
    );
    workspaceId = workspace.id;
    const fixture = await setupDraftWorkspace(admin, workspace.id, user.id);
    const { connectionRevision } = fixture;
    const factory = { id: fixture.factoryId };
    await substituteCandidateExecution({
      page,
      admin,
      workspaceId: workspace.id,
      factoryId: factory.id,
      legacyDefault: true,
      userId: user.id,
      connectionRevision,
    });
    const editor = `/w/${workspace.slug}/settings/factory-definition`;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, editor, { baseURL: app, email });
    const factoryApi = `/api/workspaces/${workspace.id}/factories/${factory.id}`;
    const agentsPath = `${factoryApi}/agents`;
    const skillName = "Check release evidence";
    const skillBody = "Check the release notes against retained validation evidence.";
    const createSkill = await page.request.post(
      `/api/workspaces/${workspace.id}/factories/${factory.id}/skills`,
      { data: { name: skillName, slug: "check-release-evidence", contentMd: skillBody } },
    );
    expect(createSkill.status(), await createSkill.text()).toBe(201);
    const skillRevision = skillRevisionResponseSchema.parse(await createSkill.json()).revision;
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
    await page.getByLabel("Agent name", { exact: true }).fill("Implementation reviewer");
    await page.getByLabel("Identifier", { exact: true }).fill("implementation-reviewer");
    const agentPrompt = page.getByRole("textbox", { name: "Implementation prompt", exact: true });
    await agentPrompt.fill("Review the assigned stage. {{session.prompt}} stays literal.");
    const [createAgent] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url() === `${app}${agentsPath}` && response.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Create agent", exact: true }).click(),
    ]);
    expect(createAgent.status(), await createAgent.text()).toBe(201);
    const firstAgentPrompt = agentRevisionResponseSchema.parse(await createAgent.json()).revision;
    const agentPage = `/w/${workspace.slug}/agents/${firstAgentPrompt.agent_id}?factory=${factory.id}`;
    await expect(
      page.getByRole("heading", { name: "Prompt revision 1", exact: true }),
    ).toBeVisible();
    await expect(page.locator("pre")).toContainText(firstAgentPrompt.prompt_md);
    await page.getByRole("link", { name: "Configure bindings", exact: true }).click();
    const promptInput = page.getByRole("textbox", { name: "Implementation agent prompt revision" });
    await expect(promptInput).toHaveValue(firstAgentPrompt.id);
    const skillPicker = page.getByRole("combobox", { name: "Add a skill revision", exact: true });
    const skillListbox = await openDropdownListbox(skillPicker);
    const skillOption = skillListbox.getByRole("option", { name: `${skillName} · Revision 1` });
    await expect(skillOption).toHaveCount(1);
    await expect(skillOption).toHaveAttribute("data-value", skillRevision.id);
    await skillOption.click();
    await expect(page.getByRole("textbox", { name: "Skills", exact: true })).toHaveValue(
      skillRevision.id,
    );
    await page.getByRole("button", { name: "Validate and preview", exact: true }).click();
    await expect(
      page.getByText("Definition is valid. Review its semantic changes.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator("#semantic-diff").getByText(firstAgentPrompt.id, { exact: true }),
    ).toBeVisible();
    const capabilityPath = `/api/workspaces/${workspace.id}/factories/${factory.id}/definition/capability-check`;
    const [capabilityRead] = await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === capabilityPath && url.searchParams.has("draftId");
      }),
      page.getByRole("button", { name: "Save draft" }).click(),
    ]);
    expect(capabilityRead.ok()).toBe(true);
    await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
    await expect(promptInput).toHaveValue(firstAgentPrompt.id);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath("01-agent-prompt-binding-desktop-light.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: testInfo.outputPath("02-agent-prompt-binding-mobile-dark.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Switch to light mode", exact: true }).click();
    const publish = page.getByRole("button", { name: "Publish draft" });
    const draftTests = page.getByRole("region", { name: "Draft configuration tests" });
    const firstStage = await editAndSave(page, firstModel, false);
    await expect(publish).toBeDisabled();
    await draftTests.getByRole("button", { name: "Run configuration test" }).click();
    await expect(publish).toBeEnabled();
    await publish.click();
    await expect(page.getByText("Draft published for new sessions.")).toBeVisible();
    const activation = (number: number) =>
      checked(
        admin
          .from("factory_definition_activations")
          .select("revision_id")
          .eq("workspace_id", workspace.id)
          .eq("factory_id", factory.id)
          .eq("activation_number", number)
          .single(),
      );
    const original = (await activation(1)).revision_id;

    const owner = await checked(
      admin
        .from("workspace_members")
        .select("id")
        .eq("workspace_id", workspace.id)
        .eq("user_id", user.id)
        .single(),
    );
    const policy = await checked(
      admin.rpc("save_execution_policy", {
        p_workspace_id: workspace.id,
        p_actor_user_id: user.id,
        p_expected_revision: 0,
        p_requirements: {
          version: 1,
          maxRepairAttempts: 2,
          maxExecutionMs: 30_000,
          maxTotalTokens: 1000,
          maxCostUsd: 1,
        },
      }),
    );
    const sibling = await checked(
      admin.rpc("create_factory", {
        p_workspace_id: workspace.id,
        p_actor_user_id: user.id,
        p_name: "Private research",
        p_slug: "private-research",
      }),
    );
    const siblingApi = `/api/workspaces/${workspace.id}/factories/${sibling.id}`;
    const siblingScope = {
      workspaceId: workspace.id,
      factoryId: sibling.id,
      installationId: fixture.installationId,
    };
    const [context, siblingRepository, siblingContext, toolId, siblingToolId] = await Promise.all([
      fixtureRepository(admin, { workspaceId: workspace.id, ...fixture }, "release-context"),
      fixtureRepository(admin, siblingScope, "research-private"),
      fixtureRepository(admin, siblingScope, "research-context"),
      registerTool(page, factoryApi, "release-evidence"),
      registerTool(page, siblingApi, "research-tool"),
    ]);
    const siblingPipeline = await checked(
      admin
        .from("pipelines")
        .insert({
          workspace_id: workspace.id,
          factory_id: sibling.id,
          name: "Private research pipeline",
        })
        .select("id")
        .single(),
    );
    await checked(
      admin.from("pipeline_stages").insert({
        workspace_id: workspace.id,
        pipeline_id: siblingPipeline.id,
        name: "Research",
        slug: "research",
        position: 1,
        anyone_can_approve: true,
        prompt_template_md: "Review research scope.",
      }),
    );
    const siblingSkillResponse = await page.request.post(`${siblingApi}/skills`, {
      data: {
        name: "Private research skill",
        slug: "private-research-skill",
        contentMd: "Review private research evidence.",
      },
    });
    expect(siblingSkillResponse.status()).toBe(201);
    const siblingSkill = skillRevisionResponseSchema.parse(
      await siblingSkillResponse.json(),
    ).revision;
    const siblingAgentResponse = await page.request.post(`${siblingApi}/agents`, {
      data: {
        name: "Private research agent",
        slug: "private-research-agent",
        promptMd: "Summarize research evidence.",
      },
    });
    expect(siblingAgentResponse.status()).toBe(201);
    const siblingAgent = agentRevisionResponseSchema.parse(
      await siblingAgentResponse.json(),
    ).revision;
    const authorityScope = {
      workspaceId: workspace.id,
      actorId: user.id,
      memberId: owner.id,
      policyId: policy.id,
    };
    const [service, siblingService] = await Promise.all([
      setupServiceAuthority(admin, {
        ...authorityScope,
        factoryId: factory.id,
        writableId: fixture.repositoryId,
        contextId: context.id,
        agentId: firstAgentPrompt.agent_id,
        toolId,
        slug: "release-runner",
      }),
      setupServiceAuthority(admin, {
        ...authorityScope,
        factoryId: sibling.id,
        writableId: siblingRepository.id,
        contextId: siblingContext.id,
        agentId: siblingAgent.agent_id,
        toolId: siblingToolId,
        slug: "research-runner",
      }),
    ]);
    const siblingAgents = `/w/${workspace.slug}/agents?factory=${sibling.id}`;
    await page.goto(`/w/${workspace.slug}/agents?factory=${factory.id}`);
    const factoryPicker = page.getByRole("combobox", { name: "Factory", exact: true });
    await factoryPicker.click();
    const siblingOption = page
      .getByRole("listbox", { name: "Factory", exact: true })
      .getByRole("option", { name: sibling.name, exact: true });
    await expect(siblingOption).toHaveCount(1);
    await siblingOption.click();
    await expect(page).toHaveURL(`${app}${siblingAgents}`);
    await expect(
      page.getByRole("link", { name: "Implementation reviewer", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: "Private research agent", exact: true }).click();
    await page.getByRole("link", { name: "Configure bindings", exact: true }).click();
    await expect(promptInput).toHaveValue(siblingAgent.id, { timeout: 30_000 });
    await editAndSave(
      page,
      firstModel,
      false,
      { ...siblingService.definition, skills: [siblingSkill.id] },
      (source) =>
        expectForeignBindingsRejected(
          page,
          siblingApi,
          source,
          {
            repositoryId: fixture.repositoryId,
            contextId: context.id,
            skillId: skillRevision.id,
            toolId,
          },
          0,
        ),
    );
    await substituteCandidateExecution({
      page,
      admin,
      workspaceId: workspace.id,
      factoryId: sibling.id,
      userId: user.id,
      connectionRevision,
    });
    await draftTests.getByRole("button", { name: "Run configuration test" }).click();
    await expect(publish).toBeEnabled();
    await publish.click();
    await expect(page.getByText("Draft published for new sessions.")).toBeVisible();
    await page.goto(`/w/${workspace.slug}/agents/${siblingAgent.agent_id}?factory=${sibling.id}`);
    await expect(page.locator("#published-bindings")).toContainText("research-tool");
    await expect(page.locator("#published-bindings")).toContainText("research-context");
    await expect(page.locator("#published-bindings")).toContainText("Private research skill");
    await page.screenshot({
      path: testInfo.outputPath("12-research-factory-bindings.png"),
      fullPage: true,
    });

    await page.goto(agentPage);
    const published = page.locator("#published-bindings");
    await expect(published.getByText(firstModel, { exact: true })).toBeVisible();
    await expect(published.getByText(`${skillName} · v1`, { exact: true })).toBeVisible();
    await expect(
      published.getByText("factory-qualification/fixture", { exact: true }),
    ).toBeVisible();
    await expect(agentPrompt).toHaveValue(firstAgentPrompt.prompt_md);
    await agentPrompt.fill("Updated candidate instructions. {{attempt.feedback}} stays literal.");
    const revisionsPath = `${agentsPath}/${firstAgentPrompt.agent_id}/prompt-revisions`;
    const [savePrompt] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url() === `${app}${revisionsPath}` && response.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Save prompt revision", exact: true }).click(),
    ]);
    expect(savePrompt.status(), await savePrompt.text()).toBe(201);
    const secondAgentPrompt = agentRevisionResponseSchema.parse(await savePrompt.json()).revision;
    await expect(
      page.getByRole("heading", { name: "Prompt revision 2", exact: true }),
    ).toBeVisible();
    await expect(page.locator("pre")).toContainText(secondAgentPrompt.prompt_md);
    await expect(published.getByText(firstModel, { exact: true })).toBeVisible();
    await expect(published.getByRole("link", { name: "View published prompt" })).toHaveAttribute(
      "href",
      `${agentPage}&revision=${firstAgentPrompt.id}#prompt-revision`,
    );
    await page.getByRole("link", { name: "Configure bindings", exact: true }).click();
    await expect(promptInput).toHaveValue(secondAgentPrompt.id);
    await page.getByRole("button", { name: "Add tool binding", exact: true }).click();
    const toolRevisionInput = page.getByRole("combobox", { name: "Tool revision 1", exact: true });
    await expect(toolRevisionInput).toBeVisible();
    await toolRevisionInput.fill(toolId);
    await page
      .getByRole("textbox", { name: "Allowed operations", exact: true })
      .fill(toolOperation);
    const wrongBinding = await page.request.get(
      `${factoryApi}/secret-bindings?${new URLSearchParams({
        agentId: firstAgentPrompt.agent_id,
        grantId: service.grant.id,
        grantVersion: String(service.grant.version),
        bindingId: siblingService.bindingId,
        provider: "codex",
      })}`,
    );
    expect(wrongBinding.ok()).toBe(true);
    expect(await wrongBinding.json()).toMatchObject({ binding: null, grantMatches: true });
    expect(await wrongBinding.text()).not.toContain(siblingService.ciphertext);
    const secondStage = await editAndSave(page, secondModel, true, service.definition, (source) =>
      expectForeignBindingsRejected(
        page,
        factoryApi,
        source,
        {
          repositoryId: siblingRepository.id,
          contextId: siblingContext.id,
          skillId: siblingSkill.id,
          toolId: siblingToolId,
        },
        1,
      ),
    );
    expect(secondStage.id).not.toBe(firstStage.id);
    const effectiveProfile = page.locator("#execution-profile");
    await expect(effectiveProfile.getByText(secondModel, { exact: true })).toBeVisible();
    await expect(effectiveProfile.getByText("Service principal", { exact: true })).toBeVisible();
    await expect(publish).toBeDisabled();
    await draftTests.getByRole("button", { name: "Run configuration test" }).click();
    await expect(publish).toBeEnabled();
    await draftTests.getByRole("button", { name: /View evidence for test/ }).click();
    await expect(draftTests.getByRole("heading", { name: "Test evidence" })).toBeVisible();
    await expect(draftTests.getByText("2 of 2", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("01-candidate-tested.png"), fullPage: true });
    await publish.click();
    await expect(page.getByText("Draft published for new sessions.")).toBeVisible();
    const changed = (await activation(2)).revision_id;
    expect(changed).not.toBe(original);
    await expect(effectiveProfile.getByText("Ready", { exact: true })).toHaveCount(2);
    await effectiveProfile.screenshot({
      path: testInfo.outputPath("07-effective-execution-profile.png"),
    });

    const reader = await admin.auth.admin.createUser({ email: readerEmail, email_confirm: true });
    if (reader.error) throw reader.error;
    readerId = reader.data.user.id;
    const member = await checked(
      admin
        .from("workspace_members")
        .insert({
          workspace_id: workspace.id,
          user_id: readerId,
          email: readerEmail,
          role: "member",
          kind: "human",
        })
        .select("id")
        .single(),
    );
    await checked(
      admin.rpc("grant_factory_membership", {
        p_workspace_id: workspace.id,
        p_actor_user_id: user.id,
        p_factory_id: factory.id,
        p_member_id: member.id,
        p_role: "member",
      }),
    );
    const readerContext = await browser.newContext({
      baseURL: app,
      viewport: { width: 390, height: 844 },
      colorScheme: "dark",
    });
    try {
      const readerPage = await readerContext.newPage();
      await signInViaMagicLink(readerPage, agentPage, { baseURL: app, email: readerEmail });
      await expect(
        readerPage.getByRole("heading", { name: "Implementation reviewer", exact: true }),
      ).toBeVisible();
      const readerBindings = readerPage.locator("#published-bindings");
      await expect(readerBindings.getByText(secondModel, { exact: true })).toBeVisible();
      await expect(readerBindings.getByText(`${skillName} · v1`, { exact: true })).toBeVisible();
      await expect(readerBindings).toContainText("release-evidence · v1 · read_release");
      await expect(readerBindings).not.toContainText("inspect_fixture");
      await expect(readerPage.getByRole("link", { name: "Configure bindings" })).toHaveCount(0);
      await expect(readerPage.getByRole("link", { name: "Review readiness" })).toHaveCount(0);
      await expect(readerPage.getByRole("button", { name: "Save prompt revision" })).toHaveCount(0);
      await expect(readerPage.locator("main")).not.toContainText(service.ciphertext);
      await expect(readerPage.locator("main")).not.toContainText(siblingService.ciphertext);
      const denied = await readerPage.request.post(revisionsPath, {
        data: {
          expectedRevisionNumber: 2,
          promptMd: "This reader cannot update the prompt.",
        },
      });
      expect(denied.status()).toBe(403);
      if (await readerPage.getByRole("button", { name: "Switch to dark mode" }).isVisible()) {
        await readerPage.getByRole("button", { name: "Switch to dark mode" }).click();
      }
      await expect(readerPage.locator("html")).toHaveAttribute("data-theme", "dark");
      expect(
        await readerPage.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
      await readerPage.screenshot({
        path: testInfo.outputPath("11-agent-detail-mobile-dark.png"),
        fullPage: true,
      });
      await readerPage.goto(siblingAgents);
      await expect(readerPage.getByRole("heading", { name: "Factory unavailable" })).toBeVisible();
      await expect(readerPage.locator("main")).not.toContainText("Private research agent");
    } finally {
      await readerContext.close();
    }

    await page.goto(agentPage);
    await expect(published.getByText(secondModel, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Configure bindings" })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("10-agent-detail-desktop-light.png"),
      fullPage: true,
    });

    const title = "Qualify the new factory activation";
    await startSession(page, title, secondStage.name);
    await expectSessionPin(admin, workspace.id, {
      title,
      revisionId: changed,
      activationNumber: 2,
      model: secondModel,
      stageId: secondStage.id,
      agentId: firstAgentPrompt.agent_id,
      promptRevisionId: secondAgentPrompt.id,
    });
    await page.screenshot({ path: testInfo.outputPath("02-session-admitted.png"), fullPage: true });

    const inspectedRun = await recordSkillPromptManifest(
      admin,
      workspace.id,
      title,
      skillBody,
      connectionRevision,
      {
        bindingId: service.bindingId,
        principalId: service.principalId,
      },
    );
    const admitPin = await checked(
      admin
        .from("session_factory_admission_inputs")
        .select(
          "factory_id, github_repository_id, invoking_actor_member_id, credential_owner_service_principal_id, execution_grant_id, execution_grant_version",
        )
        .eq("workspace_id", workspace.id)
        .eq("definition_revision_id", changed)
        .single(),
    );
    expect(admitPin).toMatchObject({
      factory_id: factory.id,
      github_repository_id: fixture.repositoryId,
      invoking_actor_member_id: owner.id,
      credential_owner_service_principal_id: service.principalId,
      execution_grant_id: service.grant.id,
      execution_grant_version: service.grant.version,
    });
    const recordedDefinition = await checked(
      admin
        .from("factory_definition_revisions")
        .select("definition_json")
        .eq("workspace_id", workspace.id)
        .eq("factory_id", factory.id)
        .eq("id", changed)
        .single(),
    );
    expect(
      compiledFactoryDefinitionSchema.parse(JSON.parse(recordedDefinition.definition_json)),
    ).toMatchObject({
      readContextRepositoryIds: [context.id],
      skillIds: [skillRevision.id],
      toolIds: [mcpOperationScopeId(toolId, toolOperation)],
      credentialBindingId: service.bindingId,
    });
    const revoke = await page.request.post(`${factoryApi}/execution-grants`, {
      data: {
        action: "revoke",
        grantId: service.grant.id,
        expectedVersion: service.grant.version,
        reason: "Qualify retained authority after revocation",
      },
    });
    expect(revoke.status()).toBe(200);
    const blocked = await page.request.post("/api/sessions", {
      data: {
        workspaceId: workspace.id,
        requestId: randomUUID(),
        githubRepositoryId: fixture.repositoryId,
        title: "This session must not be admitted",
        promptMd: "Check the revoked execution grant.",
      },
    });
    expect(blocked.status()).toBe(422);
    expect(await blocked.text()).toMatch(/grant/i);

    await page.goto(editor);
    await page.getByRole("button", { name: /Activation #1,/ }).click();
    await expect(effectiveProfile.getByText(firstModel, { exact: true })).toBeVisible();
    const rollback = page.getByRole("button", { name: "Roll back to this revision" });
    await expect(rollback).toBeDisabled();
    await page
      .getByRole("region", { name: "Revision configuration tests" })
      .getByRole("button", { name: "Run configuration test" })
      .click();
    await expect(rollback).toBeEnabled();
    await rollback.click();
    const confirmation = page.getByRole("alertdialog", { name: "Activate this revision?" });
    await expect(confirmation.getByText("#2", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("03-tested-rollback.png"), fullPage: true });
    await confirmation.getByRole("button", { name: "Activate revision" }).click();
    await expect(page.getByText("Selected revision activated for new sessions.")).toBeVisible();
    expect((await activation(3)).revision_id).toBe(original);
    await expectSessionPin(admin, workspace.id, {
      title,
      revisionId: changed,
      activationNumber: 2,
      model: secondModel,
      stageId: secondStage.id,
      agentId: firstAgentPrompt.agent_id,
      promptRevisionId: secondAgentPrompt.id,
      status: "running",
    });

    const rolledBackTitle = "Qualify admission after rollback";
    await startSession(page, rolledBackTitle, firstStage.name);
    await expectSessionPin(admin, workspace.id, {
      title: rolledBackTitle,
      revisionId: original,
      activationNumber: 3,
      model: firstModel,
      stageId: firstStage.id,
      agentId: firstAgentPrompt.agent_id,
      promptRevisionId: firstAgentPrompt.id,
    });
    await page.screenshot({
      path: testInfo.outputPath("04-rollback-admitted.png"),
      fullPage: true,
    });

    await page.goto(`/w/${workspace.slug}/runs/${inspectedRun}`);
    const recordedProfile = page.locator("#execution-profile");
    await expect(
      recordedProfile.getByRole("heading", { name: "Recorded execution profile" }),
    ).toBeVisible();
    await expect(recordedProfile.getByText(secondModel, { exact: true })).toBeVisible();
    await expect(recordedProfile.getByText("Node.js", { exact: true })).toBeVisible();
    await expect(recordedProfile.getByText(connectionRevision, { exact: true })).toBeVisible();
    await expect(recordedProfile.getByText(changed, { exact: true })).toBeVisible();
    await expect(recordedProfile.getByText("E2B", { exact: true })).toBeVisible();
    await expect(recordedProfile.getByText("Implementation agent", { exact: true })).toBeVisible();
    await expect(
      recordedProfile.getByRole("link", { name: firstAgentPrompt.agent_id, exact: true }),
    ).toHaveAttribute("href", `${agentPage}&revision=${secondAgentPrompt.id}`);
    await expect(recordedProfile.getByText("Agent prompt revision", { exact: true })).toBeVisible();
    await expect(recordedProfile.getByText(secondAgentPrompt.id, { exact: true })).toBeVisible();
    await expect(recordedProfile.getByText("Invoking member", { exact: true })).toBeVisible();
    await expect(
      recordedProfile.getByRole("link", { name: owner.id, exact: true }),
    ).toHaveAttribute(
      "href",
      `/w/${workspace.slug}/activity?factory=${factory.id}&actor=${owner.id}`,
    );
    await expect(recordedProfile).toContainText(service.principalId);
    await expect(recordedProfile).toContainText(`${service.grant.id} · v${service.grant.version}`);
    await expect(recordedProfile).toContainText(`${service.bindingId} · v1`);
    await expect(page.getByRole("heading", { name: "Pinned MCP manifest" })).toBeVisible();
    await expect(page.getByText("release-evidence · Revision 1", { exact: true })).toBeVisible();
    await expect(page.getByText(toolOperation, { exact: true })).toBeVisible();
    await expect(page.locator("main")).not.toContainText("inspect_fixture");
    await expect(page.locator("main")).not.toContainText(service.ciphertext);
    await expect(page.locator("main")).not.toContainText(siblingService.ciphertext);
    await recordedProfile.screenshot({
      path: testInfo.outputPath("08-recorded-execution-profile.png"),
    });
    await expect(page.getByRole("heading", { name: "Skill revisions" })).toBeVisible();
    await expect(page.getByRole("heading", { name: skillName })).toBeVisible();
    await expect(page.getByText("Revision 1 · Factory-authored", { exact: true })).toBeVisible();
    await expect(page.getByText(skillRevision.id, { exact: true })).toBeVisible();
    await expect(page.getByText(skillRevision.content_sha256, { exact: true })).toBeVisible();
    await expect(page.getByText(skillBody, { exact: true })).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("05-run-skill-revision-desktop-light.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: testInfo.outputPath("06-run-skill-revision-mobile-dark.png"),
      fullPage: true,
    });
    await recordedProfile.screenshot({
      path: testInfo.outputPath("09-recorded-execution-profile-mobile-dark.png"),
    });
  } finally {
    if (workspaceId) await checked(admin.from("workspaces").delete().eq("id", workspaceId));
    const deleted = await admin.auth.admin.deleteUser(user.id);
    if (deleted.error) throw deleted.error;
    if (readerId) {
      const deletedReader = await admin.auth.admin.deleteUser(readerId);
      if (deletedReader.error) throw deletedReader.error;
    }
  }
});

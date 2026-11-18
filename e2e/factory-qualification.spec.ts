import { createHash, randomInt, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { candidateSmokeStartSchema } from "@/lib/factory-definitions/candidate-smoke-contracts";
import {
  compiledFactoryDefinitionSchema,
  serialFactoryDefinitionSchema,
} from "@/lib/factory-definitions/schema";
import { getSandboxProviderContract } from "@/lib/sandbox/provider-contract";
import type { Database } from "@/lib/supabase/database.types";

import { signInViaMagicLink } from "./helpers/auth";

type Admin = SupabaseClient<Database>;
const provider = "e2b";
const firstModel = "gpt-5.5";
const secondModel = "gpt-5.6";
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
  return connection.connection_revision;
}

async function substituteCandidateExecution({
  page,
  admin,
  workspaceId,
  userId,
  connectionRevision,
}: {
  page: Page;
  admin: Admin;
  workspaceId: string;
  userId: string;
  connectionRevision: string;
}) {
  const factory = await checked(
    admin.from("factories").select("id").eq("workspace_id", workspaceId).single(),
  );
  // Run the real reservation and receipt writes, substituting the hosted provider result.
  // The editor's eligibility, evidence reads, publish, rollback and admission stay real.
  await page.route(
    `**/api/workspaces/${workspaceId}/factory-definition/candidate-tests`,
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
          p_factory_id: factory.id,
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

async function editAndSave(page: Page, model: string, reorder: boolean) {
  await page.getByRole("button", { name: "JSON source" }).click();
  const input = page.getByRole("textbox", { name: "Definition JSON" });
  const source = serialFactoryDefinitionSchema.parse(JSON.parse(await input.inputValue()));
  const stages = (reorder ? [...source.stages].reverse() : source.stages).map((stage) => ({
    ...stage,
    promptTemplateMd: `${model} ${stage.name} reviews {{session.title}}.`,
  }));
  await input.fill(
    JSON.stringify({ ...source, agent: { ...source.agent, model }, stages }, null, 2),
  );
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
  }: {
    title: string;
    revisionId: string;
    activationNumber: number;
    model: string;
    stageId: string;
    agentId: string;
    promptRevisionId: string;
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
    status: "queued",
    agent_id: agentId,
    agent_prompt_revision_id: promptRevisionId,
  });
}

async function recordSkillPromptManifest(
  admin: Admin,
  workspaceId: string,
  title: string,
  skillBody: string,
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
          ...(session.creator_member_id
            ? { p_credential_owner_member_id: session.creator_member_id }
            : {}),
        }),
      ),
    ).toBe(true);
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
  page,
  baseURL,
}, testInfo) => {
  test.skip(
    process.env.WALLIE_FACTORY_QUALIFICATION !== "1",
    "Requires a disposable local Supabase stack.",
  );
  test.setTimeout(120_000);
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
  const account = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (account.error) throw account.error;
  const user = account.data.user;
  let workspaceId: string | undefined;
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
    const connectionRevision = await setupDraftWorkspace(admin, workspace.id, user.id);
    await substituteCandidateExecution({
      page,
      admin,
      workspaceId: workspace.id,
      userId: user.id,
      connectionRevision,
    });
    const editor = `/w/${workspace.slug}/settings/factory-definition`;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, editor, { baseURL: app, email });
    const factory = await checked(
      admin.from("factories").select("id").eq("workspace_id", workspace.id).single(),
    );
    const agentsPath = `/api/workspaces/${workspace.id}/factories/${factory.id}/agents`;
    const skillName = "Check release evidence";
    const skillBody = "Check the release notes against retained validation evidence.";
    const createSkill = await page.request.post(
      `/api/workspaces/${workspace.id}/factories/${factory.id}/skills`,
      { data: { name: skillName, slug: "check-release-evidence", contentMd: skillBody } },
    );
    expect(createSkill.status(), await createSkill.text()).toBe(201);
    const skillRevision = skillRevisionResponseSchema.parse(await createSkill.json()).revision;
    const createAgent = await page.request.post(agentsPath, {
      data: {
        name: "Implementation reviewer",
        slug: "implementation-reviewer",
        promptMd: "Review the assigned stage. {{session.prompt}} stays literal.",
      },
    });
    expect(createAgent.status(), await createAgent.text()).toBe(201);
    const firstAgentPrompt = agentRevisionResponseSchema.parse(await createAgent.json()).revision;
    const promptInput = page.getByRole("textbox", { name: "Implementation agent prompt revision" });
    await promptInput.fill(firstAgentPrompt.id);
    await page.getByRole("textbox", { name: "Skills", exact: true }).fill(skillRevision.id);
    await page.getByRole("button", { name: "Save draft" }).click();
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
          .eq("activation_number", number)
          .single(),
      );
    const original = (await activation(1)).revision_id;

    const savePrompt = await page.request.post(
      `${agentsPath}/${firstAgentPrompt.agent_id}/prompt-revisions`,
      {
        data: {
          expectedRevisionNumber: firstAgentPrompt.revision_number,
          promptMd: "Updated candidate instructions. {{attempt.feedback}} stays literal.",
        },
      },
    );
    expect(savePrompt.status(), await savePrompt.text()).toBe(201);
    const secondAgentPrompt = agentRevisionResponseSchema.parse(await savePrompt.json()).revision;
    await page.getByRole("button", { name: "Structured", exact: true }).click();
    await expect(promptInput).toHaveValue(firstAgentPrompt.id);
    await promptInput.fill(secondAgentPrompt.id);
    const secondStage = await editAndSave(page, secondModel, true);
    expect(secondStage.id).not.toBe(firstStage.id);
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

    await page.goto(editor);
    await page.getByRole("button", { name: /Activation #1,/ }).click();
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

    const inspectedRun = await recordSkillPromptManifest(admin, workspace.id, title, skillBody);
    await page.goto(`/w/${workspace.slug}/runs/${inspectedRun}`);
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
  } finally {
    if (workspaceId) await checked(admin.from("workspaces").delete().eq("id", workspaceId));
    const deleted = await admin.auth.admin.deleteUser(user.id);
    if (deleted.error) throw deleted.error;
  }
});

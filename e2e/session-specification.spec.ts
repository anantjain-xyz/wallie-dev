import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import { workspaceInboxPath, workspaceSessionDetailPath } from "@/lib/routes";
import { getSandboxProviderContract } from "@/lib/sandbox/provider-contract";
import {
  sessionSpecificationStateSchema,
  specificationAnswerReceiptSchema,
  type SpecificationAnswer,
} from "@/lib/sessions/specification-contracts";
import type { Database } from "@/lib/supabase/database.types";

import { signInViaMagicLink } from "./helpers/auth";
import {
  acceptanceCriterion,
  acceptedScopeArtifact,
  childTask,
  childTitle,
  configureTriageGraph,
  dispatchFixtureForeman,
  freezeFixtureContext,
  readFixtureChildScope,
  seedTriageAuthority,
} from "./helpers/triage-fixture";

type Admin = SupabaseClient<Database>;
const fixtureExec = promisify(execFile);
const fixtureSha = "a".repeat(40);
const model = "gpt-5.5";
const specificationAgent = "Scope reviewer";
const title = "Draft a rollout specification";
const userPrompt = "Specify how the invite flow should roll out.";
const question = "Which group should receive the first invitations?";
const answer = "Start with workspace administrators, then invite the pilot group.";
const draft = "Restrict the first rollout to an identified group.";
const revision = "Start with workspace administrators and expand to the pilot group.";
const triageMode = process.env.WALLIE_TRIAGE_E2E === "1";

test.use({ screenshot: "off", trace: "off" });

function localUrl(value: string | undefined, protocol: "http:" | "postgresql:") {
  if (!value) throw new Error("Set the disposable app, Supabase, and database URLs.");
  const url = new URL(value);
  if (url.protocol !== protocol || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Specification qualification requires loopback services.");
  }
  return url;
}

async function row<T>(operation: PromiseLike<{ data: T; error: unknown }>) {
  const { data, error } = await operation;
  if (error) throw error;
  if (data === null) throw new Error("Specification fixture row is missing.");
  return data;
}

async function checked(operation: PromiseLike<{ error: unknown }>) {
  const { error } = await operation;
  if (error) throw error;
}

async function seedDefinition(
  admin: Admin,
  database: URL,
  workspaceId: string,
  factoryId: string,
  userId: string,
) {
  const installationNumber = randomInt(100_000_000, 1_000_000_000);
  const installation = await row(
    admin
      .from("github_installations")
      .insert({
        workspace_id: workspaceId,
        installation_id: installationNumber,
        installation_url: "https://example.test/installation",
        app_id: 1,
        target_type: "Organization",
        target_name: "specification-proof",
        permissions: { contents: "write", pull_requests: "write" },
      })
      .select("id")
      .single(),
  );
  const repository = await row(
    admin
      .from("github_repositories")
      .insert({
        workspace_id: workspaceId,
        factory_id: factoryId,
        github_installation_id: installation.id,
        repo_id: installationNumber,
        name: "invites",
        full_name: "proof/invites",
        private: true,
        html_url: "https://example.test/proof/invites",
        default_branch: "main",
      })
      .select("id")
      .single(),
  );
  const pipeline = await row(
    admin
      .from("pipelines")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("is_default", true)
      .single(),
  );
  const existingStages = await row(
    admin
      .from("pipeline_stages")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("pipeline_id", pipeline.id)
      .is("archived_at", null)
      .order("position"),
  );
  const stageNames = [
    { name: "Shape request", slug: "shape-request", description: "Scope the rollout." },
    {
      name: "Deliver output",
      slug: "deliver-output",
      description: "Implement the confirmed scope.",
    },
  ];
  const stages = await Promise.all(
    stageNames.map(async (stage, index) => {
      const prior = existingStages[index];
      const fields = {
        ...stage,
        anyone_can_approve: true,
        prompt_template_md: "Address {{session.prompt}}.",
      };
      const query = prior
        ? admin.from("pipeline_stages").update(fields).eq("id", prior.id)
        : admin.from("pipeline_stages").insert({
            ...fields,
            pipeline_id: pipeline.id,
            workspace_id: workspaceId,
            position: index + 1,
          });
      const saved = await row(query.select("id").single());
      return {
        ...stage,
        id: saved.id,
        anyoneCanApprove: true,
        approverMemberIds: [],
        promptTemplateMd: fields.prompt_template_md,
        previousStageIds: [],
      };
    }),
  );
  const agent = await row(
    admin.rpc("create_factory_agent", {
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_actor_user_id: userId,
      p_name: specificationAgent,
      p_slug: "scope-reviewer",
      p_prompt_md: "Draft a precise, reviewable specification.",
    }),
  );
  await Promise.all([
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
    checked(
      admin.from("user_codex_credentials").insert({
        user_id: userId,
        credential_type: "codex_access_token",
        encrypted_credential: "unused-local-fixture",
      }),
    ),
  ]);
  const triageAuthority = triageMode
    ? await seedTriageAuthority(admin, {
        workspaceId,
        factoryId,
        userId,
        repositoryId: repository.id,
        agentId: agent.agent_id,
      })
    : null;
  const { definitionJson, canonicalDigest } = serializeFactoryDefinition({
    schemaVersion: 1,
    kind: "serial",
    sandboxProvider: "e2b",
    agent: {
      provider: "codex",
      model,
      effort: null,
      concurrencyLimit: 1,
      stallTimeoutMs: 300_000,
      maxRetries: 1,
      maxTurns: 10,
    },
    implementationAgent: {
      agentId: agent.agent_id,
      promptRevisionId: agent.id,
      promptMd: agent.prompt_md,
      promptSha256: agent.prompt_sha256,
    },
    pipelineId: pipeline.id,
    repositoryId: repository.id,
    executionPolicyRevisionId: triageAuthority?.policyId ?? null,
    ...(triageAuthority
      ? {
          executionGrant: triageAuthority.executionGrant,
          credentialBindingId: triageAuthority.credentialBindingId,
        }
      : {}),
    deliveryPolicyRevisionId: null,
    skillIds: [],
    toolIds: [],
    operatingRulesMd: "",
    operatingRuleStageIds: [],
    stages: triageAuthority ? stages.slice(0, 1) : stages,
  });
  const connection = await row(
    admin
      .from("workspace_e2b_sandbox_connections")
      .insert({ workspace_id: workspaceId, encrypted_api_key: "unused-local-fixture" })
      .select("connection_revision")
      .single(),
  );
  const probes = getSandboxProviderContract("e2b").capabilityProbes;
  await checked(
    admin.from("sandbox_capability_checks").insert({
      workspace_id: workspaceId,
      github_repository_id: repository.id,
      sandbox_provider: "e2b",
      sandbox_connection_revision: connection.connection_revision,
      agent_provider: "codex",
      agent_model: model,
      factory_definition_digest: canonicalDigest,
      status: "success",
      capabilities: Object.fromEntries(
        [...new Set([...probes.required, ...probes.requiredByAgent.codex])].map((probe) => [
          probe,
          { ok: true, detail: null },
        ]),
      ),
    }),
  );
  const revisionId = randomUUID();
  const encoded = Buffer.from(definitionJson, "utf8").toString("base64");
  // The fixture provisions a local, immutable activation without external smoke credentials.
  await fixtureExec(
    "psql",
    [
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      database.hostname,
      "-p",
      database.port,
      "-U",
      decodeURIComponent(database.username),
      "-d",
      database.pathname.slice(1),
      "-c",
      `begin;
       insert into public.factory_definition_revisions
         (id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by)
       values ('${revisionId}', '${workspaceId}', '${factoryId}', 1,
         convert_from(decode('${encoded}', 'base64'), 'UTF8'), '${canonicalDigest}', '${userId}');
       insert into public.factory_definition_activations
         (workspace_id, factory_id, revision_id, activation_number, created_by)
       values ('${workspaceId}', '${factoryId}', '${revisionId}', 1, '${userId}');
       commit;`,
    ],
    { env: { ...process.env, PGPASSWORD: decodeURIComponent(database.password) } },
  );
  const triageGraph = triageAuthority
    ? await configureTriageGraph(admin, {
        workspaceId,
        factoryId,
        userId,
        stageId: stages[0].id,
        definitionRevisionId: revisionId,
        definitionDigest: canonicalDigest,
        promptRevisionId: agent.id,
        grant: triageAuthority.executionGrant,
      })
    : null;
  return { repositoryId: repository.id, stages, agent, triageGraph };
}

async function publish(
  admin: Admin,
  input: {
    jobId: string;
    sessionId: string;
    stageId: string;
    expectedVersion: number;
    repositoryId: string;
    releaseRevision: number;
    markdown: string;
    freezeWorkspaceId?: string;
    prepareResult?: (runId: string) => Promise<string>;
  },
) {
  // Simulate claiming only this test's queued job. The exact start, input pin,
  // checkpoint preparation, publication claim and adoption RPCs stay real.
  await checked(
    admin
      .from("agent_jobs")
      .update({
        status: "running",
        attempt_count: 1,
        git_continuity_release_revision: input.releaseRevision,
        claimed_worker_runtime: "node",
      })
      .eq("id", input.jobId)
      .eq("session_id", input.sessionId),
  );
  const runId = await row(
    admin.rpc("start_session_job_attempt", {
      p_job_id: input.jobId,
      p_attempt_count: 1,
      p_expected_stage_id: input.stageId,
      p_expected_artifact_version: input.expectedVersion,
      p_model_provider: "codex",
      p_model_name: model,
      p_run_type: "project",
      p_branch_name: `wallie/specification-${input.jobId}`,
    }),
  );
  await row(
    admin
      .rpc("pin_session_job_git_input", {
        p_job_id: input.jobId,
        p_attempt_count: 1,
        p_run_id: runId,
        p_repository_id: input.repositoryId,
        p_base_branch: "main",
        p_observed_sha: fixtureSha,
      })
      .single(),
  );
  if (input.freezeWorkspaceId) {
    await freezeFixtureContext(
      admin,
      { jobId: input.jobId, runId, workspaceId: input.freezeWorkspaceId },
      [{ key: "session/prompt", body: userPrompt }],
    );
  }
  const markdown = input.prepareResult ? await input.prepareResult(runId) : input.markdown;
  expect(
    await row(
      admin.rpc("prepare_session_source_and_checkpoint_publication", {
        p_run_id: runId,
        p_repository_id: input.repositoryId,
        p_base_branch: "main",
        p_base_sha: fixtureSha,
        p_head_sha: fixtureSha,
        p_title: title,
        p_body: markdown,
        p_checkpoint_path: "",
        p_bundle_sha256: "",
        p_bundle_base64: "",
        p_expected_artifact_version: input.expectedVersion,
        p_artifact_md: markdown,
      }),
    ),
  ).toBe(true);
  const claim = await row(admin.rpc("claim_session_checkpoint_publication", { p_run_id: runId }));
  expect(
    await row(
      admin.rpc("adopt_session_checkpoint_publication", { p_run_id: runId, p_claim_id: claim }),
    ),
  ).toBe(true);
  return runId;
}

function exactReviewPath(
  workspaceSlug: string,
  sessionNumber: number,
  stage: { id: string; slug: string },
  target: { artifactId: string; artifactVersion: number; reviewRevision: number },
  clarificationId?: string,
) {
  return workspaceSessionDetailPath(workspaceSlug, sessionNumber, {
    artifactStage: stage.slug,
    artifactId: target.artifactId,
    artifactVersion: target.artifactVersion,
    reviewStageId: stage.id,
    reviewRevision: target.reviewRevision,
    clarificationId,
  });
}

const journeyTitle = triageMode
  ? "pauses ambiguous triage and carries approved criteria to its configured delegated task"
  : "answers an exact specification once and advances only after the revised approval";

test(journeyTitle, async ({ browser, page, baseURL }, testInfo) => {
  test.skip(
    !triageMode && process.env.WALLIE_SPECIFICATION_E2E !== "1",
    "Requires disposable local services.",
  );
  test.setTimeout(triageMode ? 180_000 : 90_000);
  const app = localUrl(baseURL, "http:").origin;
  const supabase = localUrl(process.env.NEXT_PUBLIC_SUPABASE_URL, "http:").origin;
  const database = localUrl(process.env.WALLIE_SPECIFICATION_DATABASE_URL, "postgresql:");
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!serviceKey) throw new Error("Set the disposable Supabase service key.");
  if (process.env.WALLIE_WORKER_WAKE_URL || process.env.OPENROUTER_API_KEY) {
    throw new Error("Disable external wake and model providers for this fixture.");
  }

  const admin = createClient<Database>(supabase, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const priorRelease = await row(admin.rpc("get_git_continuity_release_state").single());
  const release = priorRelease.enabled
    ? priorRelease
    : await row(
        admin
          .rpc("set_git_continuity_release", {
            p_enabled: true,
            p_expected_revision: priorRelease.revision,
            p_reason: "Disposable specification browser proof",
          })
          .single(),
      );

  const slug = `specification-proof-${randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;
  let workspaceId: string | undefined;
  let userId: string | undefined;
  try {
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error) throw error;
    userId = data.user.id;
    const workspace = await row(
      admin.rpc("create_workspace", {
        actor_user_id: userId,
        actor_email: email,
        requested_slug: slug,
        workspace_name: "Specification proof",
      }),
    );
    workspaceId = workspace.id;
    const factory = await row(
      admin
        .from("factories")
        .select("id")
        .eq("workspace_id", workspace.id)
        .eq("is_default", true)
        .single(),
    );
    const fixture = await seedDefinition(admin, database, workspace.id, factory.id, userId);
    const [specStage, deliveryStage] = fixture.stages;

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, `/w/${slug}/sessions`, { baseURL: app, email });
    await page.getByRole("button", { name: "New session", exact: true }).click();
    await page.getByLabel("Prompt", { exact: true }).fill(userPrompt);
    await page.getByRole("textbox", { name: "Title (optional)", exact: true }).fill(title);
    await page.getByRole("checkbox", { name: "Draft a specification first", exact: true }).check();
    const creation = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/sessions" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Start session", exact: true }).click();
    const created = await creation;
    expect(created.status(), await created.text()).toBe(201);
    expect(created.request().postDataJSON()).toMatchObject({ draftSpecification: true });
    const session = await row(
      admin
        .from("sessions")
        .select("id, number, specification_stage_id")
        .eq("workspace_id", workspace.id)
        .single(),
    );
    expect(session.specification_stage_id).toBe(specStage.id);
    const detail = workspaceSessionDetailPath(slug, session.number);
    await page.waitForURL((url) => url.pathname === detail);

    const initialJob = await row(
      admin.from("agent_jobs").select("id").eq("session_id", session.id).single(),
    );
    const initialRun = await publish(admin, {
      ...fixture,
      jobId: initialJob.id,
      sessionId: session.id,
      stageId: specStage.id,
      expectedVersion: 0,
      releaseRevision: release.revision,
      ...(triageMode ? { freezeWorkspaceId: workspace.id } : {}),
      markdown: `<!-- wallie-clarification: ${JSON.stringify({ question })} -->\n\n# Rollout specification\n\n${draft}`,
    });
    const firstRun = await row(
      admin
        .from("agent_runs")
        .select("agent_id, agent_prompt_revision_id")
        .eq("id", initialRun)
        .single(),
    );
    expect(firstRun).toMatchObject({
      agent_id: fixture.agent.agent_id,
      agent_prompt_revision_id: fixture.agent.id,
    });

    await page.reload();
    const specification = page.getByRole("region", { name: "Specification", exact: true });
    const expectRevisedScope = async () => {
      if (fixture.triageGraph) {
        await specification.getByRole("tab", { name: "Full artifact", exact: true }).click();
        await expect(specification.getByText(acceptanceCriterion, { exact: true })).toBeVisible();
      }
      await expect(specification.getByText(revision)).toBeVisible();
    };
    const clarification = specification.getByRole("region", {
      name: "Specification clarification",
    });
    await expect(specification.getByText(draft)).toBeVisible();
    await expect(clarification.getByText(question)).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve stage" })).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("01-specification-clarification-desktop.png"),
      fullPage: true,
    });

    const endpoint = `/api/sessions/${session.id}/specification`;
    const snapshot = sessionSpecificationStateSchema.parse(
      await (await page.request.get(endpoint)).json(),
    );
    const pending = snapshot.clarification;
    if (!pending) throw new Error("The first version did not publish a clarification.");
    const firstReviewPath = exactReviewPath(slug, session.number, specStage, pending);
    const pendingReviewPath = exactReviewPath(slug, session.number, specStage, pending, pending.id);
    if (fixture.triageGraph) {
      const blocked = await admin.rpc("read_factory_workflow_execution", {
        p_root_session_id: session.id,
        p_workspace_id: workspace.id,
        p_factory_id: factory.id,
      });
      expect(blocked.error).toBeNull();
      expect(blocked.data).toBeNull();
      await page.getByRole("link", { name: "Inbox", exact: true }).click();
      await page.waitForURL((url) => url.pathname === workspaceInboxPath(slug));
      const clarificationLink = page.getByRole("link", {
        name: `Answer clarification for ${title}`,
      });
      await expect(clarificationLink).toHaveAttribute("href", pendingReviewPath);
      await clarificationLink.click();
      await expect(clarification.getByText(question)).toBeVisible();
    }
    const staleApprove = await page.request.post(`/api/sessions/${session.id}/phase-action`, {
      data: {
        action: "approve",
        stageId: specStage.id,
        artifactId: pending.artifactId,
        version: pending.artifactVersion,
        expectedReviewRevision: pending.reviewRevision,
      },
    });
    expect(staleApprove.status()).toBe(409);

    const mobile = await browser.newContext({
      baseURL: app,
      colorScheme: "dark",
      viewport: { width: 390, height: 844 },
    });
    try {
      const phone = await mobile.newPage();
      if (fixture.triageGraph) {
        await signInViaMagicLink(phone, pendingReviewPath, { baseURL: app, email });
      } else {
        await phone.goto(pendingReviewPath);
        await phone.waitForURL((url) => url.pathname === "/login");
        await expect(phone.getByRole("heading", { name: "Sign in to Wallie" })).toBeVisible();
        const returnPath = new URL(phone.url()).searchParams.get("next");
        if (!returnPath) throw new Error("The sign-in page lost its exact review target.");
        await expect(phone.locator('input[name="next"]')).toHaveValue(returnPath);
        expect(new URL(returnPath, app).pathname).toBe(detail);
        expect(Object.fromEntries(new URL(returnPath, app).searchParams)).toEqual(
          Object.fromEntries(new URL(pendingReviewPath, app).searchParams),
        );
        await phone.screenshot({
          path: testInfo.outputPath("06-exact-review-sign-in-mobile.png"),
          fullPage: true,
        });
        await signInViaMagicLink(phone, returnPath, { baseURL: app, email });
      }
      await expect(phone.getByText(question, { exact: true })).toBeVisible();
      await expect(phone.getByRole("textbox", { name: "Your answer" })).toBeEnabled();
      expect(Object.fromEntries(new URL(phone.url()).searchParams)).toMatchObject({
        artifactId: pending.artifactId,
        artifactVersion: String(pending.artifactVersion),
        reviewStageId: specStage.id,
        reviewRevision: String(pending.reviewRevision),
        clarificationId: pending.id,
      });
      expect(
        await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
      await phone.screenshot({
        path: testInfo.outputPath("02-specification-clarification-mobile.png"),
        fullPage: true,
      });
    } finally {
      await mobile.close();
    }

    await page.goto(pendingReviewPath);
    const answerField = clarification.getByRole("textbox", { name: "Your answer" });
    const submitAnswer = clarification.getByRole("button", {
      name: "Submit answer",
      exact: true,
    });
    await expect(answerField).toBeEnabled();
    await answerField.fill(answer);
    await expect(submitAnswer).toBeEnabled();

    await test.step("A linked clarification keeps its draft during a focus recheck", async () => {
      const refresh = Promise.withResolvers<void>();
      await page.route(
        `**${endpoint}`,
        async (route) => {
          await refresh.promise;
          await route.continue();
        },
        { times: 1 },
      );
      try {
        const recheck = page.waitForRequest(
          (request) => new URL(request.url()).pathname === endpoint && request.method() === "GET",
        );
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await recheck;
        await expect(answerField).toHaveValue(answer);
        await expect(submitAnswer).toBeDisabled();
      } finally {
        refresh.resolve();
      }
      await expect(submitAnswer).toBeEnabled();
      await expect(answerField).toHaveValue(answer);
    });

    const submission = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === endpoint && response.request().method() === "POST",
    );
    await submitAnswer.click();
    const submitted = await submission;
    expect(submitted.status(), await submitted.text()).toBe(200);
    const receipt = specificationAnswerReceiptSchema.parse(await submitted.json());
    const original: SpecificationAnswer = submitted.request().postDataJSON();
    expect(original.answer).toBe(answer);
    expect(receipt).toMatchObject({
      clarificationId: pending.id,
      executionExhausted: false,
      replayed: false,
    });
    if (!receipt.jobId || !receipt.runId || !receipt.feedbackBatchId) {
      throw new Error("The answer did not enqueue an exact successor.");
    }
    const replay = await page.request.post(endpoint, { data: original });
    expect(replay.status(), await replay.text()).toBe(200);
    expect(specificationAnswerReceiptSchema.parse(await replay.json())).toEqual({
      ...receipt,
      replayed: true,
    });
    const changed = await page.request.post(endpoint, {
      data: { ...original, answer: "Changed answer" },
    });
    expect(changed.status()).toBe(409);
    const jobs = await row(
      admin.from("agent_jobs").select("id,stage_id").eq("session_id", session.id),
    );
    expect(jobs.map(({ id }) => id).sort()).toEqual([initialJob.id, receipt.jobId].sort());
    expect(jobs.find(({ id }) => id === receipt.jobId)?.stage_id).toBe(specStage.id);

    expect(
      await publish(admin, {
        ...fixture,
        jobId: receipt.jobId,
        sessionId: session.id,
        stageId: specStage.id,
        expectedVersion: 1,
        releaseRevision: release.revision,
        ...(triageMode ? { freezeWorkspaceId: workspace.id } : {}),
        markdown: fixture.triageGraph
          ? acceptedScopeArtifact(revision)
          : `# Revised rollout specification

${revision}`,
      }),
    ).toBe(receipt.runId);
    const late = await page.request.post(endpoint, {
      data: { ...original, requestId: randomUUID() },
    });
    expect(late.status()).toBe(409);
    await page.goto(detail);
    if (fixture.triageGraph) {
      const brief = specification.getByRole("tabpanel", { name: "Review brief", exact: true });
      await expect(brief.getByText(acceptanceCriterion)).toBeVisible();
      await expect(brief.getByText(/wallie-accepted-scope/)).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath("04-approved-scope-review-brief.png"),
        fullPage: true,
      });
    }
    await expectRevisedScope();
    await expect(page.getByRole("button", { name: "Approve stage" })).toBeEnabled();

    await page.getByRole("button", { name: "Conversation", exact: true }).click();
    const conversation = page.getByRole("region", { name: "Conversation", exact: true });
    await expect(conversation.getByText(answer)).toBeVisible();
    await expect(
      conversation
        .getByRole("listitem")
        .filter({ hasText: "A specification is ready for review." })
        .getByText(specificationAgent),
    ).toBeVisible();
    await page.getByRole("button", { name: "Conversation", exact: true }).click();
    await specification.getByRole("tab", { name: "Versions", exact: true }).click();
    await expect(specification.getByRole("button", { name: /Version 1/ })).toBeVisible();
    await expect(specification.getByRole("button", { name: /Version 2/ })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("03-specification-versions-desktop.png"),
      fullPage: true,
    });

    await specification.getByRole("button", { name: /Version 1/ }).click();
    await expect(specification.getByText(draft)).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve stage" })).toHaveCount(0);
    await specification.getByRole("tab", { name: "Versions", exact: true }).click();
    await specification.getByRole("button", { name: /Version 2/ }).click();
    await expectRevisedScope();

    const revised = await row(
      admin
        .from("sessions")
        .select("current_artifact_id, current_artifact_version, artifact_review_revision")
        .eq("id", session.id)
        .single(),
    );
    if (!revised.current_artifact_id) throw new Error("The revised artifact is missing.");
    if (fixture.triageGraph) {
      const source = await row(
        admin
          .from("session_artifacts")
          .select("artifact_json")
          .eq("id", revised.current_artifact_id)
          .single(),
      );
      expect(source.artifact_json).toBe(acceptedScopeArtifact(revision));
    }
    const revisedReviewPath = exactReviewPath(slug, session.number, specStage, {
      artifactId: revised.current_artifact_id,
      artifactVersion: revised.current_artifact_version,
      reviewRevision: revised.artifact_review_revision,
    });

    await page.goto(firstReviewPath);
    await expect(page.getByText("This review link is no longer current.")).toBeVisible();
    await expect(specification.getByText(draft)).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve stage" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Request changes" })).toHaveCount(0);
    const openCurrentReview = page.getByRole("link", { name: "Open current review" });
    await expect(openCurrentReview).toHaveAttribute("href", detail);
    await page.screenshot({
      path: testInfo.outputPath("07-exact-review-historical-desktop.png"),
      fullPage: true,
    });
    const phaseActionPath = `/api/sessions/${session.id}/phase-action`;
    const staleArtifact = await page.request.post(phaseActionPath, {
      data: {
        action: "approve",
        stageId: specStage.id,
        artifactId: pending.artifactId,
        version: pending.artifactVersion,
        expectedReviewRevision: pending.reviewRevision,
      },
    });
    expect(staleArtifact.status()).toBe(409);
    await openCurrentReview.click();
    await expect(page).toHaveURL(app + detail);
    await expectRevisedScope();

    const wrongArtifact = await page.request.get(
      `/api/sessions/${session.id}/artifacts?stage=${specStage.slug}&artifactId=${randomUUID()}`,
    );
    expect(wrongArtifact.status()).toBe(404);
    await page.goto(
      exactReviewPath(slug, session.number, specStage, {
        artifactId: pending.artifactId,
        artifactVersion: revised.current_artifact_version,
        reviewRevision: revised.artifact_review_revision,
      }),
    );
    await expect(page.getByRole("heading", { name: "This page isn’t available" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve stage" })).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("09-exact-review-unavailable-desktop.png"),
      fullPage: true,
    });

    await page.goto(revisedReviewPath);
    await expectRevisedScope();
    if (fixture.triageGraph) {
      await expect(specification.getByText(acceptanceCriterion, { exact: true })).toBeVisible();
    }
    const approve = page.getByRole("button", { name: "Approve stage" });
    await expect(approve).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("08-exact-review-current-desktop.png"),
      fullPage: true,
    });
    const decision = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === phaseActionPath &&
        response.request().method() === "POST",
    );
    await approve.click();
    const accepted = await decision;
    expect(accepted.status(), await accepted.text()).toBe(200);
    expect(accepted.request().postDataJSON()).toMatchObject({
      action: "approve",
      stageId: specStage.id,
      artifactId: revised.current_artifact_id,
      version: revised.current_artifact_version,
      expectedReviewRevision: revised.artifact_review_revision,
    });
    const triageGraph = fixture.triageGraph;
    if (triageGraph) {
      const approval = await row(
        admin
          .from("session_stage_approval_receipts")
          .select("id, artifact_id, artifact_version")
          .eq("session_id", session.id)
          .single(),
      );
      expect(approval).toMatchObject({
        artifact_id: revised.current_artifact_id,
        artifact_version: 2,
      });
      const child = await dispatchFixtureForeman(
        admin,
        {
          rootSessionId: session.id,
          workspaceId: workspace.id,
          factoryId: factory.id,
          graphDigest: triageGraph.digest,
          approvedRunId: receipt.runId,
        },
        randomUUID(),
      );
      const childSession = await row(
        admin
          .from("sessions")
          .select("number,title,prompt_md,current_stage_id")
          .eq("workspace_id", workspace.id)
          .eq("id", child.childSessionId)
          .single(),
      );
      expect(childSession).toMatchObject({
        title: childTitle,
        prompt_md: childTask,
        current_stage_id: specStage.id,
      });
      expect(
        await publish(admin, {
          ...fixture,
          jobId: child.jobId,
          sessionId: child.childSessionId,
          stageId: specStage.id,
          expectedVersion: 0,
          releaseRevision: release.revision,
          markdown: "",
          async prepareResult(runId) {
            const attempt = { workspaceId: workspace.id, jobId: child.jobId, runId };
            const scope = await readFixtureChildScope(admin, attempt);
            expect(scope.pin).toMatchObject({
              rootSessionId: session.id,
              approvalId: approval.id,
              artifactId: revised.current_artifact_id,
              artifactVersion: 2,
              workflowDigest: triageGraph.digest,
            });
            expect(scope.body).toContain(acceptanceCriterion);
            await freezeFixtureContext(admin, attempt, [
              { key: "session/prompt", body: childTask },
              { key: scope.key, body: scope.body },
            ]);
            return `## Delivered against approved scope

${scope.body}`;
          },
        }),
      ).toBe(child.runId);
      await page.goto(workspaceSessionDetailPath(slug, childSession.number));
      await expect(page.getByRole("heading", { name: childTitle, exact: true })).toBeVisible();
      await expect(page.getByText(acceptanceCriterion, { exact: true })).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("10-delegated-approved-scope-desktop.png"),
        fullPage: true,
      });
      return;
    }

    await expect
      .poll(
        async () =>
          (
            await row(
              admin.from("sessions").select("current_stage_id").eq("id", session.id).single(),
            )
          ).current_stage_id,
      )
      .toBe(deliveryStage.id);
    const approval = await row(
      admin
        .from("session_stage_approval_receipts")
        .select("artifact_id, artifact_version")
        .eq("session_id", session.id)
        .single(),
    );
    expect(approval).toEqual({ artifact_id: revised.current_artifact_id, artifact_version: 2 });

    const deliveryRun = await row(
      admin
        .from("agent_runs")
        .select("id")
        .eq("session_id", session.id)
        .eq("stage_id", deliveryStage.id)
        .eq("status", "queued")
        .single(),
    );
    // Lose both the first command response and its immediate live update so
    // the browser must retry the exact intent it already submitted.
    let delayLiveChanges = false;
    await page.routeWebSocket("**/realtime/v1/websocket*", (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        if (!delayLiveChanges || !message.toString().includes('"postgres_changes"')) {
          socket.send(message);
        }
      });
    });
    await page.goto(detail);
    const stop = page.getByRole("button", { name: "Stop run", exact: true });
    await expect(stop).toBeEnabled();
    const cancelPath = `/api/sessions/${session.id}/cancel`;
    const attempts: unknown[] = [];
    let lostResponseStatus: number | null = null;
    await page.route(`**${cancelPath}`, async (route) => {
      attempts.push(route.request().postDataJSON());
      if (attempts.length > 1) return route.continue();
      const committed = await route.fetch();
      lostResponseStatus = committed.status();
      await route.abort("failed");
    });
    delayLiveChanges = true;
    await stop.click();
    await expect(page.getByText("Stop failed.", { exact: true })).toBeVisible();
    expect(lostResponseStatus).toBe(200);
    await expect(stop).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("04-stop-intent-retry-desktop.png"),
      fullPage: true,
    });

    const retriedStop = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === cancelPath && response.request().method() === "POST",
    );
    await stop.click();
    expect((await retriedStop).status()).toBe(200);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual({ expectedRunId: deliveryRun.id, requestId: expect.any(String) });
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(stop).toHaveCount(0);
    expect(
      await row(admin.from("agent_runs").select("status").eq("id", deliveryRun.id).single()),
    ).toEqual({
      status: "canceled",
    });
    const messages = await row(
      admin
        .from("agent_run_messages")
        .select("id")
        .eq("agent_run_id", deliveryRun.id)
        .like("message_md", "**Canceled:**%"),
    );
    expect(messages).toHaveLength(1);
    delayLiveChanges = false;
    await page.screenshot({
      path: testInfo.outputPath("05-stopped-exact-run-desktop.png"),
      fullPage: true,
    });
  } finally {
    try {
      if (workspaceId) await checked(admin.from("workspaces").delete().eq("id", workspaceId));
      if (userId) {
        const { error } = await admin.auth.admin.deleteUser(userId);
        if (error) throw error;
      }
    } finally {
      if (!priorRelease.enabled) {
        await checked(
          admin.rpc("set_git_continuity_release", {
            p_enabled: false,
            p_expected_revision: release.revision,
            p_reason: "Restore dedicated stack after specification browser proof",
          }),
        );
      }
    }
  }
});

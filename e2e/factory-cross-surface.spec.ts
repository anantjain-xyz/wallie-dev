import { createHash, randomBytes, randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { createSessionPayloadSchema } from "@/features/sessions/create";
import {
  answerSpecificationSchema,
  specificationAnswerReceiptSchema,
} from "@/lib/sessions/specification-contracts";
import type { Database } from "@/lib/supabase/database.types";
import { signInViaMagicLink } from "./helpers/auth";
import {
  FactoryClient,
  factoryMcpFixture,
  type FactoryBody,
  type FactoryMcpFixtureResult,
  type FactoryResponse,
} from "./helpers/factory-integration";
import {
  auditSharedWork,
  cleanupSharedWork,
  expireWitnessGrant,
  proveSharedWorkOutboxRestart,
  proveSharedWorkOutboxRevocation,
  publishSharedWork,
  registerSharedWorkOutbox,
  seedSharedWork,
} from "./helpers/factory-shared-work";

type Admin = SupabaseClient<Database>;
type Fixture = Awaited<ReturnType<typeof seedSharedWork>>;
type Session = FactoryResponse<"getFactorySession">;
type Review = NonNullable<Session["review"]>;
type Receipt = FactoryResponse<"createFactorySession">;
type Conversation = FactoryResponse<"listFactoryConversation">;
type Artifact = FactoryResponse<"getFactoryArtifact">;
type Handoff = {
  code: "human_action_required";
  action: "answer_clarification" | "review";
  sessionId: string;
  review: Review;
};

const title = "Verify a checkout rollout";
const prompt = "Plan a no-impact rollout of the sample checkout.";
const draft = "The checklist is ready once we confirm the rollout cohort.";
const question = "Which cohort should get the checkout rollout first?";
const answer = "Start with the internal support team only.";
const revised = "Start with the internal support team, then check payment telemetry.";
const result = "The checkout rehearsal passed and the rollback checklist is verified.";
const sourceMessage = "The rehearsal discussion recorded the rollback owner.";
const sourceLabel = "Rehearsal discussion";
const sourcePath = "https://example.test/checkout/rehearsal";

const createdSchema = z.object({
  canonicalUrl: z.string(),
  number: z.number(),
  processScheduled: z.boolean(),
});

function localUrl(value: string | undefined, protocol: string) {
  if (!value) throw new Error("Set the disposable app, Supabase and database URLs.");
  const url = new URL(value);
  if (url.protocol !== protocol || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Cross-surface qualification requires loopback services.");
  }
  return url;
}

function testCredential() {
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  return {
    id,
    digest: createHash("sha256").update(secret).digest("hex"),
    token: `wallie_mt_${id}.${secret}`,
  };
}

async function row<T>(operation: PromiseLike<{ data: T; error: unknown }>) {
  const { data, error } = await operation;
  if (error) throw error;
  if (data == null) throw new Error("A qualification fixture row is missing.");
  return data;
}

async function checked(operation: PromiseLike<{ error: unknown }>) {
  const { error } = await operation;
  if (error) throw error;
}

async function mcpResult<T>(operation: Promise<FactoryMcpFixtureResult<T>>) {
  const response = await operation;
  if (!response.ok)
    throw new Error(
      `Expected a successful MCP request, received ${response.status} ${response.error.code}.`,
    );
  return response.result;
}

function exactReview({ stageId, artifactId, artifactVersion, reviewRevision }: Review) {
  return { stageId, artifactId, artifactVersion, reviewRevision };
}

function requireReview(session: Session) {
  if (!session.review) throw new Error("Expected an exact review on the shared session.");
  return session.review;
}

function postResponse(page: Page, path: string) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === "POST",
  );
}

async function addSourceMessage(admin: Admin, fixture: Fixture, sessionId: string) {
  const scope = {
    p_workspace_id: fixture.workspaceId,
    p_factory_id: fixture.factoryId,
    p_session_id: sessionId,
    p_actor_member_id: fixture.ownerMemberId,
  };
  const source = await row(
    admin
      .rpc("bind_session_conversation_source_once", {
        ...scope,
        p_provider: "fixture",
        p_source_namespace: "qualification",
        p_external_thread_id: "rehearsal-42",
        p_label: sourceLabel,
        p_source_url: `${sourcePath}?fixture=omit-on-machine-surfaces#private-fragment`,
      })
      .single(),
  );
  await row(
    admin
      .rpc("append_session_conversation_message_once", {
        ...scope,
        p_request_id: randomUUID(),
        p_body_md: sourceMessage,
        p_source_id: source.id,
        p_external_message_id: "rehearsal-message-1",
        p_external_actor_id: "rehearsal-coordinator",
      })
      .single(),
  );
}

test.use({ actionTimeout: 10_000, screenshot: "off", trace: "off" });

test("one exact factory session survives browser, API and MCP handoffs", async ({
  baseURL,
  context,
  page,
}, testInfo) => {
  test.skip(
    process.env.WALLIE_CROSS_SURFACE_E2E !== "1",
    "Requires a disposable local Supabase stack.",
  );
  test.setTimeout(130_000);

  const app = localUrl(baseURL, "http:").origin;
  const supabaseUrl = localUrl(process.env.NEXT_PUBLIC_SUPABASE_URL, "http:").origin;
  const database = localUrl(process.env.WALLIE_CROSS_SURFACE_DATABASE_URL, "postgresql:");
  const adminKey = process.env.SUPABASE_SECRET_KEY;
  if (!adminKey) throw new Error("Set the disposable Supabase service key.");
  if (process.env.WALLIE_WORKER_WAKE_URL || process.env.OPENROUTER_API_KEY) {
    throw new Error("Run the qualification without external worker or model credentials.");
  }
  const admin = createClient<Database>(supabaseUrl, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const slug = `m04-qualification-${randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;
  const writer = testCredential();
  const witness = testCredential();
  let ownerId: string | undefined;
  let changedContinuityRevision: number | undefined;

  try {
    const release = await row(admin.rpc("get_git_continuity_release_state").single());
    if (!release.enabled) {
      const enabled = await row(
        admin
          .rpc("set_git_continuity_release", {
            p_enabled: true,
            p_expected_revision: release.revision,
            p_reason: "Disposable cross-surface qualification",
          })
          .single(),
      );
      changedContinuityRevision = enabled.revision;
    }
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error) throw error;
    ownerId = data.user.id;
    const fixture = await seedSharedWork(database, {
      ownerId,
      ownerEmail: email,
      workspaceSlug: slug,
      writer: { id: writer.id, digest: writer.digest },
      witness: { id: witness.id, digest: witness.digest },
    });
    const scope = { baseUrl: app, workspaceId: fixture.workspaceId, factoryId: fixture.factoryId };
    const writeApi = new FactoryClient({ ...scope, token: writer.token });
    const readApi = new FactoryClient({ ...scope, token: witness.token });
    const writeMcp = factoryMcpFixture({ ...scope, token: writer.token });
    const readMcp = factoryMcpFixture({ ...scope, token: witness.token });

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, `/w/${slug}/sessions`, { baseURL: app, email });
    const inbox = page.getByRole("link", { name: "Inbox", exact: true });

    const creation =
      await test.step("Replay the browser's exact create intent over the API and MCP", async () => {
        await page.getByRole("button", { name: "New session", exact: true }).click();
        await page.getByLabel("Prompt", { exact: true }).fill(prompt);
        await page.getByRole("textbox", { name: "Title (optional)", exact: true }).fill(title);
        await page
          .getByRole("checkbox", { name: "Draft a specification first", exact: true })
          .check();
        const response = postResponse(page, "/api/sessions");
        await page.getByRole("button", { name: "Start session", exact: true }).click();
        const created = await response;
        expect(created.status()).toBe(201);
        const browser = createdSchema.parse(await created.json());
        expect(browser.processScheduled).toBe(true);
        await expect(page).toHaveURL(new URL(browser.canonicalUrl, app).href);
        const original = createSessionPayloadSchema.parse(created.request().postDataJSON());
        expect(original).toMatchObject({
          workspaceId: fixture.workspaceId,
          factoryDefinitionDigest: fixture.definitionDigest,
          githubRepositoryId: fixture.repositoryId,
          title,
          promptMd: prompt,
          draftSpecification: true,
        });
        if (!original.requestId) throw new Error("The browser did not retain a create key.");
        const key = { idempotencyKey: original.requestId };
        const intent = {
          title,
          prompt,
          agentId: fixture.agentId,
          repositoryId: fixture.repositoryId,
          draftSpecification: true,
        } satisfies FactoryBody<"createFactorySession">;
        const [receipt, mcpReceipt] = await Promise.all([
          writeApi.createSession(intent, key),
          mcpResult(writeMcp.call<Receipt>("wallie_create_session", { ...intent, ...key })),
        ]);
        expect(receipt).toMatchObject({
          canonicalUrl: browser.canonicalUrl,
          sessionNumber: browser.number,
          replayed: true,
        });
        const { canonicalUrl, conversationUrl, ...identity } = receipt;
        expect(mcpReceipt).toEqual({
          ...identity,
          canonicalUrl: new URL(canonicalUrl, app).href,
          conversationUrl: new URL(conversationUrl, app).href,
        });
        await expect(
          writeApi.createSession({ ...intent, title: "A different intent" }, key),
        ).rejects.toMatchObject({
          status: 409,
          code: "idempotency_conflict",
        });
        if (!receipt.jobId || !receipt.runId)
          throw new Error("The shared create receipt has no exact run.");
        return { ...receipt, jobId: receipt.jobId, runId: receipt.runId, key, intent };
      });
    const { sessionId } = creation;
    const audit = () =>
      auditSharedWork(database, fixture, { sessionId, requestId: creation.key.idempotencyKey });
    expect(await audit()).toMatchObject({ sessions: 1, createReceipts: 1 });

    const { first, originalReview, before, answerInput, answerReceipt } =
      await test.step("Send an exact clarification to the signed-in Inbox", async () => {
        await registerSharedWorkOutbox(database, fixture);
        const first = await publishSharedWork(database, fixture, {
          sessionId,
          jobId: creation.jobId,
          stageId: fixture.specStage.id,
          expectedVersion: 0,
          markdown: `<!-- wallie-clarification: ${JSON.stringify({ question })} -->\n\n# Checkout rollout\n\n${draft}`,
        });
        expect(first).toMatchObject({
          runId: creation.runId,
          credentialPrincipalId: fixture.writer.principalId,
        });
        await addSourceMessage(admin, fixture, sessionId);
        await proveSharedWorkOutboxRestart(database, fixture, {
          sessionId,
          artifactId: first.artifactId,
        });

        const originalReview = requireReview(await readApi.getSession(sessionId));
        expect(originalReview).toMatchObject({
          stageId: first.stageId,
          artifactId: first.artifactId,
          artifactVersion: first.artifactVersion,
          reviewRevision: first.reviewRevision,
          runId: first.runId,
          clarification: { question },
        });
        if (!originalReview.clarification)
          throw new Error("Expected the first version to ask a question.");
        const originalTarget = { sessionId, expectedReview: exactReview(originalReview) };
        expect(
          await mcpResult(readMcp.call<Handoff>("wallie_review_handoff", originalTarget)),
        ).toMatchObject({
          code: "human_action_required",
          action: "answer_clarification",
          sessionId,
          review: { ...originalReview, href: new URL(originalReview.href, app).href },
        });
        const feedback = {
          ...exactReview(originalReview),
          feedback: "Proceed with the rehearsal.",
        };
        const key = { idempotencyKey: randomUUID() };
        await expect(writeApi.sendFollowUp(sessionId, feedback, key)).rejects.toMatchObject({
          status: 409,
          code: "clarification_required",
        });
        expect(
          await writeMcp.call("wallie_send_follow_up", { sessionId, ...feedback, ...key }),
        ).toMatchObject({
          ok: false,
          error: { code: "clarification_required" },
        });

        const historyQuery = { direction: "after", limit: "50" } as const;
        const before = await readApi.getConversation(sessionId, historyQuery);
        const mcpBefore = await mcpResult(
          readMcp.call<Conversation>("wallie_read_conversation", { sessionId, ...historyQuery }),
        );
        expect(mcpBefore.items).toEqual(before.items);
        expect(mcpBefore.resumeCursor).toBe(before.resumeCursor);
        expect(before.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "review_ready",
              artifactId: first.artifactId,
              runId: first.runId,
            }),
            expect.objectContaining({
              bodyHtml: expect.stringContaining(sourceMessage),
              source: expect.objectContaining({ label: sourceLabel, url: sourcePath }),
            }),
          ]),
        );

        await inbox.click();
        const link = page.getByRole("link", { name: `Answer clarification for ${title}` });
        await expect(link).toHaveAttribute("href", originalReview.href);
        await link.click();
        const clarification = page.getByRole("region", { name: "Specification clarification" });
        await expect(clarification.getByText(question)).toBeVisible();
        await expect(page.getByRole("button", { name: "Approve stage" })).toHaveCount(0);
        await clarification.getByLabel("Your answer").fill(answer);
        const endpoint = `/api/sessions/${sessionId}/specification`;
        const response = postResponse(page, endpoint);
        await clarification.getByRole("button", { name: "Submit answer" }).click();
        const submitted = await response;
        expect(submitted.status()).toBe(200);
        const input = answerSpecificationSchema.parse(submitted.request().postDataJSON());
        expect(input).toMatchObject({
          artifactId: originalReview.artifactId,
          artifactVersion: originalReview.artifactVersion,
          reviewRevision: originalReview.reviewRevision,
          clarificationId: originalReview.clarification.id,
          answer,
        });
        const receipt = specificationAnswerReceiptSchema.parse(await submitted.json());
        expect(receipt).toMatchObject({
          clarificationId: input.clarificationId,
          executionExhausted: false,
          replayed: false,
        });
        if (!receipt.jobId || !receipt.runId)
          throw new Error("The answer has no exact successor run.");
        const retry = await page.request.post(endpoint, { data: input });
        expect(retry.status()).toBe(200);
        expect(specificationAnswerReceiptSchema.parse(await retry.json())).toEqual({
          ...receipt,
          replayed: true,
        });
        return {
          first,
          originalReview,
          before,
          answerInput: input,
          answerReceipt: { ...receipt, jobId: receipt.jobId, runId: receipt.runId },
        };
      });

    const { second, currentReview } =
      await test.step("Reconcile a new exact review after offline transport and revocation", async () => {
        await inbox.click();
        await expect(page.getByText("You’re all caught up.")).toBeVisible();
        await context.setOffline(true);
        try {
          await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
          await expect(
            page.getByText("You’re offline. Reconnect to refresh your Inbox."),
          ).toBeVisible();
          await proveSharedWorkOutboxRevocation(database, fixture, {
            sessionId,
            artifactId: first.artifactId,
          });
          await expect(writeApi.getSession(sessionId)).rejects.toMatchObject({
            status: 401,
            code: "unauthorized",
          });
          await expect(writeApi.createSession(creation.intent, creation.key)).rejects.toMatchObject(
            { status: 401, code: "unauthorized" },
          );
          expect(await writeMcp.call("wallie_get_session", { sessionId })).toMatchObject({
            ok: false,
            status: 401,
            error: { code: "unauthorized" },
          });
          expect(
            await writeMcp.call("wallie_create_session", { ...creation.intent, ...creation.key }),
          ).toMatchObject({
            ok: false,
            status: 401,
            error: { code: "unauthorized" },
          });
          const second = await publishSharedWork(database, fixture, {
            sessionId,
            jobId: answerReceipt.jobId,
            stageId: fixture.specStage.id,
            expectedVersion: 1,
            markdown: `# Checkout rollout specification\n\n${revised}`,
          });
          expect(second).toMatchObject({
            runId: answerReceipt.runId,
            credentialPrincipalId: fixture.writer.principalId,
          });
          const currentReview = requireReview(await readApi.getSession(sessionId));
          expect(currentReview).toMatchObject({
            artifactId: second.artifactId,
            artifactVersion: 2,
            clarification: null,
          });
          await Promise.all([
            page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname === "/api/factories/inbox" && response.ok(),
            ),
            context.setOffline(false),
          ]);
          const link = page.getByRole("link", { name: `Open review for ${title}` });
          await expect(link).toHaveAttribute("href", currentReview.href);
          await expect(
            page.getByRole("link", { name: `Answer clarification for ${title}` }),
          ).toHaveCount(0);
          await page.screenshot({
            path: testInfo.outputPath("01-inbox-recovered.png"),
            animations: "disabled",
          });
          return { second, currentReview };
        } finally {
          await context.setOffline(false);
        }
      });

    const published =
      await test.step("Approve one human decision and read its downstream result", async () => {
        const historical = await context.newPage();
        try {
          await historical.goto(originalReview.href);
          await expect(
            historical.getByText("This review link is no longer current."),
          ).toBeVisible();
          await expect(historical.getByText(draft)).toBeVisible();
          await expect(historical.getByRole("button", { name: "Submit answer" })).toHaveCount(0);
          await expect(historical.getByRole("button", { name: "Approve stage" })).toHaveCount(0);
        } finally {
          await historical.close();
        }
        expect(
          await readMcp.call("wallie_review_handoff", {
            sessionId,
            expectedReview: exactReview(originalReview),
          }),
        ).toMatchObject({
          ok: false,
          error: { code: "stale_intent" },
        });
        expect(
          await mcpResult(
            readMcp.call<Handoff>("wallie_review_handoff", {
              sessionId,
              expectedReview: exactReview(currentReview),
            }),
          ),
        ).toMatchObject({
          code: "human_action_required",
          action: "review",
          sessionId,
          review: { ...currentReview, href: new URL(currentReview.href, app).href },
        });
        const phaseAction = `/api/sessions/${sessionId}/phase-action`;
        const [lateAnswer, lateApproval] = await Promise.all([
          page.request.post(`/api/sessions/${sessionId}/specification`, {
            data: { ...answerInput, requestId: randomUUID() },
          }),
          page.request.post(phaseAction, {
            data: {
              action: "approve",
              stageId: originalReview.stageId,
              artifactId: originalReview.artifactId,
              version: originalReview.artifactVersion,
              expectedReviewRevision: originalReview.reviewRevision,
            },
          }),
        ]);
        expect(lateAnswer.status()).toBe(409);
        expect(lateApproval.status()).toBe(409);
        await page.getByRole("link", { name: `Open review for ${title}` }).click();
        await expect(page.getByText(revised)).toBeVisible();
        const approval = page.getByRole("button", { name: "Approve stage", exact: true });
        await expect(approval).toBeEnabled();
        const response = postResponse(page, phaseAction);
        await approval.click();
        const decision = await response;
        expect(decision.status()).toBe(200);
        expect(decision.request().postDataJSON()).toMatchObject({
          action: "approve",
          stageId: currentReview.stageId,
          artifactId: currentReview.artifactId,
          version: currentReview.artifactVersion,
          expectedReviewRevision: currentReview.reviewRevision,
        });
        expect(await audit()).toMatchObject({
          approvalCount: 1,
          approval: {
            artifactId: second.artifactId,
            artifactVersion: 2,
            stageId: fixture.specStage.id,
            approverMemberId: fixture.ownerMemberId,
          },
        });
        const successor = await row(
          admin
            .from("agent_jobs")
            .select("id")
            .eq("session_id", sessionId)
            .eq("stage_id", fixture.resultStage.id)
            .single(),
        );
        const published = await publishSharedWork(database, fixture, {
          sessionId,
          jobId: successor.id,
          stageId: fixture.resultStage.id,
          expectedVersion: 0,
          markdown: `# Checkout rehearsal result\n\n${result}`,
        });
        const artifact = await readApi.getArtifact(sessionId, published.artifactId);
        expect(artifact).toMatchObject({
          id: published.artifactId,
          sessionId,
          stageId: fixture.resultStage.id,
          version: 1,
          bodyHtml: expect.stringContaining(result),
          provenance: {
            runId: published.runId,
            checkpointRunId: expect.any(String),
            commitSha: expect.stringMatching(/^[a-f0-9]{40}$/),
          },
        });
        expect(
          await mcpResult(
            readMcp.call<Artifact>("wallie_get_artifact", { sessionId, artifactId: artifact.id }),
          ),
        ).toEqual({
          ...artifact,
          canonicalUrl: new URL(artifact.canonicalUrl, app).href,
          href: new URL(artifact.href, app).href,
        });
        await page.goto(creation.canonicalUrl);
        await expect(page.getByText(result)).toBeVisible();
        return published;
      });

    await test.step("Resume the same durable conversation, then deny an expired observer", async () => {
      const query = { direction: "after", cursor: before.resumeCursor, limit: "50" } as const;
      const resumed = await readApi.getConversation(sessionId, query);
      const mcpResumed = await mcpResult(
        readMcp.call<Conversation>("wallie_read_conversation", { sessionId, ...query }),
      );
      expect(mcpResumed.items).toEqual(resumed.items);
      expect(mcpResumed.resumeCursor).toBe(resumed.resumeCursor);
      expect(resumed.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ bodyHtml: expect.stringContaining(answer) }),
          expect.objectContaining({
            kind: "review_ready",
            artifactId: published.artifactId,
            runId: published.runId,
          }),
        ]),
      );
      const messages = [...before.items, ...resumed.items];
      const sequences = messages.map(({ sequence }) => sequence);
      expect(sequences).toEqual([...new Set(sequences)].sort((earlier, later) => earlier - later));
      expect(messages.filter(({ bodyHtml }) => bodyHtml.includes(prompt))).toHaveLength(1);
      expect(messages.filter(({ bodyHtml }) => bodyHtml.includes(answer))).toHaveLength(1);
      const full = await readApi.getConversation(sessionId, { direction: "after", limit: "50" });
      expect(full.items).toEqual(messages);
      await page.getByRole("button", { name: "Conversation", exact: true }).click();
      const conversation = page.getByRole("region", { name: "Conversation", exact: true });
      await expect(conversation.getByText(answer)).toBeVisible();
      await expect(conversation.getByText(sourceMessage)).toBeVisible();
      await expect(conversation.getByRole("link", { name: sourceLabel }).first()).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("02-result-conversation.png"),
        animations: "disabled",
      });

      const recorded = await audit();
      expect(recorded).toMatchObject({
        sessions: 1,
        createReceipts: 1,
        approvalCount: 1,
        personalCredentialRuns: 0,
        conversationCount: 1,
      });
      expect(recorded.runs).toHaveLength(3);
      for (const run of [first, second, published]) {
        expect(recorded.runs).toContainEqual(
          expect.objectContaining({
            id: run.runId,
            stageId: run.stageId,
            credentialPrincipalId: fixture.writer.principalId,
          }),
        );
      }
      await expireWitnessGrant(database, fixture);
      await expect(
        readApi.getConversation(sessionId, { direction: "after", cursor: resumed.resumeCursor }),
      ).rejects.toMatchObject({
        status: 401,
        code: "unauthorized",
      });
      expect(
        await readMcp.call("wallie_read_conversation", {
          sessionId,
          direction: "after",
          cursor: resumed.resumeCursor,
        }),
      ).toMatchObject({
        ok: false,
        status: 401,
        error: { code: "unauthorized" },
      });
      await page.reload();
      await expect(page.getByText(result)).toBeVisible();
    });
  } finally {
    try {
      if (ownerId) await cleanupSharedWork(database, slug);
    } finally {
      try {
        if (ownerId) await checked(admin.auth.admin.deleteUser(ownerId));
      } finally {
        if (changedContinuityRevision !== undefined) {
          await checked(
            admin.rpc("set_git_continuity_release", {
              p_enabled: false,
              p_expected_revision: changedContinuityRevision,
              p_reason: "Restore disposable cross-surface qualification state",
            }),
          );
        }
      }
    }
  }
});

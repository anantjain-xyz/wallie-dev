import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { chromium, type Page } from "playwright-core";
import { z } from "zod/v4";

import { workspaceSessionDetailPath } from "@/lib/routes";
import { parseSessionReviewTarget, sessionReviewReturnPath } from "@/lib/sessions/review-link";
import type { Database } from "@/lib/supabase/database.types";

import { signInViaMagicLink } from "../../e2e/helpers/auth";

const human = z.object({ userId: z.uuid(), memberId: z.uuid(), email: z.email() });
const fixtureSchema = z.object({
  workspaceId: z.uuid(),
  workspaceSlug: z.string(),
  factoryId: z.uuid(),
  outsiderWorkspaceSlug: z.string(),
  humans: z.object({ owner: human, reviewer: human, outsider: human }),
});
const feedbackReceipt = z.object({
  feedbackBatchId: z.uuid(),
  revisionJobId: z.uuid(),
  revisionRunId: z.uuid(),
});
const followUpRequest = z.object({
  action: z.literal("reject"),
  stageId: z.uuid(),
  artifactId: z.uuid(),
  version: z.number().int().positive(),
  feedbackText: z.string(),
  feedbackSubmission: z.object({
    requestId: z.uuid(),
    expectedReviewRevision: z.number().int().nonnegative(),
    selectedThreadIds: z.tuple([]),
  }),
});
const discussionReceipt = z.object({ thread: z.object({ id: z.uuid() }) });
const replyReceipt = z.object({ comment: z.object({ id: z.uuid() }) });

const question = "Should the revised plan retain the original provider source?";
const answer = "Yes. Keep this work on the same Linear issue and Wallie session.";
const feedback = "Revise the plan to preserve the original Linear source and its review history.";
const negativeProbe = { maxRedirects: 0 };

type Admin = SupabaseClient<Database>;
type Provider = "github" | "linear";
type BrowserReviewInput = { sessionId: string; href: string };

function loopbackOrigin(value: string) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:");
  assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.equal(url.href, `${url.origin}/`, "Use bare loopback qualification origins.");
  return url.origin;
}

export async function guardConnectorBrowserRequests(page: Page, app: string, auth: string) {
  const origins = new Set([loopbackOrigin(app), loopbackOrigin(auth)]);
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Fetch.requestPaused", ({ requestId, request }) => {
    const url = URL.parse(request.url);
    const action =
      url && origins.has(url.origin) && !url.username && !url.password
        ? cdp.send("Fetch.continueRequest", { requestId })
        : cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    void action.catch(() =>
      page.close({ reason: "Loopback browser interception failed." }).catch(() => {}),
    );
  });
  // Playwright routing only visits the first URL in a redirect chain.
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
}

async function readRow<T>(operation: PromiseLike<{ data: T; error: unknown }>) {
  const { data, error } = await operation;
  if (error) throw error;
  assert(data !== null, "A scoped browser qualification record was missing.");
  return data;
}

function postResponse(page: Page, path: string) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === "POST",
  );
}

async function openConversation(page: Page) {
  const toggle = page.getByRole("button", { name: "Conversation", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  return page.getByRole("region", { name: "Conversation", exact: true });
}

async function readReviewSession(
  admin: Admin,
  fixture: z.output<typeof fixtureSchema>,
  id: string,
) {
  return readRow(
    admin
      .from("sessions")
      .select(
        "number,current_stage_id,current_artifact_id,current_artifact_version,artifact_review_revision,phase_status",
      )
      .eq("workspace_id", fixture.workspaceId)
      .eq("factory_id", fixture.factoryId)
      .eq("id", id)
      .single(),
  );
}

export async function openConnectorConversationBrowser({
  appUrl,
  supabaseUrl,
  serviceKey,
  proofDir,
  fixture: rawFixture,
  browserExecutablePath,
}: {
  appUrl: string;
  supabaseUrl: string;
  serviceKey: string;
  proofDir: string;
  fixture: unknown;
  browserExecutablePath?: string;
}) {
  const app = loopbackOrigin(appUrl);
  const supabase = loopbackOrigin(supabaseUrl);
  assert.equal(loopbackOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""), supabase);
  assert(serviceKey && process.env.SUPABASE_SECRET_KEY === serviceKey);
  assert(isAbsolute(proofDir), "Use an absolute local qualification evidence directory.");
  const fixture = fixtureSchema.parse(rawFixture);
  assert.notEqual(fixture.workspaceSlug, fixture.outsiderWorkspaceSlug);
  assert.equal(new Set(Object.values(fixture.humans).map(({ userId }) => userId)).size, 3);
  const admin = createClient<Database>(supabase, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await mkdir(proofDir, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({ executablePath: browserExecutablePath });

  async function signIn(actor: z.output<typeof human>, workspace: string) {
    const page = await browser.newPage({
      baseURL: app,
      reducedMotion: "reduce",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 960 },
    });
    await guardConnectorBrowserRequests(page, app, supabase);
    await signInViaMagicLink(page, `/w/${workspace}/sessions`, {
      baseURL: app,
      email: actor.email,
    });
    return page;
  }

  async function parseReview(input: BrowserReviewInput, current: boolean) {
    const url = new URL(input.href);
    assert.equal(url.origin, app, "Provider reply must link to this exact qualification app.");
    assert(!url.username && !url.password && !url.hash);
    assert(sessionReviewReturnPath(url, fixture.workspaceSlug), "Expected an exact review link.");
    const parsed = parseSessionReviewTarget(Object.fromEntries(url.searchParams));
    assert(parsed.kind === "exact" && parsed.target.stageId && !parsed.target.clarificationId);
    const target = {
      ...parsed.target,
      stageId: parsed.target.stageId,
      url,
      sessionId: z.uuid().parse(input.sessionId),
    };
    const session = await readReviewSession(admin, fixture, target.sessionId);
    assert.equal(url.pathname, workspaceSessionDetailPath(fixture.workspaceSlug, session.number));
    if (current) {
      assert.equal(session.phase_status, "awaiting_review");
      assert.equal(target.stageId, session.current_stage_id);
      assert.equal(target.artifactId, session.current_artifact_id);
      assert.equal(target.artifactVersion, session.current_artifact_version);
      assert.equal(target.reviewRevision, session.artifact_review_revision);
    }
    const artifact = await readRow(
      admin
        .from("session_artifacts")
        .select("artifact_json")
        .eq("workspace_id", fixture.workspaceId)
        .eq("session_id", target.sessionId)
        .eq("id", target.artifactId)
        .eq("stage_id", target.stageId)
        .eq("stage_slug", target.stageSlug)
        .eq("version", target.artifactVersion)
        .single(),
    );
    assert.equal(typeof artifact.artifact_json, "string");
    return {
      ...target,
      artifactDigest: createHash("sha256").update(String(artifact.artifact_json)).digest("hex"),
    };
  }

  function approvalBody(target: Awaited<ReturnType<typeof parseReview>>) {
    return {
      action: "approve",
      stageId: target.stageId,
      artifactId: target.artifactId,
      version: target.artifactVersion,
      expectedReviewRevision: target.reviewRevision,
    };
  }

  function readSource(provider: Provider, sessionId: string) {
    return readRow(
      admin
        .from("session_conversation_sources")
        .select("id,external_thread_id,source_url")
        .eq("workspace_id", fixture.workspaceId)
        .eq("factory_id", fixture.factoryId)
        .eq("session_id", sessionId)
        .eq("provider", provider)
        .single(),
    );
  }

  try {
    const owner = await signIn(fixture.humans.owner, fixture.workspaceSlug);
    const reviewer = await signIn(fixture.humans.reviewer, fixture.workspaceSlug);
    const outsider = await signIn(fixture.humans.outsider, fixture.outsiderWorkspaceSlug);
    const capture = (page: Page, name: string) =>
      page.screenshot({
        path: join(proofDir, `${name}.png`),
        fullPage: true,
        animations: "disabled",
      });

    return {
      async verifyGitHubConversation(
        input: BrowserReviewInput & { expectedComment: string; sourceThreadId?: string },
      ) {
        const target = await parseReview(input, true);
        const source = await readSource("github", target.sessionId);
        if (input.sourceThreadId) assert.equal(source.external_thread_id, input.sourceThreadId);
        const messages = await readRow(
          admin
            .from("session_conversation_messages")
            .select("originating_member_id,external_message_id,body_md")
            .eq("workspace_id", fixture.workspaceId)
            .eq("factory_id", fixture.factoryId)
            .eq("session_id", target.sessionId)
            .eq("source_id", source.id)
            .eq("kind", "message"),
        );
        const matching = messages.filter(({ body_md }) =>
          [input.expectedComment, `GitHub comment edited:\n\n${input.expectedComment}`].includes(
            body_md,
          ),
        );
        assert.equal(matching.length, 1);
        assert.equal(matching[0]?.originating_member_id, fixture.humans.owner.memberId);
        assert.match(matching[0]?.external_message_id ?? "", /^github-comment:/);

        await owner.goto(target.url.href);
        const conversation = await openConversation(owner);
        const comment = conversation.getByText(input.expectedComment, { exact: true });
        await expect(comment).toHaveCount(1);
        await expect(comment).toBeVisible();
        assert(source.source_url);
        await expect(
          conversation.getByRole("list", { name: "Conversation sources" }).getByRole("link"),
        ).toHaveAttribute("href", source.source_url);
        await capture(owner, "github-linked-conversation");
      },

      async requestLinearChanges(input: BrowserReviewInput) {
        const target = await parseReview(input, true);
        const source = await readSource("linear", target.sessionId);
        const reviewPath = `/api/sessions/${target.sessionId}/reviews`;
        await owner.goto(target.url.href);
        await expect(owner.getByText("Viewing a linked review.", { exact: true })).toBeVisible();
        const comments = owner.getByRole("button", { name: "Comments", exact: true });
        if ((await comments.getAttribute("aria-expanded")) !== "true") await comments.click();
        const passage = owner
          .getByRole("region", { name: "Artifact text", exact: true })
          .locator("p [data-review-text-start]")
          .first();
        await passage.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
        });
        await passage.dispatchEvent("pointerup");
        await owner.getByRole("button", { name: "Comment on selection", exact: true }).click();
        await owner.getByRole("textbox", { name: "Comment", exact: true }).fill(question);
        const threadRequest = postResponse(owner, reviewPath);
        await owner.getByRole("button", { name: "Save", exact: true }).click();
        const created = await threadRequest;
        assert.equal(
          created.status(),
          200,
          "The linked human could not start an artifact discussion.",
        );
        const { thread } = discussionReceipt.parse(await created.json());
        const threadRow = await readRow(
          admin
            .from("artifact_review_threads")
            .select("artifact_id,artifact_version,stage_id,author_member_id,kind")
            .eq("workspace_id", fixture.workspaceId)
            .eq("session_id", target.sessionId)
            .eq("id", thread.id)
            .single(),
        );
        assert.deepEqual(threadRow, {
          artifact_id: target.artifactId,
          artifact_version: target.artifactVersion,
          stage_id: target.stageId,
          author_member_id: fixture.humans.owner.memberId,
          kind: "discussion",
        });

        const href = await owner
          .getByRole("link", { name: "Thread link", exact: true })
          .getAttribute("href");
        assert(href, "The authored discussion must provide a shareable link.");
        const threadLink = new URL(href, owner.url());
        assert.equal(threadLink.origin, app);
        assert.equal(threadLink.pathname, target.url.pathname);
        assert.equal(threadLink.searchParams.get("reviewThread"), thread.id);
        assert.equal(threadLink.searchParams.get("artifactId"), target.artifactId);
        assert.equal(threadLink.searchParams.get("artifactStage"), target.stageSlug);
        assert.equal(
          threadLink.searchParams.get("artifactVersion"),
          String(target.artifactVersion),
        );
        assert.equal(
          parseSessionReviewTarget(Object.fromEntries(threadLink.searchParams)).kind,
          "ordinary",
        );
        await reviewer.goto(threadLink.href);
        const discussion = reviewer.getByRole("region", { name: "Selected review thread" });
        await expect(discussion.getByText(question, { exact: true })).toBeVisible();
        await discussion.getByRole("textbox", { name: "Reply to thread" }).fill(answer);
        const replyRequest = postResponse(reviewer, `${reviewPath}/${thread.id}/comments`);
        await discussion.getByRole("button", { name: "Reply", exact: true }).click();
        const posted = await replyRequest;
        assert.equal(
          posted.status(),
          200,
          "The second factory human could not answer the discussion.",
        );
        const { comment } = replyReceipt.parse(await posted.json());
        const reply = await readRow(
          admin
            .from("artifact_review_comments")
            .select("author_member_id,body")
            .eq("workspace_id", fixture.workspaceId)
            .eq("thread_id", thread.id)
            .eq("id", comment.id)
            .single(),
        );
        assert.equal(reply.author_member_id, fixture.humans.reviewer.memberId);
        assert.equal(reply.body, answer);
        await expect(discussion.getByText(answer, { exact: true })).toBeVisible();
        await capture(reviewer, "linear-human-discussion");

        await owner.goto(target.url.pathname);
        const session = await readReviewSession(admin, fixture, target.sessionId);
        assert.equal(session.current_artifact_id, target.artifactId);
        await owner.getByRole("button", { name: "Request changes", exact: true }).click();
        const dialog = owner.getByRole("dialog", { name: "Request changes", exact: true });
        await dialog
          .getByRole("textbox", { name: "Feedback for Wallie", exact: true })
          .fill(feedback);
        const followUp = postResponse(owner, `/api/sessions/${target.sessionId}/phase-action`);
        await dialog.getByRole("button", { name: "Queue rerun", exact: true }).click();
        const queued = await followUp;
        assert.equal(queued.status(), 200, "Wallie could not queue the linked human's follow-up.");
        const request = followUpRequest.parse(queued.request().postDataJSON());
        assert.deepEqual(
          [
            request.action,
            request.stageId,
            request.artifactId,
            request.version,
            request.feedbackText,
          ],
          ["reject", target.stageId, target.artifactId, target.artifactVersion, feedback],
        );
        assert.equal(
          request.feedbackSubmission.expectedReviewRevision,
          session.artifact_review_revision,
        );
        const receipt = feedbackReceipt.parse(await queued.json());
        const retained = await readRow(
          admin
            .from("session_conversation_messages")
            .select("artifact_id,originating_member_id,body_md")
            .eq("workspace_id", fixture.workspaceId)
            .eq("factory_id", fixture.factoryId)
            .eq("session_id", target.sessionId)
            .eq("kind", "artifact_feedback")
            .eq("feedback_batch_id", receipt.feedbackBatchId)
            .single(),
        );
        assert.deepEqual(retained, {
          artifact_id: target.artifactId,
          originating_member_id: fixture.humans.owner.memberId,
          body_md: feedback,
        });
        const conversation = await openConversation(owner);
        await expect(conversation.getByText(feedback, { exact: true })).toBeVisible();
        assert(source.source_url);
        await expect(
          conversation.getByRole("list", { name: "Conversation sources" }).getByRole("link"),
        ).toHaveAttribute("href", source.source_url);
        await capture(owner, "linear-retained-follow-up");
        return {
          jobId: receipt.revisionJobId,
          runId: receipt.revisionRunId,
          feedbackBatchId: receipt.feedbackBatchId,
          discussion: {
            threadId: thread.id,
            questionByMemberId: threadRow.author_member_id,
            replyCommentId: comment.id,
            replyByMemberId: reply.author_member_id,
          },
        };
      },

      async approve(input: BrowserReviewInput & { staleHref?: string; artifactDigest?: string }) {
        const target = await parseReview(input, true);
        if (input.artifactDigest) assert.equal(target.artifactDigest, input.artifactDigest);
        const phasePath = `/api/sessions/${target.sessionId}/phase-action`;
        const body = approvalBody(target);
        const [missingConversation, missingReview, foreignApproval] = await Promise.all([
          outsider.request.get(`/api/sessions/${target.sessionId}/conversation`, negativeProbe),
          outsider.request.get(
            `/api/sessions/${target.sessionId}/reviews?artifactId=${target.artifactId}`,
            negativeProbe,
          ),
          outsider.request.post(phasePath, { ...negativeProbe, data: body }),
        ]);
        assert.equal(
          missingConversation.status(),
          404,
          "Another workspace could read the conversation.",
        );
        assert.equal(
          missingReview.status(),
          404,
          "Another workspace could read the artifact review.",
        );
        assert.equal(foreignApproval.status(), 404, "Another workspace could write a review.");

        if (input.staleHref) {
          const stale = await parseReview(
            { sessionId: input.sessionId, href: input.staleHref },
            false,
          );
          assert(stale.artifactVersion < target.artifactVersion);
          await owner.goto(stale.url.href);
          await expect(owner.getByText("This review link is no longer current.")).toBeVisible();
          await expect(
            owner.getByRole("button", { name: "Approve stage", exact: true }),
          ).toHaveCount(0);
          const denied = await owner.request.post(phasePath, {
            ...negativeProbe,
            data: approvalBody(stale),
          });
          assert.equal(denied.status(), 409, "The superseded review target could be approved.");
          await capture(owner, "linear-stale-provider-link");
        }

        await owner.goto(target.url.href);
        await expect(owner.getByText("Viewing a linked review.", { exact: true })).toBeVisible();
        const approval = owner.getByRole("button", { name: "Approve stage", exact: true });
        await expect(approval).toBeEnabled();
        await capture(owner, input.staleHref ? "linear-exact-review" : "github-exact-review");
        const action = postResponse(owner, phasePath);
        await approval.press("Enter");
        const approved = await action;
        assert.equal(
          approved.status(),
          200,
          "The linked human could not approve the exact artifact.",
        );
        assert.deepEqual(approved.request().postDataJSON(), body);
        const receipts = await readRow(
          admin
            .from("session_stage_approval_receipts")
            .select(
              "id,stage_id,artifact_id,artifact_version,artifact_digest,approved_by_member_id",
            )
            .eq("workspace_id", fixture.workspaceId)
            .eq("session_id", target.sessionId)
            .eq("stage_id", target.stageId),
        );
        assert.equal(receipts.length, 1, "Only the current exact target may retain an approval.");
        const [receipt] = receipts;
        assert(receipt);
        assert.equal(receipt.approved_by_member_id, fixture.humans.owner.memberId);
        assert.equal(receipt.artifact_id, target.artifactId);
        assert.equal(receipt.artifact_version, target.artifactVersion);
        assert.equal(receipt.artifact_digest, target.artifactDigest);
        return {
          approvalId: receipt.id,
          sessionId: target.sessionId,
          stageId: receipt.stage_id,
          artifactId: receipt.artifact_id,
          artifactVersion: receipt.artifact_version,
          reviewRevision: target.reviewRevision,
          approvedByMemberId: receipt.approved_by_member_id,
          artifactDigest: receipt.artifact_digest,
        };
      },

      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

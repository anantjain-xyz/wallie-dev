import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { it, vi } from "vitest";
import { z } from "zod/v4";

import { createGitHubConnectorOutboundAdapter } from "@/features/github/connector-outbound";
import { readConnectorSubscription } from "@/lib/connectors/installations";
import { reconcileLinearIssueDiscovery } from "@/lib/connectors/linear-discovery";
import { reconcileLinearLinkedOutcomes } from "@/lib/connectors/linear-outcomes";
import { drainConnectorOutboundDeliveries } from "@/lib/connectors/outbound";
import { applyConnectorSetup } from "@/lib/connectors/setup";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import { exactSessionReviewHref } from "@/lib/sessions/review-link";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import {
  advanceConnectorClock,
  advanceConnectorConformance,
  readConnectorConformance,
  revokeConnectorConformanceActor,
  seedConnectorConformance,
} from "./connector-conformance-oracle";
import {
  githubEditedComment,
  githubIssueId,
  githubIssueNumber,
  githubOriginalComment,
  openConnectorConformanceTransport,
  sendSignedGitHubFixture,
} from "./connector-conformance-transport";
import { openConnectorConversationBrowser } from "./factory-connector-conversation-browser";

const environment = z.object({
  NEXT_PUBLIC_APP_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_WEBHOOK_SECRET: z.string().min(32),
  WALLIE_M13_DATABASE_URL: z.url(),
  WALLIE_M13_PROOF_DIR: z.string().min(1),
  WALLIE_M13_BROWSER_EXECUTABLE_PATH: z.string().optional(),
});

type Provider = "github" | "linear";
type Witness = Awaited<ReturnType<typeof readConnectorConformance>>;
type Checkpoint = Awaited<ReturnType<typeof advanceConnectorConformance>>;

function assertLoopback(value: string, schemes: readonly string[]) {
  const url = new URL(value);
  assert(schemes.includes(url.protocol) && !url.search && !url.hash);
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
}

function exactDelivery(witness: Witness, key: string) {
  const matches = witness.outbox.filter((row) => row.logicalKey === key);
  assert.equal(matches.length, 1, `One durable intent exists for ${key}`);
  return matches[0]!;
}

function exactSession(witness: Witness, provider: Provider) {
  const { session, admissionCount } = witness[provider];
  assert.equal(admissionCount, 1, `Exactly one ${provider} admission`);
  assert(session, `Missing the linked ${provider} session.`);
  return session;
}

function onlyQueuedJob(witness: Witness, provider: Provider) {
  const jobs = exactSession(witness, provider).jobs.filter((job) => job.status === "queued");
  assert.equal(jobs.length, 1, `Exactly one ${provider} job is queued`);
  return jobs[0]!.id;
}

function reviewHref(
  comments: readonly { body: string }[],
  checkpoint: Checkpoint,
  workspaceSlug: string,
  appUrl: string,
) {
  const target = new URL(
    exactSessionReviewHref(workspaceSlug, checkpoint.sessionNumber, {
      ...checkpoint,
      clarificationId: null,
    }),
    appUrl,
  ).href;
  const matches = comments.filter(
    (comment) => /\[Review in Wallie\]\(([^)]+)\)/u.exec(comment.body)?.[1] === target,
  );
  assert.equal(matches.length, 1, "The provider received the exact Wallie review link once.");
  return target;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

it("qualifies signed GitHub and scoped Linear conversation continuity through Wallie", async () => {
  const env = environment.parse(process.env);
  const db = env.WALLIE_M13_DATABASE_URL;
  const appUrl = env.NEXT_PUBLIC_APP_URL;
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  assertLoopback(appUrl, ["http:"]);
  assertLoopback(supabaseUrl, ["http:"]);
  assertLoopback(db, ["postgresql:", "postgres:"]);

  const namespace = String(env.GITHUB_APP_ID);
  const numericNamespace = Number(namespace);
  const linearApiKey = `synthetic-m13-${randomBytes(32).toString("hex")}`;
  const scope = await seedConnectorConformance(db, {
    namespace,
    github: {
      installationId: numericNamespace + 33,
      repositoryId: numericNamespace + 34,
      repositoryName: "connector-fixture/conversation-qualification",
      tenantId: numericNamespace + 90,
      actorId: numericNamespace + 91,
      labelId: numericNamespace + 92,
    },
    linear: {
      tenantId: randomUUID(),
      viewerId: randomUUID(),
      creatorId: randomUUID(),
      teamId: randomUUID(),
      projectId: randomUUID(),
      stateId: randomUUID(),
      toStateId: randomUUID(),
      issueId: randomUUID(),
      labelId: randomUUID(),
      encryptedApiKey: encryptSecretValue(linearApiKey),
    },
  });
  const sourceId = githubIssueId(scope);
  const source = { githubSourceId: sourceId };
  const witness = () => readConnectorConformance(db, scope, source);
  const transport = await openConnectorConformanceTransport({
    scope,
    appId: env.GITHUB_APP_ID,
    appUrl,
    supabaseUrl,
    linearApiKey,
  });
  vi.stubGlobal("fetch", transport.fetch);
  let browser: Awaited<ReturnType<typeof openConnectorConversationBrowser>> | undefined;
  try {
    const admin = createSupabaseAdminClient();
    const request = (event: "issues" | "issue_comment", payload: unknown, deliveryId?: string) =>
      sendSignedGitHubFixture(appUrl, env.GITHUB_WEBHOOK_SECRET, event, payload, deliveryId);
    const githubSweep = () =>
      drainConnectorOutboundDeliveries(admin, createGitHubConnectorOutboundAdapter(admin));
    const linearSweep = () => reconcileLinearLinkedOutcomes(admin);
    const pollLinear = () =>
      reconcileLinearIssueDiscovery(admin, { workspaceId: scope.workspaceId });
    const githubActor = { id: scope.github.actorId, type: "User" };
    const githubEnvelope = {
      installation: { id: scope.github.installationId },
      repository: { id: scope.github.repositoryId, owner: { id: scope.github.tenantId } },
      sender: githubActor,
    };
    const eventTime = Date.now() + 1_000;
    const issue = { id: sourceId, number: githubIssueNumber };
    const work = {
      ...githubEnvelope,
      action: "labeled",
      label: { id: scope.github.labelId },
      issue: {
        ...issue,
        state: "open",
        updated_at: new Date(eventTime).toISOString(),
        title: "Synthetic GitHub connector qualification",
        body: "Synthetic intake body must stay in Wallie.",
      },
    };
    await sendSignedGitHubFixture(
      appUrl,
      env.GITHUB_WEBHOOK_SECRET,
      "issues",
      work,
      undefined,
      false,
    );
    assert.equal((await witness()).totalSessions, 0, "Bad signatures cannot admit work.");
    const firstWorkDelivery = await request("issues", work);
    await request("issues", work, firstWorkDelivery);
    const staleWorkDelivery = await request("issues", work);

    const commentId = sourceId + 1;
    const comment = (action: "created" | "edited", body: string, tick: number) => ({
      ...githubEnvelope,
      action,
      issue,
      comment: {
        id: commentId,
        user: githubActor,
        body,
        updated_at: new Date(eventTime + tick).toISOString(),
      },
    });
    const original = comment("created", githubOriginalComment, 2_000);
    const edited = comment("edited", githubEditedComment, 4_000);
    const createdId = await request("issue_comment", original);
    const revisedId = await request("issue_comment", edited);
    await request("issue_comment", original, createdId);
    await request("issue_comment", edited, revisedId);
    const reorderedId = await request(
      "issue_comment",
      comment("edited", "An older delivery cannot overwrite the accepted edit.", 3_000),
    );
    const unauthorizedBody = "A revoked identity cannot append to the conversation.";

    const firstPoll = await pollLinear();
    transport.assertHealthy();
    assert.deepEqual(firstPoll, { admitted: 0, rateLimited: false });
    assert.equal(
      (await witness()).linear.admissionCount,
      0,
      "An unlinked Linear creator cannot admit work.",
    );
    await advanceConnectorClock(db, scope, { kind: "linear-discovery" });
    transport.selectDiscoveryPage("original");
    assert.deepEqual(await pollLinear(), { admitted: 1, rateLimited: false });
    const originalLinear = exactSession(await witness(), "linear");
    await advanceConnectorClock(db, scope, { kind: "linear-discovery" });
    transport.selectDiscoveryPage("reordered");
    assert.deepEqual(await pollLinear(), { admitted: 0, rateLimited: false });
    transport.assertHealthy();

    const admitted = await witness();
    assert.equal(admitted.totalSessions, 2);
    const githubSession = exactSession(admitted, "github");
    const linearSession = exactSession(admitted, "linear");
    assert.equal(githubSession.threadId, `issue:${sourceId}`);
    assert.equal(githubSession.actorLinkId, scope.github.actorLinkId);
    assert.equal(linearSession.threadId, scope.linear.issueId);
    assert.equal(linearSession.actorLinkId, scope.linear.actorLinkId);
    assert.equal(linearSession.sessionId, originalLinear.sessionId);
    assert.equal(linearSession.jobs.length, 1);
    assert.equal(admitted.linear.origin?.spanId, transport.originalSpan.id);
    assert.equal(admitted.linear.origin?.stateId, scope.linear.stateId);
    assert.equal(admitted.linear.origin?.teamId, scope.linear.teamId);
    assert.equal(admitted.linear.origin?.projectId, scope.linear.projectId);
    assert.deepEqual(transport.discoveryPages, ["foreign-actor", "original", "reordered"]);
    assert.equal(admitted.github.receipts.length, 2);
    assert.equal(
      admitted.github.receipts.find(({ id }) => id === firstWorkDelivery)?.disposition,
      "admitted",
    );
    assert.equal(
      admitted.github.receipts.find(({ id }) => id === staleWorkDelivery)?.disposition,
      "stale",
    );
    assert.deepEqual(
      admitted.github.messages.map(({ memberId, actorId, bodyHash }) => ({
        memberId,
        actorId,
        bodyHash,
      })),
      [githubOriginalComment, `GitHub comment edited:\n\n${githubEditedComment}`].map((body) => ({
        memberId: scope.ownerMemberId,
        actorId: String(scope.github.actorId),
        bodyHash: sha256(body),
      })),
    );
    assert.equal(
      admitted.github.commentReceipts.find(({ id }) => id === reorderedId)?.result,
      "stale",
    );
    assert.equal(admitted.github.commentReceipts.length, 3);
    assert.equal(
      admitted.github.commentReceipts.find(({ id }) => id === createdId)?.result,
      "appended",
    );
    assert.equal(
      admitted.github.commentReceipts.find(({ id }) => id === revisedId)?.result,
      "appended",
    );

    const recovery = [];
    for (const [provider, sweep] of [
      ["github", githubSweep],
      ["linear", linearSweep],
    ] as const) {
      const key = `${provider}:accepted`;
      await sweep();
      transport.assertHealthy();
      const uncertain = exactDelivery(await witness(), key);
      assert.equal(uncertain.status, "unknown");
      assert.equal(uncertain.attempts, 1);
      assert.equal(uncertain.observationAttempts, 0);
      assert.equal(uncertain.uncertain, true);
      assert.equal(transport.writes.filter(({ intentId }) => intentId === uncertain.id).length, 1);

      const scopedResource = {
        workspaceId: scope.workspaceId,
        factoryId: scope.factoryId,
        resourceId: scope[provider].resourceId,
      };
      const subscription = await readConnectorSubscription(admin, scopedResource);
      assert(subscription);
      const setupScope = {
        p_workspace_id: scope.workspaceId,
        p_factory_id: scope.factoryId,
        p_actor_user_id: scope.ownerUserId,
      };
      const disconnectedGeneration = subscription.installation_generation + 1;
      assert.deepEqual(
        await applyConnectorSetup(admin, setupScope, {
          action: "disconnect",
          installationId: subscription.installation_id,
          expectedGeneration: subscription.installation_generation,
        }),
        { disconnected: true },
      );
      assert.equal(await readConnectorSubscription(admin, scopedResource), null);
      await advanceConnectorClock(db, scope, { kind: "outbox", deliveryId: uncertain.id });
      await sweep();
      transport.assertHealthy();
      const blocked = exactDelivery(await witness(), key);
      assert.equal(blocked.id, uncertain.id);
      assert.equal(blocked.status, "blocked");
      assert.equal(blocked.deadlineAt, uncertain.deadlineAt);
      assert.equal(blocked.uncertain, true);
      assert.deepEqual(blocked.attemptReceipts, uncertain.attemptReceipts);
      assert.equal(transport.writes.filter(({ intentId }) => intentId === blocked.id).length, 1);
      assert.equal(transport.observed[provider], 0);
      const blockedDiagnostic = await admin.rpc("read_connector_outbound_delivery", {
        p_workspace_id: scope.workspaceId,
        p_factory_id: scope.factoryId,
        p_delivery_id: blocked.id,
      });
      if (blockedDiagnostic.error) throw blockedDiagnostic.error;
      assert.equal(blockedDiagnostic.data.length, 1);
      assert.equal(blockedDiagnostic.data[0]?.last_result, "credential_unavailable");

      const reconnected = await applyConnectorSetup(admin, setupScope, {
        action: "connect",
        provider,
        expectedTenantId: String(scope[provider].tenantId),
        expectedGeneration: disconnectedGeneration,
      });
      transport.assertHealthy();
      assert.deepEqual(reconnected, {
        installationId: subscription.installation_id,
        generation: disconnectedGeneration + 1,
      });
      const restored = await readConnectorSubscription(admin, scopedResource);
      assert(restored);
      assert.equal(restored.installation_generation, disconnectedGeneration + 1);
      assert.equal(restored.mapping_revision, subscription.mapping_revision);

      await advanceConnectorClock(db, scope, { kind: "outbox", deliveryId: uncertain.id });
      await sweep();
      transport.assertHealthy();
      const recovered = exactDelivery(await witness(), key);
      assert.equal(recovered.id, uncertain.id);
      assert.equal(recovered.status, "delivered");
      assert.equal(recovered.attempts, 1);
      assert.equal(recovered.observationAttempts, 1);
      assert.equal(recovered.uncertain, false);
      assert.equal(recovered.deadlineAt, uncertain.deadlineAt);
      assert.deepEqual(
        recovered.attemptReceipts.map(({ mode, result }) => ({ mode, result })),
        [
          { mode: "sending", result: "uncertain" },
          { mode: "observing", result: "found" },
        ],
      );
      assert(
        recovered.attemptReceipts.every(({ authorizedAt, settledAt }) => authorizedAt && settledAt),
      );
      assert.equal(
        recovered.providerReplyId,
        (provider === "github" ? transport.githubComments : transport.linearComments)[0]?.id,
      );
      assert.equal(transport.observed[provider], 1);
      assert.equal(transport.writes.filter(({ intentId }) => intentId === recovered.id).length, 1);
      recovery.push({
        provider,
        installationId: subscription.installation_id,
        initialGeneration: subscription.installation_generation,
        disconnectedGeneration,
        restoredGeneration: restored.installation_generation,
        uncertain,
        blocked,
        blockedReason: blockedDiagnostic.data[0]?.last_result,
        recovered,
      });
    }

    await revokeConnectorConformanceActor(db, scope, "github");
    const revokedId = await request("issue_comment", comment("edited", unauthorizedBody, 5_000));
    const revoked = await witness();
    assert.equal(revoked.github.actorRevoked, true);
    assert.deepEqual(revoked.github.messages, admitted.github.messages);
    assert(!revoked.github.commentReceipts.some(({ id }) => id === revokedId));

    const advancedGitHub = await advanceConnectorConformance(db, scope, {
      ...source,
      provider: "github",
      jobId: onlyQueuedJob(revoked, "github"),
      artifactVersion: 1,
    });
    const advancedLinear = await advanceConnectorConformance(db, scope, {
      ...source,
      provider: "linear",
      jobId: onlyQueuedJob(revoked, "linear"),
      artifactVersion: 1,
    });
    await githubSweep();
    await linearSweep();
    transport.assertHealthy();
    const githubHref = reviewHref(
      transport.githubComments,
      advancedGitHub,
      scope.workspaceSlug,
      appUrl,
    );
    const linearHref = reviewHref(
      transport.linearComments,
      advancedLinear,
      scope.workspaceSlug,
      appUrl,
    );

    browser = await openConnectorConversationBrowser({
      appUrl,
      supabaseUrl,
      serviceKey: env.SUPABASE_SECRET_KEY,
      proofDir: env.WALLIE_M13_PROOF_DIR,
      fixture: scope,
      browserExecutablePath: env.WALLIE_M13_BROWSER_EXECUTABLE_PATH,
    });
    await browser.verifyGitHubConversation({
      sessionId: githubSession.sessionId,
      href: githubHref,
      expectedComment: githubEditedComment,
      sourceThreadId: githubSession.threadId,
    });
    const githubApproval = await browser.approve({
      sessionId: githubSession.sessionId,
      href: githubHref,
    });
    const requestChanges = await browser.requestLinearChanges({
      sessionId: linearSession.sessionId,
      href: linearHref,
    });
    const requested = exactSession(await witness(), "linear");
    assert(
      requested.mutations.some(
        (mutation) =>
          mutation.operation === "follow_up" &&
          mutation.jobId === requestChanges.jobId &&
          mutation.runId === requestChanges.runId &&
          mutation.feedbackBatchId === requestChanges.feedbackBatchId,
      ),
    );
    const revisedLinear = await advanceConnectorConformance(db, scope, {
      ...source,
      provider: "linear",
      jobId: requestChanges.jobId,
      artifactVersion: 2,
    });
    await linearSweep();
    transport.assertHealthy();
    const revisedHref = reviewHref(
      transport.linearComments,
      revisedLinear,
      scope.workspaceSlug,
      appUrl,
    );
    const linearApproval = await browser.approve({
      sessionId: linearSession.sessionId,
      href: revisedHref,
      staleHref: linearHref,
    });

    await githubSweep();
    await linearSweep();
    transport.assertHealthy();
    const complete = await witness();
    assert.equal(complete.totalSessions, 2);
    for (const [provider, approval] of [
      ["github", githubApproval],
      ["linear", linearApproval],
    ] as const) {
      const session = exactSession(complete, provider);
      assert.equal(session.phaseStatus, "approved");
      assert.equal(session.approvals.length, 1);
      assert.equal(session.approvals[0]?.id, approval.approvalId);
      assert.equal(session.approvals[0]?.artifactId, approval.artifactId);
      assert.equal(session.approvals[0]?.memberId, approval.approvedByMemberId);
      assert.equal(exactDelivery(complete, `${provider}:approved`).status, "delivered");
    }
    assert.equal(exactDelivery(complete, "linear:approved-status").status, "delivered");
    assert.equal(transport.statusWrites, 1);
    assert.equal(transport.linearStateId, scope.linear.toStateId);
    assert.equal(transport.githubComments.length, 3, "One GitHub reply per milestone");
    assert.equal(transport.linearComments.length, 4, "One Linear reply per milestone and artifact");
    assert.equal(
      new Set(transport.writes.map(({ intentId }) => intentId)).size,
      transport.writes.length,
    );
    const providerWrites = transport.writes.length;
    await githubSweep();
    await linearSweep();
    transport.assertHealthy();
    assert.equal(transport.writes.length, providerWrites);
    assert.equal(transport.statusWrites, 1);
    await writeFile(
      join(env.WALLIE_M13_PROOF_DIR, "connector-continuity.json"),
      JSON.stringify(
        {
          namespace,
          github: { sourceId, reviewHref: githubHref, approval: githubApproval },
          linear: {
            issueId: scope.linear.issueId,
            firstReviewHref: linearHref,
            reviewHref: revisedHref,
            requestChanges,
            approval: linearApproval,
          },
          database: complete,
          recovery,
          provider: {
            discoveryPages: transport.discoveryPages,
            writes: transport.writes,
            observations: transport.observed,
            statusWrites: transport.statusWrites,
            linearStateId: transport.linearStateId,
          },
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  } finally {
    vi.unstubAllGlobals();
    await Promise.all([browser?.close(), transport.close()]);
  }
}, 180_000);

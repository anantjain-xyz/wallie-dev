import assert from "node:assert/strict";
import { dirname, isAbsolute, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { chromium, type Page } from "playwright-core";
import { z } from "zod";

import { workflowInspectionSchema } from "@/lib/factory-workflows/inspection-contracts";
import { workspaceRunDetailPath, workspaceSessionDetailPath } from "@/lib/routes";
import type { Database } from "@/lib/supabase/database.types";

import { createBrowserNativeFixture } from "./factory-workflow-qualification-browser-native";

import { signInViaMagicLink } from "../../e2e/helpers/auth";

const uuid = z.string().uuid();
const positive = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const fixtureSchema = z.object({
  workspaceId: uuid,
  workspaceSlug: z.string(),
  factoryId: uuid,
  ownerEmail: z.string().email(),
  outsiderEmail: z.string().email(),
  outsiderWorkspaceSlug: z.string(),
  baseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  preparationStageIds: uuid.array().nonempty(),
  workflow: z.object({ workflowId: uuid, activationId: uuid, graphRevisionId: uuid }),
});
const reviewTarget = z.object({
  sessionId: uuid,
  sessionNumber: positive,
  stageId: uuid,
  stageSlug: z.string(),
  artifactId: uuid,
  artifactVersion: positive,
  reviewRevision: z.number().int().nonnegative(),
});
const reviewSchema = z.object({
  serial: reviewTarget,
  graph: z.object({
    root: reviewTarget,
    child: z.object({ sessionId: uuid, runId: uuid }),
    join: z.object({ id: uuid, runId: uuid }),
    review: z.object({ receiptId: uuid, runId: uuid, commitSha: sha, treeSha: sha }),
    validation: z.object({
      sessionId: uuid,
      runId: uuid,
      commitSha: sha,
      treeSha: sha,
      requiredEvidenceKey: z.string().min(1),
      repositoryId: uuid.optional(),
    }),
    historicalAttemptRunId: uuid.optional(),
    otherApprovalArtifactId: uuid.optional(),
  }),
});
const admittedSession = z.object({
  sessionId: uuid,
  sessionNumber: positive,
  jobId: uuid,
  runId: uuid,
});
const admissionsSchema = z.object({ serial: admittedSession, graph: admittedSession });
const sessionReceipt = z.object({
  canonicalUrl: z.string(),
  number: positive,
  processScheduled: z.literal(true),
});
const validationReceipt = z.object({
  evidence: z.array(
    z.object({
      run_id: uuid,
      session_id: uuid,
      repository_id: uuid.nullish(),
      commit_sha: sha,
      validation_tree_sha: sha,
      records: z.array(z.object({ key: z.string(), status: z.string() })),
    }),
  ),
});

type Fixture = z.output<typeof fixtureSchema>;
type Review = z.output<typeof reviewSchema>;
type Admin = SupabaseClient<Database>;
type Projection = z.output<typeof workflowInspectionSchema>;

function loopback(value: string | undefined) {
  const url = new URL(value ?? "");
  assert(
    url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/",
    "The browser qualification requires loopback origins.",
  );
  return url.origin;
}

async function row<T>(operation: PromiseLike<{ data: T; error: unknown }>) {
  const { data, error } = await operation;
  if (error) throw error;
  assert(data !== null, "Browser qualification fixture row is missing.");
  return data;
}

function postResponse(page: Page, path: string) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === "POST",
  );
}

async function admitSession(page: Page, admin: Admin, fixture: Fixture, compiled: boolean) {
  await page.goto(`/w/${fixture.workspaceSlug}/sessions?factory=${fixture.factoryId}`);
  await page.getByRole("button", { name: "New session", exact: true }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Start a new session" });
  const picker = dialog.getByRole("combobox", { name: "Workflow", exact: true });
  await picker.waitFor();
  const workflow = compiled
    ? {
        workflowId: fixture.workflow.workflowId,
        activationId: fixture.workflow.activationId,
      }
    : undefined;
  if (workflow) {
    await picker.press("Enter");
    const list = page.getByRole("listbox");
    await list.waitFor();
    const options = await list
      .getByRole("option")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-value")));
    const index = options.indexOf(workflow.activationId);
    assert(index >= 0, "The exact qualification activation must be selectable.");
    await page.keyboard.press("Home");
    for (let offset = 0; offset < index; offset++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    assert.equal(await picker.getAttribute("data-value"), workflow.activationId);
  } else {
    assert.equal(await picker.getAttribute("data-value"), "");
  }
  const title = compiled ? "Qualify scoped fix workflow" : "Qualify ordinary serial workflow";
  await dialog.getByRole("textbox", { name: "Title (optional)", exact: true }).fill(title);
  await dialog
    .getByRole("textbox", { name: "Prompt", exact: true })
    .fill("Retain the exact validation and reviewer receipts for this run.");
  const admission = postResponse(page, "/api/sessions");
  await dialog.getByRole("button", { name: "Start session", exact: true }).press("Enter");
  const response = await admission;
  assert.equal(response.status(), 201, "Browser session creation failed.");
  const request = response.request().postDataJSON();
  assert.equal(request.factoryDefinitionDigest, fixture.baseDigest);
  assert.deepEqual(request.selectedStageIds, fixture.preparationStageIds);
  assert.deepEqual(request.workflowSelection, workflow);
  const receipt = sessionReceipt.parse(await response.json());
  assert.equal(
    receipt.canonicalUrl,
    workspaceSessionDetailPath(fixture.workspaceSlug, receipt.number),
  );

  const session = await row(
    admin
      .from("sessions")
      .select("id,current_stage_id,execute_pinned_definition")
      .eq("number", receipt.number)
      .eq("workspace_id", fixture.workspaceId)
      .eq("factory_id", fixture.factoryId)
      .single(),
  );
  assert.equal(session.current_stage_id, fixture.preparationStageIds[0]);
  assert.equal(session.execute_pinned_definition, true);
  const job = await row(
    admin
      .from("agent_jobs")
      .select("id")
      .eq("session_id", session.id)
      .eq("workspace_id", fixture.workspaceId)
      .eq("status", "queued")
      .single(),
  );
  const run = await row(
    admin
      .from("agent_runs")
      .select("id")
      .eq("agent_job_id", job.id)
      .eq("session_id", session.id)
      .eq("workspace_id", fixture.workspaceId)
      .eq("status", "queued")
      .single(),
  );
  return { sessionId: session.id, sessionNumber: receipt.number, jobId: job.id, runId: run.id };
}

async function readProjection(page: Page, sessionId: string, runId?: string) {
  const query = new URLSearchParams();
  if (runId) query.set("runId", runId);
  const events: Projection["events"] = [];
  const cursors = new Set<string>();
  let root: Projection["root"] | undefined;
  for (let next = true; next; ) {
    const response = await page.request.get(
      `/api/sessions/${sessionId}/workflow-inspection?${query}`,
    );
    assert.equal(response.status(), 200, "The signed-in inspection request failed.");
    const projection = workflowInspectionSchema.parse(await response.json());
    assert.equal(projection.subject.sessionId, sessionId);
    assert.equal(projection.subject.runId, runId ?? null);
    if (root) assert.deepEqual(projection.root, root);
    root = projection.root;
    events.push(...projection.events);
    const cursor = projection.nextCursor;
    next = cursor !== null;
    if (cursor) {
      assert(
        !cursors.has(cursor) && cursors.size < 60,
        "History exceeded its bounded receipt window.",
      );
      cursors.add(cursor);
      query.set("cursor", cursor);
    }
  }
  assert(root);
  return { root, events };
}

async function approveExact(page: Page, fixture: Fixture, target: z.output<typeof reviewTarget>) {
  await page.goto(
    workspaceSessionDetailPath(fixture.workspaceSlug, target.sessionNumber, {
      artifactStage: target.stageSlug,
      artifactId: target.artifactId,
      artifactVersion: target.artifactVersion,
      reviewStageId: target.stageId,
      reviewRevision: target.reviewRevision,
    }),
  );
  const approval = postResponse(page, `/api/sessions/${target.sessionId}/phase-action`);
  const button = page.getByRole("button", { name: "Approve stage", exact: true });
  await expect(button).toBeEnabled();
  await button.press("Enter");
  const response = await approval;
  assert.equal(response.status(), 200, "Ordinary exact approval failed.");
  assert.deepEqual(response.request().postDataJSON(), {
    action: "approve",
    stageId: target.stageId,
    artifactId: target.artifactId,
    version: target.artifactVersion,
    expectedReviewRevision: target.reviewRevision,
  });
}

async function confirmApproval(
  admin: Admin,
  fixture: Fixture,
  target: z.output<typeof reviewTarget>,
) {
  const approval = await row(
    admin
      .from("session_stage_approval_receipts")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("session_id", target.sessionId)
      .eq("artifact_id", target.artifactId)
      .eq("stage_id", target.stageId)
      .eq("artifact_version", target.artifactVersion)
      .single(),
  );
  return approval.id;
}

async function reviewWorkflow({
  owner,
  outsider,
  admin,
  fixture,
  review,
  proofDir,
}: {
  owner: Page;
  outsider: Page;
  admin: Admin;
  fixture: Fixture;
  review: Review;
  proofDir: string;
}) {
  const { serial, graph } = review;
  const graphPath = workspaceSessionDetailPath(fixture.workspaceSlug, graph.root.sessionNumber);
  const disclosure = (page: Page) => page.getByRole("button", { name: "Workflow", exact: true });
  await owner.goto(workspaceSessionDetailPath(fixture.workspaceSlug, serial.sessionNumber));
  await owner.getByRole("button", { name: "Approve stage", exact: true }).waitFor();
  assert.equal(await disclosure(owner).count(), 0);
  assert.equal(
    (await owner.request.get(`/api/sessions/${serial.sessionId}/workflow-inspection`)).status(),
    404,
  );
  await owner.screenshot({ path: join(proofDir, "serial-exact-review.png"), fullPage: true });
  await approveExact(owner, fixture, serial);
  const serialApprovalId = await confirmApproval(admin, fixture, serial);

  await owner.goto(graphPath);
  await disclosure(owner).click();
  await owner.getByText("Review passed", { exact: true }).first().waitFor();
  await owner.getByText("Awaiting human approval", { exact: true }).first().waitFor();
  const before = await readProjection(owner, graph.root.sessionId);
  assert.equal(before.root.workspaceId, fixture.workspaceId);
  assert.equal(before.root.factoryId, fixture.factoryId);
  assert.equal(before.root.activationId, fixture.workflow.activationId);
  assert.equal(before.root.graphRevisionId, fixture.workflow.graphRevisionId);
  assert(
    before.events.some(
      (event) =>
        event.kind === "join" &&
        event.detail.joinId === graph.join.id &&
        event.detail.runId === graph.join.runId &&
        event.detail.wholeJoinComplete &&
        event.detail.selectedOutcomeIds?.length === 2 &&
        event.detail.artifactId === graph.root.artifactId,
    ),
    "The exact joined parent output is missing.",
  );
  assert(
    before.events.some(
      (event) =>
        event.kind === "review" &&
        event.state === "pass" &&
        event.detail.reviewReceiptId === graph.review.receiptId &&
        event.detail.runId === graph.review.runId &&
        event.detail.commitSha === graph.review.commitSha &&
        event.detail.validationTreeSha === graph.review.treeSha,
    ),
    "The exact review receipt is missing.",
  );
  assert(
    before.events.some(
      (event) =>
        event.kind === "artifact" &&
        event.detail.sessionId === graph.root.sessionId &&
        event.detail.artifactId === graph.root.artifactId &&
        event.detail.approvalState === "awaiting_review",
    ),
  );
  assert(
    !before.events.some(
      (event) => event.kind === "approval" && event.detail.artifactId === graph.root.artifactId,
    ),
  );
  if (graph.otherApprovalArtifactId)
    assert(
      before.events.some(
        (event) =>
          event.kind === "approval" && event.detail.artifactId === graph.otherApprovalArtifactId,
      ),
      "Other approval should not authorize the joined parent.",
    );
  if (graph.historicalAttemptRunId)
    assert(
      before.events.some(
        (event) =>
          event.kind === "attempt" &&
          event.detail.runId === graph.historicalAttemptRunId &&
          event.detail.retired &&
          !event.detail.current,
      ),
      "Expected the old attempt to remain visible as retired.",
    );

  const checked = await owner.request.get(
    `/api/sessions/${graph.validation.sessionId}/validation-evidence?runId=${graph.validation.runId}`,
  );
  assert.equal(checked.status(), 200, "The run-bound validation evidence is unavailable.");
  const validation = validationReceipt.parse(await checked.json()).evidence;
  assert(
    validation.some(
      (evidence) =>
        evidence.session_id === graph.validation.sessionId &&
        evidence.run_id === graph.validation.runId &&
        evidence.commit_sha === graph.validation.commitSha &&
        evidence.validation_tree_sha === graph.validation.treeSha &&
        evidence.records.some(
          (record) =>
            record.key === graph.validation.requiredEvidenceKey && record.status === "passed",
        ),
    ),
    "Expected the validation receipt for the precise run, commit and tree.",
  );
  if (graph.validation.repositoryId) {
    assert(
      before.events.some(
        (event) =>
          event.kind === "repository" &&
          event.detail.repositoryId === graph.validation.repositoryId &&
          event.detail.validationRunId === graph.validation.runId &&
          event.detail.validationTreeSha === graph.validation.treeSha,
      ),
    );
  }

  await owner.screenshot({ path: join(proofDir, "compiled-parent-review.png"), fullPage: true });
  const runPath = workspaceRunDetailPath(fixture.workspaceSlug, graph.child.runId);
  const childLink = owner.locator(`a[href="${runPath}"]`).first();
  const older = owner.getByRole("button", { name: "Load older events", exact: true });
  for (
    let index = 0;
    index < 60 && !(await childLink.isVisible()) && (await older.isVisible());
    index++
  ) {
    const loaded = owner.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === `/api/sessions/${graph.root.sessionId}/workflow-inspection` &&
        url.searchParams.has("cursor")
      );
    });
    await older.click();
    assert.equal((await loaded).status(), 200);
    await owner
      .getByRole("button", { name: "Loading older events…", exact: true })
      .waitFor({ state: "hidden" });
  }
  await childLink.click();
  await owner.waitForURL((url) => url.pathname === runPath);
  const child = await readProjection(owner, graph.child.sessionId, graph.child.runId);
  assert.equal(child.root.sessionId, graph.root.sessionId);
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await disclosure(owner).click();
  await owner.getByRole("region", { name: "Workflow inspection", exact: true }).waitFor();
  await owner.getByText("Review passed", { exact: true }).first().waitFor();
  assert(
    await owner.evaluate(() => document.documentElement.scrollWidth === window.innerWidth),
    "Mobile workflow inspection overflows.",
  );
  await owner.screenshot({
    path: join(proofDir, "compiled-exact-child-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    (
      await outsider.request.get(`/api/sessions/${graph.root.sessionId}/workflow-inspection`)
    ).status(),
    404,
  );
  assert.equal(
    (
      await outsider.request.get(
        `/api/sessions/${graph.child.sessionId}/workflow-inspection?runId=${graph.child.runId}`,
      )
    ).status(),
    404,
  );

  await outsider.goto(runPath);
  assert.equal(await disclosure(outsider).count(), 0);

  await approveExact(owner, fixture, graph.root);
  const parentApprovalId = await confirmApproval(admin, fixture, graph.root);
  const after = await readProjection(owner, graph.root.sessionId);
  assert(
    after.events.some(
      (event) =>
        event.kind === "approval" &&
        event.id === parentApprovalId &&
        event.detail.artifactId === graph.root.artifactId &&
        event.detail.artifactVersion === graph.root.artifactVersion,
    ),
  );
  return {
    serialApprovalId,
    parentApprovalId,
    reviewedRunId: graph.review.runId,
    validationRunId: graph.validation.runId,
    exactChildRunId: graph.child.runId,
  };
}

async function main() {
  const phase = process.argv[2];
  assert(
    phase === "admit" || phase === "review" || phase === "qualify",
    "Choose the admit, review or qualify browser phase.",
  );
  const app = loopback(process.env.WALLIE_M11_APP_URL);
  const supabase = loopback(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const witnessPath = process.env.WALLIE_M11_WITNESS_PATH;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  assert(
    witnessPath && isAbsolute(witnessPath) && serviceKey,
    "The local witness and service key are required.",
  );
  const proofDir = dirname(witnessPath);
  const admissionsPath = join(proofDir, "browser-admissions.json");
  const reviewPath = join(proofDir, "browser-review.json");
  const fixturePath = join(proofDir, "browser-fixture.json");
  const admin = createClient<Database>(supabase, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const native =
    phase === "qualify"
      ? createBrowserNativeFixture(admin, process.env.WALLIE_M11_BROWSER_DATABASE_URL)
      : undefined;
  const browser = await chromium.launch();
  try {
    const rawFixture = native
      ? await native.prepare()
      : JSON.parse(await readFile(fixturePath, "utf8"));
    const fixture = fixtureSchema.parse(rawFixture);
    if (native) await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
    assert.notEqual(fixture.workspaceSlug, fixture.outsiderWorkspaceSlug);
    const owner = await browser.newPage({
      baseURL: app,
      viewport: { width: 1440, height: 960 },
      reducedMotion: "reduce",
    });
    await signInViaMagicLink(owner, `/w/${fixture.workspaceSlug}/sessions`, {
      baseURL: app,
      email: fixture.ownerEmail,
    });
    if (phase !== "review") {
      const serial = await admitSession(owner, admin, fixture, false);
      const graph = await admitSession(owner, admin, fixture, true);
      await writeFile(admissionsPath, JSON.stringify(admissionsSchema.parse({ serial, graph })), {
        mode: 0o600,
      });
      if (native)
        await writeFile(
          reviewPath,
          JSON.stringify(reviewSchema.parse(native.advance(serial, graph))),
          { mode: 0o600 },
        );
      else return;
    }
    const admitted = admissionsSchema.parse(JSON.parse(await readFile(admissionsPath, "utf8")));
    const review = reviewSchema.parse(JSON.parse(await readFile(reviewPath, "utf8")));
    assert.equal(review.serial.sessionId, admitted.serial.sessionId);
    assert.equal(review.serial.sessionNumber, admitted.serial.sessionNumber);
    assert.equal(review.graph.root.sessionId, admitted.graph.sessionId);
    assert.equal(review.graph.root.sessionNumber, admitted.graph.sessionNumber);
    const outsider = await browser.newPage({ baseURL: app });
    await signInViaMagicLink(outsider, `/w/${fixture.outsiderWorkspaceSlug}/sessions`, {
      baseURL: app,
      email: fixture.outsiderEmail,
    });
    const proof = await reviewWorkflow({ owner, outsider, admin, fixture, review, proofDir });
    await writeFile(join(proofDir, "browser-proof.json"), JSON.stringify(proof), { mode: 0o600 });
  } finally {
    await browser.close();
    await native?.restoreRelease();
  }
}

void main();

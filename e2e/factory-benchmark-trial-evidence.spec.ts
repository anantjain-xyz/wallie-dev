import { createHash, randomUUID } from "node:crypto";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { benchmarkComparisonSchema } from "@/lib/factory-benchmarks/comparison-contracts";
import { checked, seedBenchmarkResults } from "./helpers/factory-benchmark-results";
import { signInViaMagicLink } from "./helpers/auth";

const mediaBucket = "session-validation-evidence";
const inputHtml = '<main data-testid="invoice"><h1>Invoice pending</h1></main>';
const outputHtml =
  '<main data-testid="invoice"><h1>Invoice reconciled</h1><p>Total $24.00</p></main>';

function gitObjectHash(kind: "blob" | "tree" | "commit", bytes: Buffer) {
  return createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
}

function fixtureCommit(html: string, parent?: string) {
  const blob = gitObjectHash("blob", Buffer.from(`${html}\n`));
  const tree = gitObjectHash(
    "tree",
    Buffer.concat([Buffer.from("100644 fixture.html\0"), Buffer.from(blob, "hex")]),
  );
  const headers = [
    `tree ${tree}`,
    ...(parent ? [`parent ${parent}`] : []),
    "author Browser Fixture <fixture@example.test> 1700000000 +0000",
    "committer Browser Fixture <fixture@example.test> 1700000000 +0000",
  ];
  return {
    tree,
    commit: gitObjectHash("commit", Buffer.from(`${headers.join("\n")}\n\nInvoice fixture\n`)),
  };
}

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled", caret: "hide" });
  await info.attach(name, { path, contentType: "image/png" });
}

test("refreshing an active benchmark trial updates its transcript and status", async ({
  baseURL,
  page,
}) => {
  test.skip(
    process.env.WALLIE_FACTORY_BENCHMARKS_E2E !== "1",
    "Requires disposable local Supabase.",
  );
  const fixture = await seedBenchmarkResults(baseURL);
  const { admin, experimentId, factoryId, workspaceId } = fixture;
  try {
    expect(checked(await admin.rpc("reconcile_factory_benchmark_schedules", { p_limit: 10 }))).toBe(
      1,
    );
    const admitted = checked(
      await admin
        .from("factory_benchmark_trials")
        .select("id,job_id")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .eq("status", "queued")
        .single(),
    );
    const [claim] = checked(
      await admin.rpc("claim_next_agent_job", {
        accept_benchmark_trials: true,
        default_concurrency_limit: 4,
        p_worker_runtime: "node",
      }),
    );
    expect(claim?.id).toBe(admitted.job_id);
    const trial = checked(
      await admin.rpc("start_factory_benchmark_trial", {
        p_attempt_count: 1,
        p_job_id: admitted.job_id,
      }),
    );
    expect(trial.id).toBe(admitted.id);

    const trialPath = `/w/${fixture.slug}/benchmarks/${fixture.saved.suiteId}/comparisons/${experimentId}/trials/${trial.id}?factory=${factoryId}`;
    await signInViaMagicLink(page, trialPath, {
      baseURL: fixture.app,
      email: fixture.ownerEmail,
    });
    const refresh = page.getByRole("button", { name: "Refresh trial evidence" });
    await expect(refresh).toBeVisible();
    await expect(page.getByText("No activity has been recorded for this run.")).toBeVisible();
    const activity = "Verified the active trial’s new invoice step.";
    expect(
      checked(
        await admin.rpc("append_agent_run_event", {
          p_job_id: trial.job_id,
          p_run_id: trial.run_id,
          p_attempt_count: 1,
          p_sequence: 1,
          p_kind: "text",
          p_payload: { text: activity },
          p_truncated: false,
        }),
      ),
    ).toBe(true);
    await refresh.press("Enter");
    await expect(page.getByText(activity, { exact: true })).toBeVisible();
    await expect(refresh).toBeFocused();
    expect(
      checked(
        await admin.rpc("fail_factory_benchmark_trial", {
          p_trial_id: trial.id,
          p_job_id: trial.job_id,
          p_run_id: trial.run_id,
          p_attempt_count: 1,
          p_failure_code: "candidate_failed",
        }),
      ),
    ).toBe(true);
    await refresh.press("Enter");
    await expect(refresh).toHaveCount(0);
    await expect(page.getByText(activity, { exact: true })).toBeVisible();
    const transcript = page.getByRole("region", { name: "Transcript" });
    await expect(transcript.getByText("Failed", { exact: true })).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});

test("a benchmark trial shares exact private evidence and rechecks access at delivery", async ({
  baseURL,
  page,
  browser,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_BENCHMARKS_E2E !== "1",
    "Requires disposable local Supabase.",
  );
  test.setTimeout(120_000);

  const input = fixtureCommit(inputHtml);
  const output = fixtureCommit(outputHtml, input.commit);
  const patch = [
    "diff --git a/fixture.html b/fixture.html",
    "--- a/fixture.html",
    "+++ b/fixture.html",
    "@@ -1 +1 @@",
    `-${inputHtml}`,
    `+${outputHtml}`,
    "",
  ].join("\n");
  const fixture = await seedBenchmarkResults(baseURL, {
    inputCommitSha: input.commit,
    inputTreeSha: input.tree,
    outputCommitSha: output.commit,
    outputTreeSha: output.tree,
    patch,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
  });
  const { admin, workspaceId, factoryId, ownerId, saved } = fixture;
  const assetId = randomUUID();
  const assetPath = `${workspaceId}/${saved.successfulRunId}/browser/${assetId}.png`;
  const api = `/api/workspaces/${workspaceId}/factories/${factoryId}/benchmarks/experiments/${fixture.experimentId}`;
  const evidence = `${api}/trials/${saved.successfulTrialId}`;
  const assetUrl = `${evidence}/media/output/assets/${assetId}`;
  const comparison = `/w/${fixture.slug}/benchmarks/${saved.suiteId}/comparisons/${fixture.experimentId}`;
  const scopedComparison = `${comparison}?factory=${factoryId}`;
  const trialPath = `${comparison}/trials/${saved.successfulTrialId}?factory=${factoryId}`;
  const requestsToProductionEvidence: string[] = [];
  page.on("request", (request) => {
    if (
      /\/api\/(?:sessions\/[^/]+\/validation-evidence|workspaces\/[^/]+\/runs\/[^/]+\/transcript)/.test(
        request.url(),
      )
    ) {
      requestsToProductionEvidence.push(new URL(request.url()).pathname);
    }
  });
  let uploaded = false;
  try {
    const capturePage = await browser.newPage({ viewport: { width: 640, height: 360 } });
    let png: Buffer;
    try {
      await capturePage.setContent(`${outputHtml}\n`);
      await expect(capturePage.getByTestId("invoice")).toContainText("Invoice reconciled");
      png = await capturePage.screenshot({ type: "png" });
    } finally {
      await capturePage.close();
    }
    const sha256 = createHash("sha256").update(png).digest("hex");
    checked(
      await admin.rpc("begin_workspace_resource_operation", {
        p_workspace_id: workspaceId,
        p_kind: "upload",
        p_provider: "",
        p_resource_id: assetPath,
        p_storage_bucket: mediaBucket,
        p_recovery_after: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    );
    checked(
      await admin.storage.from(mediaBucket).upload(assetPath, png, { contentType: "image/png" }),
    );
    uploaded = true;
    expect(
      await fixture.runFixtureFile("factory-benchmark-trial-media-seed.sql", {
        expire_asset: "false",
        workspace_id: workspaceId,
        trial_id: saved.successfulTrialId,
        run_id: saved.successfulRunId,
        asset_id: assetId,
        commit_sha: output.commit,
        tree_sha: output.tree,
        browser_session_id: randomUUID(),
        approval_scope_id: `${randomUUID()}/capture`,
        asset_path: assetPath,
        sha256,
        size_bytes: String(png.length),
      }),
    ).toEqual({ assets: 1 });

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, scopedComparison, {
      baseURL: fixture.app,
      email: fixture.ownerEmail,
    });
    const reportResponse = await page.request.get(`${api}/comparison?limit=100`);
    expect(reportResponse.ok(), await reportResponse.text()).toBeTruthy();
    const report = benchmarkComparisonSchema.parse(await reportResponse.json());
    const index = report.trialRows.findIndex(({ trialId }) => trialId === saved.successfulTrialId);
    expect(index).toBeGreaterThanOrEqual(0);
    const prior = index > 0 ? report.trialRows[index - 1]?.trialId : undefined;
    if (prior) await page.goto(`${scopedComparison}&afterTrialId=${prior}`);
    const row = page.getByRole("table", { name: "Frozen trials" }).locator("tbody tr").first();
    const openTrial = row.getByRole("link", { name: /Verify invoice reconciliation/ });
    await openTrial.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL((url) =>
      url.pathname.endsWith(`/trials/${saved.successfulTrialId}`),
    );

    const header = page.getByRole("heading", {
      name: "Verify invoice reconciliation",
      exact: true,
    });
    await expect(header).toBeVisible();
    const back = page.getByRole("link", { name: /Comparison results/ });
    if (prior) await expect(back).toHaveAttribute("href", new RegExp(`afterTrialId=${prior}`));
    await expect(page.getByText(input.commit, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(output.commit, { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText("No browser evidence matches the original run’s accepted commit and tree."),
    ).toBeVisible();

    const diff = page.getByLabel("Unified diff for this trial output");
    await expect(diff).toContainText("Invoice pending");
    await expect(diff).toContainText("Invoice reconciled");
    await expect(
      page.getByText("The isolated invoice output preserves the saved total."),
    ).toBeVisible();
    await expect(
      page.getByText("Recorded invoice processing step 35 API_KEY=[redacted]", { exact: true }),
    ).toBeVisible();
    const initialTranscript = await page.request.get(`${evidence}/transcript`);
    expect(initialTranscript.status()).toBe(200);
    expect(await initialTranscript.text()).not.toContain("synthetic-private-fixture-value");
    const older = page.getByRole("button", { name: "Load earlier activity" });
    await older.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("Recorded invoice processing step 1", { exact: true }),
    ).toBeVisible();

    const outputEvidence = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Trial output", exact: true }),
    });
    const screenshots = outputEvidence.getByRole("button", {
      name: "Browser screenshots",
      exact: true,
    });
    await screenshots.focus();
    await page.keyboard.press("Enter");
    const view = outputEvidence.getByRole("button", { name: "View screenshot" });
    await view.focus();
    await page.keyboard.press("Enter");
    const image = outputEvidence.getByRole("img", {
      name: "Screenshot captured for invoice-preview",
    });
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate((element) => element instanceof HTMLImageElement && element.naturalWidth),
      )
      .toBe(640);

    const exactAsset = await page.request.get(assetUrl);
    expect(exactAsset.headers()["cache-control"]).toBe("private, no-store");
    expect(exactAsset.headers()["content-type"]).toBe("image/png");
    expect(
      createHash("sha256")
        .update(await exactAsset.body())
        .digest("hex"),
    ).toBe(sha256);
    const originalAsset = assetUrl.replace("/media/output/", "/media/original/");
    expect((await page.request.get(originalAsset)).status()).toBe(404);
    const siblingAsset = assetUrl.replace(
      `/factories/${factoryId}/`,
      `/factories/${fixture.siblingFactoryId}/`,
    );
    expect([403, 404]).toContain((await page.request.get(siblingAsset)).status());

    const excluded = report.trialRows.find(({ status }) => status === "excluded");
    if (!excluded) throw new Error("The frozen matrix must include an excluded trial.");
    const excludedAsset = assetUrl.replace(saved.successfulTrialId, excluded.trialId);
    expect((await page.request.get(excludedAsset)).status()).toBe(404);
    await capture(page, info, "benchmark-trial-evidence-desktop");

    const screenshotAnchor = await outputEvidence
      .getByRole("link", { name: "Link to screenshot evidence" })
      .getAttribute("href");
    expect(screenshotAnchor).toBe(`#output-browser-screenshot-${assetId}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${trialPath}${screenshotAnchor}`);
    await expect(screenshots).toHaveAttribute("aria-expanded", "true");
    await outputEvidence.getByRole("button", { name: "View screenshot" }).press("Enter");
    await expect(image).toBeVisible();
    await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await capture(page, info, "benchmark-trial-evidence-mobile");
    expect(requestsToProductionEvidence).toEqual([]);

    const excludedPath = trialPath.replace(saved.successfulTrialId, excluded.trialId);
    await page.goto(excludedPath);
    await expect(
      page.getByRole("heading", { name: "Verify notification recovery", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("This trial has no retained output.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("An exact output diff was not retained for this trial.", { exact: true }),
    ).toBeVisible();

    const member = checked(
      await admin
        .from("workspace_members")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("user_id", fixture.viewerId)
        .single(),
    );
    checked(
      await admin.rpc("grant_factory_membership", {
        p_workspace_id: workspaceId,
        p_factory_id: factoryId,
        p_actor_user_id: ownerId,
        p_member_id: member.id,
        p_role: "manager",
      }),
    );
    const viewer = await browser.newContext({ baseURL: fixture.app });
    try {
      const managerPage = await viewer.newPage();
      await signInViaMagicLink(managerPage, trialPath, {
        baseURL: fixture.app,
        email: fixture.viewerEmail,
      });
      await expect(
        managerPage.getByRole("heading", { name: "Verify invoice reconciliation", exact: true }),
      ).toBeVisible();
      expect((await managerPage.request.get(evidence)).status()).toBe(200);
      expect((await managerPage.request.get(assetUrl)).status()).toBe(200);
      checked(
        await admin.rpc("revoke_factory_membership", {
          p_workspace_id: workspaceId,
          p_factory_id: factoryId,
          p_actor_user_id: ownerId,
          p_member_id: member.id,
          p_reason: "Disposable benchmark browser proof",
        }),
      );
      expect([403, 404]).toContain((await managerPage.request.get(evidence)).status());
      expect([403, 404]).toContain((await managerPage.request.get(assetUrl)).status());
    } finally {
      await viewer.close();
    }

    await page.goto(`${trialPath}${screenshotAnchor}`);
    await expect(screenshots).toHaveAttribute("aria-expanded", "true");
    await expect(view).toBeVisible();
    expect(
      await fixture.runFixtureFile("factory-benchmark-trial-media-seed.sql", {
        expire_asset: "true",
        workspace_id: workspaceId,
        run_id: saved.successfulRunId,
        asset_id: assetId,
      }),
    ).toEqual({ expired: true });
    await view.press("Enter");
    const expired = outputEvidence.getByText(
      "This screenshot expired under the workspace retention policy.",
    );
    await expect(expired).toBeVisible();
    expect((await page.request.get(assetUrl)).status()).toBe(410);
    await expired.evaluate((element) => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      element.scrollIntoView({ block: "center", behavior: "instant" });
    });
    const expiredProof = info.outputPath("benchmark-trial-evidence-expired-mobile.png");
    await page.screenshot({ path: expiredProof, animations: "disabled", caret: "hide" });
    await info.attach("benchmark-trial-evidence-expired-mobile", {
      path: expiredProof,
      contentType: "image/png",
    });
  } finally {
    try {
      await fixture.cleanup();
    } finally {
      if (uploaded) checked(await admin.storage.from(mediaBucket).remove([assetPath]));
    }
  }
});

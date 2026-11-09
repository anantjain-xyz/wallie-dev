import { expect, test, type Page, type TestInfo } from "@playwright/test";

async function capture(page: Page, info: TestInfo, state: string) {
  await page.screenshot({ path: info.outputPath(`${state}.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const width of [1440, 390]) {
  test(`search draft has one hint and clear restores focus at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/dev/sessions-ledger");
    const status = page.getByRole("status", { name: "Sessions search status" });
    await expect(status).toBeEmpty();
    const search = page.getByRole("searchbox");
    await search.fill("retry");
    await expect(status).toHaveText("Press Enter to search.");
    await capture(page, info, "typed-search");
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("");
    await expect(status).toBeEmpty();
    await expect(page.getByText("No matching sessions")).toBeVisible();
    await capture(page, info, "cleared-search-and-empty-states");
  });

  test(`comment save failure keeps the draft and retry supports reply, edit, discard at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const memberId = "33333333-3333-4333-8333-333333333333";
    let saved = false;
    let fail = true;
    const requests: Record<string, unknown>[] = [];
    const thread = {
      id: "22222222-2222-4222-8222-222222222222",
      artifact_id: "11111111-1111-4111-8111-111111111111",
      artifact_version: 1,
      stage_slug: "build",
      kind: "discussion",
      status: "open",
      author_member_id: memberId,
      author_label: "Alex",
      revision: 1,
      anchor: { quote: "Version 1 is ready for review." },
    };
    let comment = {
      id: "66666666-6666-4666-8666-666666666666",
      thread_id: thread.id,
      author_member_id: memberId,
      author_label: "Alex",
      body: "Please clarify retries.",
      revision: 1,
    };
    await page.route(/\/api\/sessions\/preview\/reviews(?:[/?].*)?$/, async (route) => {
      const request = route.request();
      if (request.method() !== "GET") {
        const payload = request.postDataJSON();
        requests.push(payload);
        if (fail) return route.fulfill({ status: 503, json: {} });
        saved = true;
        if (new URL(request.url()).pathname.endsWith("/comments")) {
          comment = { ...comment, body: payload.body, revision: comment.revision + 1 };
          return route.fulfill({ json: { comment } });
        }
        return route.fulfill({ json: { thread } });
      }
      if (new URL(request.url()).pathname.endsWith("/comments"))
        return route.fulfill({ json: { comments: [comment], nextCursor: null } });
      return route.fulfill({
        json: {
          reviewRevision: 0,
          submittedThreadRevisions: {},
          threads: saved ? [thread] : [],
          nextCursor: null,
          counts: { total: saved ? 1 : 0, open: saved ? 1 : 0, blocking: 0 },
          viewer: { memberId, canReview: true, readOnlyReason: null },
        },
      });
    });
    await page.goto("/dev/interaction-motion?reviewState=editable");
    const opener = page.getByRole("button", { name: "Comments", exact: true });
    await opener.click();
    const passage = page.locator(".artifact-content p");
    await passage.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    await passage.dispatchEvent("pointerup");
    await page.getByRole("button", { name: "Comment on selection" }).click();
    const composer = page.getByRole("textbox", { name: "Comment", exact: true });
    await expect(composer).toBeFocused();
    await composer.fill(comment.body);
    await expect(page.getByRole("button", { name: "Discard", exact: true })).toBeVisible();
    await capture(page, info, "comment-draft");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("main [role=alert]")).toHaveText("Couldn’t save. Draft kept.");
    await expect(composer).toHaveValue(comment.body);
    await capture(page, info, "comment-save-error");
    fail = false;
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Reply to thread" })).toBeFocused();
    expect(requests[1]).toEqual(requests[0]);
    const reply = page.getByRole("textbox", { name: "Reply to thread" });
    await reply.fill("Thanks for clarifying.");
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(page.getByText("Thanks for clarifying.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit comment", exact: true }).click();
    const edit = page.getByRole("textbox", { name: "Edit your comment", exact: true });
    await edit.fill("Updated comment.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Updated comment.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit comment", exact: true }).click();
    await edit.fill("Discard this edit.");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(reply).toHaveValue("");
    await expect(page.getByText("Updated comment.", { exact: true })).toBeVisible();
    await capture(page, info, "comment-saved");
    await page.getByRole("button", { name: "Close comments" }).click();
    await expect(opener).toBeFocused();
    // Discard a fresh draft too; selection composition is covered by comment-access.
    await opener.click();
    await passage.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    await passage.dispatchEvent("pointerup");
    await page.getByRole("button", { name: "Comment on selection" }).click();
    await composer.fill("Discard this draft.");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(composer).toHaveCount(0);
  });

  test(`pipeline validation and failed saves retain edits at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    let fail = true;
    await page.route("**/api/workspaces/*/pipeline", (route) =>
      route.fulfill(fail ? { status: 503, json: {} } : { json: {} }),
    );
    await page.goto("/dev/pipeline-editor");
    const name = page.getByRole("textbox", { name: "Pipeline name" });
    await name.fill("");
    await page.getByRole("button", { name: "Save pipeline", exact: true }).click();
    await expect(name).toBeFocused();
    await capture(page, info, "pipeline-validation");
    await name.fill("Concise pipeline");
    await page.getByRole("button", { name: "Save pipeline", exact: true }).click();
    await expect(page.locator("main [role=alert]")).toContainText(
      "Couldn’t save pipeline. Edits kept.",
    );
    await expect(name).toHaveValue("Concise pipeline");
    await capture(page, info, "pipeline-save-error");
    fail = false;
    await page.getByRole("button", { name: "Save pipeline", exact: true }).click();
    await expect(page.locator("main [role=alert]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save pipeline", exact: true })).toBeDisabled();
    await capture(page, info, "pipeline-saved");
  });

  test(`recovery and settings states remain usable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/dev/copy-states");
    await expect(page.getByText("Retry or return to your workspace.")).toBeVisible();
    await capture(page, info, "route-error");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByText("Page loaded.", { exact: true })).toBeVisible();
    for (const state of ["loading", "error", "missing-usage", "loaded"]) {
      await page.goto(`/dev/settings?state=${state}`);
      await expect(page.locator("main")).toBeVisible();
      await capture(page, info, `settings-${state}`);
    }
    await page.goto("/dev/artifact-evidence");
    await expect(
      page.getByRole("heading", { name: "Artifact evidence", exact: true }),
    ).toBeVisible();
    await capture(page, info, "artifact-evidence");
    await page.goto("/dev/copy-states?state=onboarding");
    await expect(page.getByRole("textbox", { name: "Pipeline name" })).toBeVisible();
    await capture(page, info, "onboarding-pipeline");
  });
}

for (const width of [1440, 390]) {
  test(`delivery loading, failure, queued refresh and recovery at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fail = true;
    let queued = false;
    let refreshFails = true;
    const delivery = {
      requirements: {
        version: 1,
        deliveryMode: "code",
        requiredChecks: [],
        minimumApprovals: 0,
        requireCodeOwnerReview: false,
        requireResolvedThreads: false,
        requiredEvidence: [],
        freshnessSeconds: 3600,
        requireArtifactApprovalForDelivery: true,
      },
      policyRevisionId: "33333333-3333-4333-8333-333333333333",
      finalStage: true,
      approvalGated: true,
      observationStale: false,
      evaluation: {
        state: "checking",
        blockers: [],
        summary: null,
        dimensions: {
          githubAccess: "checking",
          identity: "checking",
          checks: "checking",
          reviews: "checking",
          threads: "checking",
          evidence: "checking",
          mergeability: "checking",
        },
      },
      pr: null,
      checks: [],
      review: null,
      evidence: null,
      artifactBlockingCount: 0,
      sourceObservationId: null,
    };
    await page.route("**/api/sessions/preview/review-evidence", async (route) => {
      await gate;
      return route.fulfill(
        fail
          ? { status: 503, json: {} }
          : {
              json: {
                delivery: {
                  ...delivery,
                  refresh: {
                    status: queued ? "pending" : "current",
                    lastErrorCode: null,
                    updatedAt: null,
                    canRefresh: true,
                  },
                },
              },
            },
      );
    });
    await page.route("**/api/sessions/preview/pr-verification/refresh", (route) => {
      if (refreshFails) return route.fulfill({ status: 503, json: {} });
      queued = true;
      return route.fulfill({ json: {} });
    });
    await page.goto("/dev/copy-states?state=delivery");
    await expect(
      page.getByRole("status").filter({ hasText: "Loading delivery readiness…" }),
    ).toHaveText("Loading delivery readiness…");
    await capture(page, info, "delivery-loading");
    release();
    await expect(page.locator("main [role=alert]")).toContainText(
      "Evidence unavailable. Retry to confirm readiness.",
    );
    await capture(page, info, "delivery-load-error");
    fail = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    const refresh = page.getByRole("button", { name: "Refresh verification", exact: true });
    await refresh.click();
    await expect(page.locator("main [role=alert]")).toHaveText("Couldn’t queue verification.");
    await capture(page, info, "delivery-refresh-error");
    refreshFails = false;
    await refresh.click();
    await expect(page.getByText("Verification queued.", { exact: true })).toBeVisible();
    await expect(page.getByText(/This panel updates/)).toHaveCount(0);
    await capture(page, info, "delivery-queued");
  });

  test(`workspace validation, save recovery and dialog focus at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    let fail = true;
    await page.route(/\/api\/workspaces\/11111111-1111-4111-8111-111111111111$/, (route) =>
      route.fulfill(fail ? { status: 503, json: {} } : { json: { name: "Copy review" } }),
    );
    await page.goto("/dev/settings?category=workspace");
    const trigger = page.getByRole("button", { name: "Edit workspace name", exact: true });
    await trigger.click();
    const name = page.getByRole("textbox", { name: "Workspace name", exact: true });
    await name.fill("");
    await name.press("Enter");
    await expect(page.locator("main [role=alert]")).toContainText("Workspace name is required.");
    await name.fill("Copy review");
    await name.press("Enter");
    await expect(page.getByText("Request failed.", { exact: true }).first()).toBeVisible();
    await expect(name).toHaveValue("Copy review");
    await capture(page, info, "workspace-save-error");
    fail = false;
    await name.press("Enter");
    await expect(trigger).toBeFocused();
    await expect(
      page.locator("#workspace").getByText("Copy review", { exact: true }),
    ).toBeVisible();
    const invite = page.getByRole("button", { name: "Invite member", exact: true });
    await invite.click();
    await expect(page.getByRole("dialog", { name: "Invite a workspace member" })).toBeVisible();
    await capture(page, info, "invite-dialog");
    await page.keyboard.press("Escape");
    await expect(invite).toBeFocused();
  });
}

for (const width of [1440, 390]) {
  test(`onboarding pipeline validates, retains a failed save and retries at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    let fail = true;
    let saves = 0;
    await page.route("**/api/workspaces/workspace-1/pipeline", (route) => {
      saves++;
      if (fail) return route.fulfill({ status: 503, json: {} });
      const payload = route.request().postDataJSON();
      return route.fulfill({
        json: { pipeline: { id: "pipeline-1", isDefault: true, ...payload } },
      });
    });
    // Stop at a failed step acknowledgement: this also checks that the saved
    // pipeline survives a later onboarding failure, without an external write.
    await page.route("**/api/workspaces/workspace-1/onboarding", (route) =>
      route.fulfill({ status: 503, json: { error: "Step save unavailable." } }),
    );
    await page.goto("/dev/copy-states?state=onboarding");
    const name = page.getByRole("textbox", { name: "Pipeline name" });
    await name.fill("");
    await page.getByRole("button", { name: "Save pipeline", exact: true }).click();
    await expect(name).toBeFocused();
    await capture(page, info, "onboarding-validation");
    await name.fill("Review pipeline");
    await page.getByRole("radio", { name: "Anyone in the workspace", exact: true }).check();
    await page.getByRole("button", { name: "Save pipeline", exact: true }).click();
    await expect(
      page.locator("main [role=alert]").filter({ hasText: "Couldn’t save pipeline. Edits kept." }),
    ).toBeVisible();
    await expect(name).toHaveValue("Review pipeline");
    await capture(page, info, "onboarding-save-error");
    fail = false;
    await page.getByRole("button", { name: "Save pipeline", exact: true }).click();
    await expect.poll(() => saves).toBe(2);
    await expect(page.getByText("Step save unavailable.", { exact: true }).first()).toBeVisible();
    await expect(name).toHaveValue("Review pipeline");
    await capture(page, info, "onboarding-pipeline-saved-step-error");
    await page.goto("/dev/copy-states?state=onboarding-verify");
    await expect(
      page.getByText("Verify repository, agent, and sandbox.", { exact: true }),
    ).toBeVisible();
    await capture(page, info, "onboarding-verification");
  });
}

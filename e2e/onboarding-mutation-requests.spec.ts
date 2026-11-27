import { expect, test, type Request } from "@playwright/test";

import { signIn } from "./helpers/auth";

test("onboarding navigation saves once without a follow-up route refresh", async ({ page }) => {
  await signIn(page);

  const suffix = Date.now().toString(36);
  const workspaceName = `Onboarding request proof ${suffix}`;
  const workspaceSlug = `onboarding-request-proof-${suffix}`;
  const createResponse = await page.request.post("/api/workspaces", {
    data: { name: workspaceName, slug: workspaceSlug },
  });
  expect(createResponse.status()).toBe(201);
  const created = (await createResponse.json()) as {
    redirectTo: string;
    workspace: { id: string };
  };

  try {
    await page.goto(created.redirectTo);
    await expect(page.getByRole("heading", { name: "Connect GitHub" })).toBeVisible();

    const mutationRequests: Request[] = [];
    const refreshRequests: Request[] = [];
    const onboardingEndpoint = `/api/workspaces/${created.workspace.id}/onboarding`;

    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "PATCH" && url.pathname === onboardingEndpoint) {
        mutationRequests.push(request);
      }
      if (request.headers().rsc === "1" && url.pathname === created.redirectTo) {
        refreshRequests.push(request);
      }
    });
    const mutation = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === onboardingEndpoint,
    );
    const mutationStartedAt = Date.now();
    await page
      .getByRole("complementary")
      .getByRole("button", { name: "Pipeline", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "Review pipeline" })).toBeVisible();
    expect((await mutation).ok()).toBe(true);
    const mutationLatencyMs = Date.now() - mutationStartedAt;
    await expect.poll(() => mutationRequests.length).toBe(1);
    await page.waitForTimeout(500);

    console.log(
      `onboarding PATCH latency: ${mutationLatencyMs}ms; follow-up RSC requests: ${refreshRequests.length}`,
    );

    expect(mutationRequests, "one onboarding interaction must issue one PATCH").toHaveLength(1);
    expect(refreshRequests, "the PATCH must not trigger a same-route RSC refresh").toHaveLength(0);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Review pipeline" })).toBeVisible();

    const before = await page.request.get(onboardingEndpoint);
    expect(before.ok()).toBe(true);
    const { pipeline } = await before.json();
    expect(pipeline.stages.map((stage: { slug: string }) => stage.slug)).toEqual(["plan", "build"]);
    await page.getByRole("button", { name: "Customize stages" }).click();
    await expect(page.getByRole("textbox", { name: "Pipeline name" })).toBeFocused();
    await expect(page.getByRole("button", { name: "Save pipeline" })).toBeVisible();
    await page.reload();
    const pipelineWrites: Request[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT" && new URL(request.url()).pathname.endsWith("/pipeline")) {
        pipelineWrites.push(request);
      }
    });
    await page.getByRole("button", { name: "Use Plan → Build" }).click();
    await expect(page.getByRole("heading", { name: "Connect Linear (optional)" })).toBeFocused();
    await expect(page.getByRole("button", { name: "Skip Linear" })).toBeInViewport();
    await expect.poll(() => mutationRequests.length).toBe(2);
    expect(mutationRequests[1]?.postDataJSON()).toMatchObject({
      action: "continue",
      changes: { completedSteps: ["pipeline"], currentStep: "linear" },
      step: "pipeline",
    });
    const after = await page.request.get(onboardingEndpoint);
    expect(after.ok()).toBe(true);
    expect((await after.json()).pipeline).toEqual(pipeline);
    expect(pipelineWrites).toHaveLength(0);
  } finally {
    const deleteResponse = await page.request.delete(`/api/workspaces/${created.workspace.id}`, {
      data: { confirmation: workspaceName },
      timeout: 15_000,
    });
    expect(deleteResponse.ok(), "temporary onboarding workspace must be deleted").toBe(true);
  }
});

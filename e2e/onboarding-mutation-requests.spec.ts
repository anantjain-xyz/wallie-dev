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
    let mutationLatencyMs: number | null = null;
    let mutationStartedAt = 0;

    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        request.method() === "PATCH" &&
        url.pathname === `/api/workspaces/${created.workspace.id}/onboarding`
      ) {
        mutationRequests.push(request);
      }
      if (request.headers().rsc === "1" && url.pathname === created.redirectTo) {
        refreshRequests.push(request);
      }
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (
        response.request().method() === "PATCH" &&
        url.pathname === `/api/workspaces/${created.workspace.id}/onboarding`
      ) {
        mutationLatencyMs = Date.now() - mutationStartedAt;
      }
    });

    mutationStartedAt = Date.now();
    await page
      .getByRole("complementary")
      .getByRole("button", { name: /Review pipeline/ })
      .click();
    await expect(page.getByRole("heading", { name: "Review pipeline" })).toBeVisible();
    await expect.poll(() => mutationRequests.length).toBe(1);
    await page.waitForTimeout(500);

    console.log(
      `onboarding PATCH latency: ${mutationLatencyMs}ms; follow-up RSC requests: ${refreshRequests.length}`,
    );

    expect(mutationRequests, "one onboarding interaction must issue one PATCH").toHaveLength(1);
    expect(refreshRequests, "the PATCH must not trigger a same-route RSC refresh").toHaveLength(0);
    expect(mutationLatencyMs).not.toBeNull();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Review pipeline" })).toBeVisible();
  } finally {
    const deleteResponse = await page.request.delete(`/api/workspaces/${created.workspace.id}`, {
      data: { confirmation: workspaceName },
      timeout: 15_000,
    });
    expect(deleteResponse.ok(), "temporary onboarding workspace must be deleted").toBe(true);
  }
});

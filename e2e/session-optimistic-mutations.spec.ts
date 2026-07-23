import { expect, test, type Request } from "@playwright/test";

import { signIn } from "./helpers/auth";

const workspacePath = "/w/acme-corp";

function delayedResponse() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

test("title and archive state render before their delayed responses", async ({ page }) => {
  await signIn(page, `${workspacePath}/sessions/1`);

  const titleGate = delayedResponse();
  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await titleGate.gate;
    await route.fulfill({
      contentType: "application/json",
      json: {
        id: "a2b2c3d4-0001-4000-8000-000000000001",
        title: "Optimistic SSO title",
        updatedAt: "2026-07-17T20:00:00.000Z",
      },
    });
  });

  await page.getByRole("button", { name: "Edit title for session #1" }).click();
  await page.getByRole("textbox", { name: "Session #1 title" }).fill("Optimistic SSO title");
  await page.getByRole("button", { name: "Save title for session #1" }).click();

  await expect(page.getByRole("heading", { name: "Optimistic SSO title" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Saving title for session #1" })).toBeDisabled();
  titleGate.release();
  await expect(page.getByRole("button", { name: "Edit title for session #1" })).toBeEnabled();

  const archiveGate = delayedResponse();
  await page.route("**/api/sessions/*/archive", async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({
        contentType: "application/json",
        json: {
          archivedAt: null,
          id: "a2b2c3d4-0001-4000-8000-000000000001",
          phaseStatus: "awaiting_review",
          updatedAt: "2026-07-17T20:01:30.000Z",
        },
      });
      return;
    }
    await archiveGate.gate;
    await route.fulfill({
      contentType: "application/json",
      json: {
        archivedAt: "2026-07-17T20:01:00.000Z",
        id: "a2b2c3d4-0001-4000-8000-000000000001",
        phaseStatus: "awaiting_review",
        updatedAt: "2026-07-17T20:01:00.000Z",
      },
    });
  });

  await page.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText("Archived", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Archiving/ })).toBeDisabled();
  archiveGate.release();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Archive" })).toBeEnabled();
});

test("approve and reject expose optimistic status while delayed", async ({ page }) => {
  await signIn(page, `${workspacePath}/sessions/1`);

  const approveGate = delayedResponse();
  await page.route("**/api/sessions/*/phase-action", async (route) => {
    await approveGate.gate;
    await route.fulfill({
      contentType: "application/json",
      json: {
        archivedAt: null,
        artifactVersion: 0,
        currentStage: {
          description: "Synthetic next stage",
          id: "synthetic-next-stage",
          name: "Next stage",
          position: 1,
          slug: "synthetic-next",
        },
        currentStageId: "synthetic-next-stage",
        id: "a2b2c3d4-0001-4000-8000-000000000001",
        phaseStatus: "agent_generating",
        rejectionCount: 0,
        updatedAt: "2026-07-17T20:02:00.000Z",
      },
    });
  });

  await page.getByRole("button", { name: "Approve & advance" }).click();
  await expect(page.getByText("Drafting", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Approving/ })).toBeDisabled();
  approveGate.release();
  await expect(page.getByRole("button", { name: /Approving/ })).toBeHidden();

  await page.unroute("**/api/sessions/*/phase-action");
  await page.goto(`${workspacePath}/sessions/3`);
  const rejectGate = delayedResponse();
  await page.route("**/api/sessions/*/phase-action", async (route) => {
    await rejectGate.gate;
    await route.fulfill({
      contentType: "application/json",
      json: {
        archivedAt: null,
        artifactVersion: 1,
        currentStage: {
          description: "Synthetic current stage",
          id: "synthetic-current-stage",
          name: "Current stage",
          position: 0,
          slug: "synthetic-current",
        },
        currentStageId: "synthetic-current-stage",
        id: "a2b2c3d4-0003-4000-8000-000000000003",
        phaseStatus: "rejected",
        rejectionCount: 1,
        updatedAt: "2026-07-17T20:03:00.000Z",
      },
    });
  });

  await page.getByRole("button", { name: "Request changes and rerun" }).click();
  await page.getByLabel("Feedback for Wallie").fill("Preserve this feedback");
  await page.getByRole("button", { name: "Queue rerun" }).click();
  await expect(page.getByText("Rejected", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Queueing/ })).toBeDisabled();
  await expect(page.getByLabel("Feedback for Wallie")).toHaveValue("Preserve this feedback");
  rejectGate.release();
});

test("delayed filters retain pressed feedback and reduced-motion route progress", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);

  const filterGate = delayedResponse();
  await page.route("**/w/acme-corp/sessions?*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.headers().rsc !== "1" || url.searchParams.get("scope") !== "active") {
      await route.continue();
      return;
    }
    await filterGate.gate;
    await route.continue();
  });

  await page.getByRole("button", { name: "Active" }).click();
  await expect(page.getByRole("button", { name: "Loading Active…" })).toBeDisabled();
  const routeProgress = page.locator("[data-route-progress]");
  await expect(routeProgress).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading page…" })).toHaveCount(1);
  await expect(routeProgress.locator(".ui-route-progress-value")).toHaveCSS(
    "animation-duration",
    "0.00001s",
  );

  filterGate.release();
  await expect(page).toHaveURL(/scope=active/);
  await expect(routeProgress).toBeHidden();
});

test("create navigates with one destination RSC request and no refresh", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "New session" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Prompt").fill("Create without a route refresh");

  const destinationRequests: Request[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.headers().rsc === "1" && url.pathname === `${workspacePath}/sessions/1`) {
      destinationRequests.push(request);
    }
  });
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      contentType: "application/json",
      json: { canonicalUrl: `${workspacePath}/sessions/1`, number: 1 },
      status: 201,
    });
  });

  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page).toHaveURL(`${workspacePath}/sessions/1`);
  await expect.poll(() => destinationRequests.length).toBe(1);
});

import { randomInt, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

import type { PipelineDashboardLane } from "../src/features/pipeline/types";
import { signIn } from "./helpers/auth";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY;
const isLocal =
  supabaseUrl && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(supabaseUrl).hostname);
const dashboardUrl = /\/api\/workspaces\/[^/]+\/pipeline-dashboard$/;

test.beforeEach(() => {
  test.skip(!isLocal || !serviceKey, "Requires a disposable local Supabase stack and seed user");
});

async function database(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceKey!,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`Local fixture request failed (${response.status}): ${await response.text()}`);
  return response.json();
}

function nextSnapshot(page: Page) {
  return page.waitForResponse(
    (response) =>
      dashboardUrl.test(response.url()) && response.request().method() === "GET" && response.ok(),
    { timeout: 15_000 },
  );
}

function observeSessionChanges(page: Page) {
  const changes: string[] = [];
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/realtime/v1/websocket")) return;
    socket.on("framereceived", ({ payload }) => {
      const text = payload.toString();
      if (text.includes("postgres_changes")) changes.push(text);
    });
  });
  return (id: string) =>
    expect
      .poll(() => changes.some((payload) => payload.includes(id)), {
        message: "Expected the local realtime server to deliver the session change",
        timeout: 10_000,
      })
      .toBe(true);
}

async function seedSession() {
  const [workspace] = await database("workspaces?select=id&slug=eq.acme-corp");
  const [seed] = await database(
    `sessions?select=id,title,workspace_id,pipeline_id,current_stage_id,creator_member_id&workspace_id=eq.${workspace.id}&number=eq.1`,
  );
  return seed;
}

async function createSessions() {
  const seed = await seedSession();
  const startNumber = randomInt(100_000, 1_000_000);
  const sessions = Array.from({ length: 30 }, (_, index) => ({
    id: randomUUID(),
    workspace_id: seed.workspace_id,
    pipeline_id: seed.pipeline_id,
    current_stage_id: seed.current_stage_id,
    creator_member_id: seed.creator_member_id,
    number: startNumber + index,
    title: `Pipeline recovery fixture ${index}`,
    prompt_md: "Disposable local browser fixture",
    phase_status: "in_progress",
    current_artifact_version: 0,
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2020-01-01T00:00:00Z",
  }));
  await database("sessions", "POST", sessions);
  return {
    sessions,
    cleanup: () =>
      database(`sessions?id=in.(${sessions.map((session) => session.id).join(",")})`, "DELETE"),
  };
}

test("catches a database change made after SSR but before the first subscription", async ({
  page,
}) => {
  const seed = await seedSession();
  const changedTitle = `Subscription gap ${randomUUID()}`;
  let releaseJoin: (() => void) | undefined;
  await page.routeWebSocket("**/realtime/v1/websocket*", (socket) => {
    const server = socket.connectToServer();
    const held: (string | Buffer)[] = [];
    let released = false;
    socket.onMessage((message) => {
      if (!released && message.toString().includes("phx_join")) held.push(message);
      else server.send(message);
    });
    releaseJoin = () => {
      released = true;
      held.splice(0).forEach((message) => server.send(message));
    };
  });
  try {
    await signIn(page, "/w/acme-corp");
    await expect(page.getByRole("link", { name: `Open session ${seed.title}` })).toBeVisible();
    await expect.poll(() => Boolean(releaseJoin)).toBe(true);
    await database(`sessions?id=eq.${seed.id}`, "PATCH", { title: changedTitle });
    await expect(page.getByText(changedTitle, { exact: true })).toHaveCount(0);
    const catchup = nextSnapshot(page);
    releaseJoin!();
    await catchup;
    await expect(page.getByRole("link", { name: `Open session ${changedTitle}` })).toBeVisible();
  } finally {
    await database(`sessions?id=eq.${seed.id}`, "PATCH", { title: seed.title });
  }
});

test("recovers an existing off-page session moving to another lane", async ({ page }) => {
  const fixture = await createSessions();
  const changed = observeSessionChanges(page);
  try {
    const initial = nextSnapshot(page);
    await signIn(page, "/w/acme-corp");
    const { lanes } = (await (await initial).json()) as { lanes: PipelineDashboardLane[] };
    const loaded = new Set(lanes.flatMap((lane) => lane.cards.map((card) => card.id)));
    const offPage = fixture.sessions.find((session) => !loaded.has(session.id))!;
    const build = lanes.find((lane) => lane.slug === "build")!;
    expect(offPage).toBeTruthy();
    const liveChange = changed(offPage.id);
    const catchup = nextSnapshot(page);
    await database(`sessions?id=eq.${offPage.id}`, "PATCH", { current_stage_id: build.id });
    await Promise.all([liveChange, catchup]);
    await expect(
      page
        .locator(`[data-pipeline-lane="${build.pipeline.id}:${build.id}"]`)
        .getByText(offPage.title, { exact: true }),
    ).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});

test("does not resurrect an archived off-page session from a delayed page", async ({ page }) => {
  const fixture = await createSessions();
  const changed = observeSessionChanges(page);
  try {
    const initial = nextSnapshot(page);
    await signIn(page, "/w/acme-corp");
    await initial;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loadedPage!: (lane: PipelineDashboardLane) => void;
    const pageLoaded = new Promise<PipelineDashboardLane>((resolve) => {
      loadedPage = resolve;
    });
    await page.route("**/api/workspaces/*/pipeline-dashboard", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      loadedPage((await response.json()).lane);
      await gate;
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Load more Plan sessions" }).click();
    const delayedLane = await pageLoaded;
    const target = delayedLane.cards.find((card) =>
      fixture.sessions.some((session) => session.id === card.id),
    )!;
    expect(target).toBeTruthy();
    const liveChange = changed(target.id);
    await database(`sessions?id=eq.${target.id}`, "PATCH", {
      archived_at: new Date().toISOString(),
    });
    await liveChange;
    const catchup = nextSnapshot(page);
    release();
    await catchup;
    await expect(page.getByText(target.title, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Load more Plan sessions" })).toBeEnabled();
  } finally {
    await fixture.cleanup();
  }
});

test("authenticates direct detail and activity subscriptions before receiving changes", async ({
  page,
}) => {
  const seed = await seedSession();
  const joins = new Map<string, boolean>();
  const subscribed = new Set<string>();
  const changed = observeSessionChanges(page);
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/realtime/v1/websocket")) return;
    socket.on("framesent", ({ payload }) => {
      const [, , topic, event, data] = JSON.parse(payload.toString());
      if (event === "phx_join") joins.set(topic, Boolean(data.access_token));
    });
    socket.on("framereceived", ({ payload }) => {
      const [, , topic, event, data] = JSON.parse(payload.toString());
      if (event === "system" && data.status === "ok") subscribed.add(topic);
    });
  });
  try {
    await signIn(page, "/w/acme-corp/sessions/1");
    for (const prefix of ["session-detail", "wallie-runs"]) {
      const topic = `realtime:${prefix}:${seed.id}`;
      await expect.poll(() => subscribed.has(topic)).toBe(true);
      expect(joins.get(topic)).toBe(true);
    }
    const title = `Authenticated detail ${randomUUID()}`;
    const liveChange = changed(seed.id);
    await database(`sessions?id=eq.${seed.id}`, "PATCH", { title });
    await liveChange;
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  } finally {
    await database(`sessions?id=eq.${seed.id}`, "PATCH", { title: seed.title });
  }
});

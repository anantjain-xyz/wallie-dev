import { beforeEach, expect, it, vi } from "vitest";

import { workflowInspectionApiPath } from "@/lib/routes";

import { GET } from "./route";

const { abortSignal, rpc, user } = vi.hoisted(() => ({
  abortSignal: vi.fn(),
  rpc: vi.fn(),
  user: vi.fn(),
}));

vi.mock("@/lib/supabase/auth", () => ({ getSupabaseUserOrNull: user }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => ({ rpc }),
}));

const rootSessionId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const cursor = {
  rootSessionId,
  sessionId,
  runId,
  recordedAt: "2026-11-23T14:31:14+00:00",
  kind: "occurrence",
  id: "44444444-4444-4444-8444-444444444444",
};
const responsePayload = {
  root: {
    sessionId: rootSessionId,
    sessionNumber: 2,
    workspaceId: "55555555-5555-4555-8555-555555555555",
    factoryId: "66666666-6666-4666-8666-666666666666",
    graphRevisionId: "77777777-7777-4777-8777-777777777777",
    workflowDigest: "a".repeat(64),
    lifecycleStatus: "paused",
    generation: 3,
    canManage: true,
  },
  subject: { sessionId, sessionNumber: 3, runId },
  events: [],
  budget: null,
  nextCursor: cursor,
};
const params = { params: Promise.resolve({ sessionId }) };

function get(query?: { runId?: string; cursor?: string }) {
  return GET(
    new Request("https://wallie.test" + workflowInspectionApiPath(sessionId, query)),
    params,
  );
}

function encode(value: typeof cursor) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

beforeEach(() => {
  vi.resetAllMocks();
  user.mockResolvedValue({ id: "reader" });
  rpc.mockReturnValue({ abortSignal });
  abortSignal.mockResolvedValue({ data: responsePayload, error: null });
});

it("loads the exact child run and carries its positioned cursor into the next bounded read", async () => {
  const initial = await get({ runId });
  expect(initial.status).toBe(200);
  expect(initial.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await initial.json()).toEqual({ ...responsePayload, nextCursor: encode(cursor) });
  expect(rpc).toHaveBeenLastCalledWith("read_factory_workflow_inspection", {
    p_session_id: sessionId,
    p_run_id: runId,
    p_before: undefined,
    p_page_size: 25,
  });

  expect((await get({ runId, cursor: encode(cursor) })).status).toBe(200);
  expect(rpc).toHaveBeenLastCalledWith("read_factory_workflow_inspection", {
    p_session_id: sessionId,
    p_run_id: runId,
    p_before: cursor,
    p_page_size: 25,
  });
});

it("rejects a cursor borrowed from a different session or run before reading receipts", async () => {
  expect(
    (await get({ runId, cursor: encode({ ...cursor, sessionId: rootSessionId }) })).status,
  ).toBe(400);
  expect((await get({ cursor: encode(cursor) })).status).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
});

it("requires a signed-in user and keeps missing and inaccessible workflow roots indistinguishable", async () => {
  user.mockResolvedValueOnce(null);
  expect((await get({ runId })).status).toBe(401);
  expect(rpc).not.toHaveBeenCalled();

  abortSignal.mockResolvedValue({ data: null, error: null });
  const response = await get({ runId });
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ error: "Workflow not found." });
});

it("returns a fixed error when native authority rejects the cursor", async () => {
  abortSignal.mockResolvedValue({
    data: null,
    error: { code: "22023", message: "private root resolution details" },
  });
  const response = await get({ runId, cursor: encode(cursor) });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Invalid workflow history cursor." });
});

it("forwards exact artifact identity and discards private receipt fields", async () => {
  const artifactId = "88888888-8888-4888-8888-888888888888";
  abortSignal.mockResolvedValue({
    data: {
      ...responsePayload,
      root: { ...responsePayload.root, ownershipToken: rootSessionId },
      events: [
        {
          kind: "artifact",
          id: artifactId,
          recordedAt: cursor.recordedAt,
          state: "awaiting_review",
          detail: { sessionId, runId, artifactId, artifactVersion: 2, bodyMd: "# Private notes" },
        },
      ],
    },
    error: null,
  });

  const response = await get({ runId });
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(payload.root).toEqual(responsePayload.root);
  expect(payload.events[0].detail).toEqual({ sessionId, runId, artifactId, artifactVersion: 2 });
});

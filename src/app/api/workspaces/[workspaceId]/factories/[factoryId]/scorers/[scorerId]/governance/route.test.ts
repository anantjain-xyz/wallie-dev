import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, it, vi } from "vitest";

import { POST as postEvaluation } from "@/app/api/workspaces/[workspaceId]/factories/[factoryId]/evaluation-attempts/[attemptId]/route";
import type { Database } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));

import { POST as postScorer } from "./route";

const id = (suffix: number) => `60900000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const workspaceId = id(1);
const factoryId = id(2);
const actorUserId = id(3);
const scorerId = id(4);
const attemptId = id(5);
const adjudicationId = id(6);
const at = "2026-11-19T23:00:00Z";
const scope = { workspaceId, factoryId };

function fixture(response: Response, visible = true) {
  const rpc = vi.fn<typeof fetch>(async () => response);
  const user = createClient<Database>("http://supabase.test", "reader", {
    auth: { persistSession: false },
    global: { fetch: async () => Response.json(visible ? { id: factoryId } : null) },
  });
  mocks.admin.mockReturnValue(
    createClient<Database>("http://supabase.test", "service-fixture", {
      auth: { persistSession: false },
      global: { fetch: rpc },
    }),
  );
  mocks.access.mockResolvedValue({
    ok: true,
    context: { workspace: { id: workspaceId }, user: { id: actorUserId }, supabase: user },
  });
  return rpc;
}

function request(body: unknown) {
  return new Request("http://wallie.test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function scorer(body: unknown) {
  return postScorer(request(body), { params: Promise.resolve({ ...scope, scorerId }) });
}

function evaluation(body: unknown) {
  return postEvaluation(request(body), { params: Promise.resolve({ ...scope, attemptId }) });
}

beforeEach(() => vi.resetAllMocks());

it("sends the initial pause revision and the signed-in actor to the scoped RPC", async () => {
  const rpc = fixture(
    Response.json({ paused: true, revision: 1, updated_at: at, updated_by: actorUserId }),
  );
  const response = await scorer({ action: "pause", paused: true, expectedRevision: 0 });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({
    action: "pause",
    pause: { paused: true, revision: 1, updated_at: at },
  });
  const [uri, init] = rpc.mock.calls[0] ?? [];
  expect(String(uri)).toMatch(/\/rpc\/configure_factory_scorer_pause$/);
  expect(JSON.parse(String(init?.body))).toEqual({
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_actor_user_id: actorUserId,
    p_scorer_id: scorerId,
    p_expected_revision: 0,
    p_paused: true,
  });
});

it("writes a dispute to the exact evaluation attempt and retains the expected outcome", async () => {
  const rpc = fixture(
    Response.json({
      id: adjudicationId,
      attempt_id: attemptId,
      disposition: "disputed",
      expected_status: "pass",
      note: "Evidence supports passing.",
      created_at: at,
    }),
  );
  const response = await evaluation({
    action: "adjudicate",
    adjudicationId,
    disposition: "disputed",
    expectedStatus: "pass",
    note: " Evidence supports passing. ",
  });
  expect(response.status).toBe(200);
  expect((await response.json()).adjudication).toMatchObject({
    attempt_id: attemptId,
    id: adjudicationId,
    expected_status: "pass",
  });
  const [uri, init] = rpc.mock.calls[0] ?? [];
  expect(String(uri)).toMatch(/\/rpc\/adjudicate_factory_evaluation_receipt$/);
  expect(JSON.parse(String(init?.body))).toEqual({
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_actor_user_id: actorUserId,
    p_attempt_id: attemptId,
    p_adjudication_id: adjudicationId,
    p_disposition: "disputed",
    p_expected_status: "pass",
    p_note: "Evidence supports passing.",
  });
});

it("rejects a request-supplied actor and stops before privileged reads in a hidden factory", async () => {
  fixture(Response.json({}));
  expect(
    (await scorer({ action: "pause", paused: true, expectedRevision: 0, actorUserId: id(9) }))
      .status,
  ).toBe(400);
  expect(mocks.admin).not.toHaveBeenCalled();
  fixture(Response.json({}), false);
  expect((await evaluation({ action: "reevaluate", targetRevisionId: id(8) })).status).toBe(404);
  expect(mocks.admin).not.toHaveBeenCalled();
});

it.each([
  ["42501", 403],
  ["P0002", 404],
  ["PT409", 409],
  ["PT422", 422],
])("maps SQL code %s without exposing private details", async (code, status) => {
  fixture(Response.json({ code, message: "Private database detail" }, { status: 400 }));
  const response = await evaluation({ action: "reevaluate", targetRevisionId: id(8) });
  expect(response.status).toBe(status);
  expect(await response.text()).not.toContain("Private database detail");
});

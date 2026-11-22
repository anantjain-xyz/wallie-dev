import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { POST as cancel } from "@/app/api/workspaces/[workspaceId]/factories/[factoryId]/diagnoses/[diagnosisId]/cancel/route";
import { GET as read } from "@/app/api/workspaces/[workspaceId]/factories/[factoryId]/diagnoses/[diagnosisId]/route";
import { POST as enqueue } from "@/app/api/workspaces/[workspaceId]/factories/[factoryId]/failure-groups/[cohortId]/diagnoses/route";
import type { Database } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));

const id = (slot: number) => "63600000-0000-4000-8000-" + String(slot).padStart(12, "0");
const scope = { workspaceId: id(1), factoryId: id(2) };
const cohortId = id(3);
const diagnosisId = id(4);
const signedIn = id(5);
const command = { requestId: id(6), promptRevisionId: id(7) };
const appOrigin = "https://wallie.test";

const receipt = {
  diagnosis_id: diagnosisId,
  workspace_id: scope.workspaceId,
  factory_id: scope.factoryId,
  cohort_id: cohortId,
  symptom_kind: "validation",
  request_id: command.requestId,
  status: "queued",
  requested_at: "2026-11-22T03:31:00+00:00",
  finished_at: null,
  requested_by_member_id: id(8),
  agent_id: id(9),
  prompt_revision_id: command.promptRevisionId,
  prompt_sha256: "a".repeat(64),
  profile_revision_id: id(10),
  model_id: "vendor/model",
  definition_revision_id: id(11),
  definition_digest: "b".repeat(64),
  skill_revision_ids: [id(12)],
  budget: { max_input_bytes: 40_000, max_output_tokens: 1_200, max_execution_ms: 30_000 },
  minimum_support: 3,
  support_count: 1,
  evidence_digest: null,
  evidence_state: "unavailable",
  evidence: null,
  result: null,
  trace: null,
  usage: null,
};

function transport(response: () => Response, factoryVisible = true) {
  const rpc = vi.fn<typeof fetch>(async () => response());
  const userClient = createClient<Database>("https://diagnosis.test", "browser-fixture", {
    auth: { persistSession: false },
    global: {
      fetch: async (input, init) =>
        String(input).includes("/rpc/")
          ? rpc(input, init)
          : Response.json(factoryVisible ? { id: scope.factoryId } : null),
    },
  });
  mocks.admin.mockReturnValue(
    createClient<Database>("https://diagnosis.test", "admin-fixture", {
      auth: { persistSession: false },
      global: { fetch: rpc },
    }),
  );
  mocks.access.mockResolvedValue({
    ok: true,
    context: { workspace: { id: scope.workspaceId }, user: { id: signedIn }, supabase: userClient },
  });
  return rpc;
}

function request(body: object, origin: string | null = appOrigin) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (origin !== null) headers.set("Origin", origin);
  return new Request(appOrigin, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const cohortParams = { params: Promise.resolve({ ...scope, cohortId }) };
const diagnosisParams = { params: Promise.resolve({ ...scope, diagnosisId }) };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", appOrigin);
});
afterEach(() => vi.unstubAllEnvs());

it.each([null, "https://unrelated.test", "null"])(
  "rejects diagnosis mutations with invalid request origin %s before touching authentication",
  async (origin) => {
    const rpc = transport(() => Response.json(receipt));
    expect((await enqueue(request(command, origin), cohortParams)).status).toBe(403);
    expect((await cancel(request({}, origin), diagnosisParams)).status).toBe(403);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  },
);

it("requires JSON for a same-origin diagnosis request", async () => {
  const rpc = transport(() => Response.json(receipt));
  const incoming = new Request(appOrigin, {
    method: "POST",
    headers: { Origin: appOrigin, "Content-Type": "text/plain" },
    body: JSON.stringify(command),
  });
  expect((await enqueue(incoming, cohortParams)).status).toBe(415);
  expect(rpc).not.toHaveBeenCalled();
});

it("enqueues the exact cohort using the authenticated actor and strips non-receipt fields", async () => {
  const rpc = transport(() =>
    Response.json({ ...receipt, encrypted_api_key: "unprojected secret" }),
  );
  const response = await enqueue(request(command), cohortParams);
  expect(response.status).toBe(202);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ diagnosis: receipt });
  const [url, init] = rpc.mock.calls[0] ?? [];
  expect(String(url)).toMatch(/\/rpc\/request_factory_diagnosis$/);
  expect(JSON.parse(String(init?.body))).toEqual({
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_actor_user_id: signedIn,
    p_cohort_id: cohortId,
    p_request_id: command.requestId,
    p_prompt_revision_id: command.promptRevisionId,
  });
});

it("uses the active signed-in client for diagnosis reads and preserves unavailable evidence", async () => {
  const rpc = transport(() => Response.json(receipt));
  const response = await read(new Request("https://wallie.test"), diagnosisParams);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ diagnosis: receipt });
  const [url, init] = rpc.mock.calls[0] ?? [];
  expect(String(url)).toMatch(/\/rpc\/get_factory_diagnosis$/);
  expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer browser-fixture");
  expect(mocks.admin).not.toHaveBeenCalled();
});

it("keeps cross-factory and forged commands out of the privileged queue", async () => {
  const rpc = transport(() => Response.json(receipt));
  expect((await enqueue(request({ ...command, actorUserId: id(99) }), cohortParams)).status).toBe(
    400,
  );
  expect(mocks.admin).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
  transport(() => Response.json(receipt), false);
  expect((await enqueue(request(command), cohortParams)).status).toBe(404);
  expect(mocks.admin).not.toHaveBeenCalled();
});

it("honors revoked authority on cancel without exposing database diagnostics", async () => {
  const rpc = transport(() =>
    Response.json({ code: "42501", message: "Private diagnostic" }, { status: 403 }),
  );
  const response = await cancel(request({}), diagnosisParams);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: "You do not have permission to manage this diagnosis.",
  });
  const [url, init] = rpc.mock.calls[0] ?? [];
  expect(String(url)).toMatch(/\/rpc\/cancel_factory_diagnosis$/);
  expect(JSON.parse(String(init?.body))).toEqual({
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_actor_user_id: signedIn,
    p_diagnosis_id: diagnosisId,
  });
});

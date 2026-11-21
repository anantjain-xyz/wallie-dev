import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn(), freeze: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/lib/factory-benchmarks/experiment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/factory-benchmarks/experiment")>()),
  freezeBenchmarkExperiment: mocks.freeze,
}));

import { POST } from "./route";

const id = (part: number) => `61700000-0000-4000-8000-${String(part).padStart(12, "0")}`;
const workspaceId = id(1);
const factoryId = id(2);
const actorUserId = id(3);
const params = Promise.resolve({ workspaceId, factoryId });
const command = {
  experimentId: id(4),
  suiteRevisionId: id(5),
  policyRevisionId: id(6),
  definitionRevisionIds: [id(7), id(8)],
  repetitions: 3,
  seed: 21,
  timeoutMs: 60_000,
};
const snapshot = {
  experimentId: command.experimentId,
  suiteRevisionId: command.suiteRevisionId,
  policyRevisionId: command.policyRevisionId,
  repetitions: 3,
  taskCount: 2,
  candidateCount: 2,
  expectedTrialCount: 12,
  materializedTrialCount: 12,
  eligibleTrialCount: 6,
  ineligibleTrialCount: 6,
};

function configureScope(visible = true) {
  const supabase = createClient<Database>("http://factory.test", "reader", {
    auth: { persistSession: false },
    global: {
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        expect(url.pathname).toBe("/rest/v1/factories");
        expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
        expect(url.searchParams.get("id")).toBe(`eq.${factoryId}`);
        return Response.json(visible ? { id: factoryId } : null);
      },
    },
  });
  const admin = createClient<Database>("http://factory.test", "writer", {
    auth: { persistSession: false },
  });
  mocks.access.mockResolvedValue({ ok: true, context: { user: { id: actorUserId }, supabase } });
  mocks.admin.mockReturnValue(admin);
  return admin;
}

function post(body: unknown) {
  return new Request(
    `http://factory.test/api/workspaces/${workspaceId}/factories/${factoryId}/benchmarks/experiments`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("freezing a benchmark experiment", () => {
  beforeEach(() => vi.resetAllMocks());

  it("passes the exact revision pins and authenticated actor and returns frozen counts", async () => {
    const admin = configureScope();
    mocks.freeze.mockResolvedValueOnce(snapshot);
    const request = post(command);
    const result = await POST(request, { params });
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await result.json()).toEqual(snapshot);
    expect(mocks.freeze).toHaveBeenCalledExactlyOnceWith({
      admin,
      workspaceId,
      factoryId,
      actorUserId,
      request: command,
      signal: request.signal,
    });
  });

  it("passes the normalized exact scorer revision set and evaluation budget", async () => {
    const admin = configureScope();
    const evaluation = { scorerRevisionIds: [id(9), id(10)], budgetLimitUsd: 12.345678 };
    mocks.freeze.mockResolvedValueOnce({ ...snapshot, evaluation });
    const request = post({
      ...command,
      evaluation: { ...evaluation, scorerRevisionIds: [id(10), id(9)] },
    });

    const result = await POST(request, { params });

    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ...snapshot, evaluation });
    expect(mocks.freeze).toHaveBeenCalledExactlyOnceWith({
      admin,
      workspaceId,
      factoryId,
      actorUserId,
      request: { ...command, evaluation },
      signal: request.signal,
    });
  });

  it.each([
    { scorerRevisionIds: [], budgetLimitUsd: 1 },
    { scorerRevisionIds: [id(9), id(9)], budgetLimitUsd: 1 },
    { scorerRevisionIds: [id(9)], budgetLimitUsd: 1.2345678 },
  ])("rejects an invalid evaluation plan before a privileged call", async (evaluation) => {
    configureScope();
    const result = await POST(post({ ...command, evaluation }), { params });
    expect(result.status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.freeze).not.toHaveBeenCalled();
  });

  it("rejects client-supplied actor and candidate details before a privileged call", async () => {
    configureScope();
    const result = await POST(post({ ...command, actorUserId: id(9), model: "unknown" }), {
      params,
    });
    expect(result.status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.freeze).not.toHaveBeenCalled();
  });

  it("does not prepare candidates for a factory the caller cannot see", async () => {
    configureScope(false);
    const result = await POST(post(command), { params });
    expect(result.status).toBe(404);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.freeze).not.toHaveBeenCalled();
  });

  it("keeps unexpected service errors out of the response", async () => {
    configureScope();
    mocks.freeze.mockRejectedValueOnce(new Error("private database diagnostic"));
    const result = await POST(post(command), { params });
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({ error: "The comparison could not be saved." });
  });
});

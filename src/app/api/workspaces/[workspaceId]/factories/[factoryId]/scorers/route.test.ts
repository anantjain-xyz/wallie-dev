import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));

import { GET as history, POST as revise } from "./[scorerId]/revisions/route";
import { GET, POST } from "./route";

const workspaceId = "60200000-0000-4000-8000-000000000001";
const factoryId = "60200000-0000-4000-8000-000000000002";
const userId = "60200000-0000-4000-8000-000000000003";
const scorerId = "60200000-0000-4000-8000-000000000004";
const revisionId = "60200000-0000-4000-8000-000000000005";
const current = "2026-11-19T00:00:00+00:00";
const params = Promise.resolve({ workspaceId, factoryId, scorerId });
const definition = {
  schemaVersion: 1,
  rubric: "Review the validation report.",
  requiredEvidence: ["validation_report"],
  scoring: { kind: "boolean", passValue: true },
};
const createCommand = { name: "Delivery quality", slug: "delivery-quality", definition };
const editCommand = { expectedRevisionNumber: 1, definition };
const scorer = {
  id: scorerId,
  name: "Delivery quality",
  slug: "delivery-quality",
  created_at: current,
};
const revision = { id: revisionId, scorer_id: scorerId, revision_number: 1, created_at: current };
const endpoint = `http://localhost/api/workspaces/${workspaceId}/factories/${factoryId}/scorers`;
const revisionEndpoint = `${endpoint}/${scorerId}/revisions`;

function fixture({ visible = true, errorCode }: { visible?: boolean; errorCode?: string } = {}) {
  const read = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith("/factories")) {
      return Response.json(visible ? { id: factoryId } : null);
    }
    if (url.pathname.endsWith("/factory_scorers")) return Response.json([scorer]);
    if (url.pathname.endsWith("/factory_scorer_revisions")) return Response.json([revision]);
    throw new Error(`Unexpected authenticated read of ${url.pathname}`);
  });
  const write = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (errorCode) {
      return Response.json(
        { code: errorCode, message: "Private database error." },
        { status: 400 },
      );
    }
    return Response.json({
      ...revision,
      revision_number: url.pathname.endsWith("/save_factory_scorer_revision") ? 2 : 1,
      definition,
      created_by: userId,
    });
  });
  const client = createClient<Database>("http://factory.test", "reader", {
    auth: { persistSession: false },
    global: { fetch: read },
  });
  const writer = createClient<Database>("http://factory.test", "writer", {
    auth: { persistSession: false },
    global: { fetch: write },
  });
  mocks.access.mockResolvedValue({ ok: true, context: { user: { id: userId }, supabase: client } });
  mocks.admin.mockReturnValue(writer);
  return { read, write };
}

function post(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function callUrl(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : input);
}

describe("factory scorer routes", () => {
  beforeEach(() => vi.resetAllMocks());

  it("lists scoped identities and bounded history through the authenticated client", async () => {
    const { read, write } = fixture();
    const list = await GET(new Request(`${endpoint}?limit=1`), { params });
    const revisions = await history(
      new Request(`${revisionEndpoint}?beforeRevisionNumber=2&limit=1`),
      {
        params,
      },
    );
    expect(list.headers.get("Cache-Control")).toBe("private, no-store");
    expect(revisions.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await list.json()).toEqual({ scorers: [scorer], nextAfterId: null });
    expect(await revisions.json()).toEqual({
      revisions: [revision],
      nextBeforeRevisionNumber: null,
    });
    const historyQuery = read.mock.calls.map(([input]) => callUrl(input)).at(-1);
    expect(historyQuery?.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
    expect(historyQuery?.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
    expect(historyQuery?.searchParams.get("scorer_id")).toBe(`eq.${scorerId}`);
    expect(historyQuery?.searchParams.get("revision_number")).toBe("lt.2");
    expect(historyQuery?.searchParams.get("limit")).toBe("2");
    expect(historyQuery?.searchParams.get("select")).not.toContain("definition");
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps inaccessible factories and caller-supplied authority away from the writer", async () => {
    fixture({ visible: false });
    const hidden = await POST(post(endpoint, createCommand), { params });
    expect(hidden.status).toBe(404);
    fixture();
    const malformed = await POST(post(endpoint, { ...createCommand, actorUserId: userId }), {
      params,
    });
    expect(malformed.status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("preserves the database manager gate for both publish commands", async () => {
    fixture({ errorCode: "42501" });
    for (const response of [
      await POST(post(endpoint, createCommand), { params }),
      await revise(post(revisionEndpoint, editCommand), { params }),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "Only a factory manager can publish scorer revisions.",
      });
    }
  });

  it("passes the authenticated actor, exact scope, and expected revision to the writer", async () => {
    const { write } = fixture();
    const created = await POST(post(endpoint, createCommand), { params });
    const edited = await revise(post(revisionEndpoint, editCommand), { params });
    expect(created.status).toBe(201);
    expect(edited.status).toBe(201);
    expect(await created.json()).toEqual({ revision: { ...revision, definition } });
    expect(await edited.json()).toEqual({
      revision: { ...revision, revision_number: 2, definition },
    });
    const scope = { p_workspace_id: workspaceId, p_factory_id: factoryId, p_actor_user_id: userId };
    expect(
      write.mock.calls.map(([input, init]) => ({
        path: callUrl(input).pathname,
        data: JSON.parse(String(init?.body)),
      })),
    ).toEqual([
      {
        path: "/rest/v1/rpc/create_factory_scorer",
        data: {
          ...scope,
          p_name: createCommand.name,
          p_slug: createCommand.slug,
          p_definition: definition,
        },
      },
      {
        path: "/rest/v1/rpc/save_factory_scorer_revision",
        data: { ...scope, p_scorer_id: scorerId, p_expected_revision: 1, p_definition: definition },
      },
    ]);
  });

  it("returns a reloadable conflict and conceals out-of-scope scorers", async () => {
    const { write } = fixture({ errorCode: "PT409" });
    const conflict = await revise(post(revisionEndpoint, editCommand), { params });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: "The scorer changed. Reload the latest revision before publishing.",
      code: "stale_revision",
    });
    expect(write).toHaveBeenCalledTimes(1);
    fixture({ errorCode: "P0002" });
    const mismatched = await revise(post(revisionEndpoint, editCommand), { params });
    expect(mismatched.status).toBe(404);
    expect(await mismatched.json()).toEqual({
      error: "The scorer is unavailable in this factory.",
    });
  });

  it("rejects invalid rubric rules and oversized bodies without invoking a write", async () => {
    fixture();
    const invalid = await revise(
      post(revisionEndpoint, {
        ...editCommand,
        definition: {
          ...definition,
          scoring: {
            kind: "numeric",
            min: 0,
            max: 1,
            direction: "higher_is_better",
            passThreshold: 0.5,
            failThreshold: 0.5,
          },
        },
      }),
      { params },
    );
    const oversized = await POST(post(endpoint, { ...createCommand, name: "x".repeat(262_145) }), {
      params,
    });
    expect(invalid.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});

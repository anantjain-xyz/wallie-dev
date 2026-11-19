import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { GET, POST } from "./route";

const access = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: access }));

const id = (n: number) => `58100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [workspaceId, factoryId, memoryId, artifactId, revisionId] = [1, 2, 3, 4, 5].map(id);
const params = { params: Promise.resolve({ workspaceId, factoryId }) };
const url = "https://wallie.example.test/api/memories";
const memory = { id: memoryId, workspace_id: workspaceId, factory_id: factoryId };
const scope = { p_workspace_id: workspaceId, p_factory_id: factoryId };

function setup({
  databaseError,
  hiddenFactory,
}: { databaseError?: string; hiddenFactory?: boolean } = {}) {
  const requests: Array<{ url: URL; args: unknown }> = [];
  const supabase = createClient<Database>("https://database.example.test", "user-key", {
    global: {
      fetch: async (input, init) => {
        const route = new URL(input instanceof Request ? input.url : input);
        requests.push({ url: route, args: init?.body ? JSON.parse(String(init.body)) : null });
        if (route.pathname.endsWith("/factories")) {
          return Response.json(hiddenFactory ? null : { id: factoryId });
        }
        if (route.pathname.includes("/rpc/")) {
          if (route.pathname.endsWith("/has_factory_run_memory_proposal"))
            return Response.json(true);
          return databaseError
            ? Response.json({ code: databaseError, message: "Private diagnostic" }, { status: 400 })
            : Response.json(memory);
        }
        expect(route.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
        expect(route.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
        if (route.pathname.endsWith("/factory_memories")) {
          return Response.json(
            route.searchParams.has("id") ? memory : [memory, { ...memory, id: id(6) }],
          );
        }
        expect(route.searchParams.get("memory_id")).toBe(`eq.${memoryId}`);
        if (route.pathname.endsWith("/factory_memory_revisions")) {
          return Response.json([{ id: revisionId, revision_number: 1 }]);
        }
        if (route.pathname.endsWith("/factory_memory_revision_bodies")) {
          return Response.json([]);
        }
        if (route.pathname.endsWith("/factory_memory_review_events")) {
          expect(route.searchParams.get("or")).toContain("revision_id.is.null");
          return Response.json([{ id: id(7), action: "forgotten", revision_id: null }]);
        }
        throw new Error("Unexpected fixture query.");
      },
    },
  });
  access.mockResolvedValue({ ok: true, context: { supabase } });
  return requests;
}

function post(payload: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => access.mockReset());

describe("factory memory management", () => {
  it("reports proposal availability for one exact artifact without returning its staged body", async () => {
    const requests = setup();
    const result = await GET(
      new Request(`${url}?artifactId=${artifactId}&artifactVersion=3`),
      params,
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ available: true });
    expect(requests.at(-1)?.args).toEqual({
      ...scope,
      p_artifact_id: artifactId,
      p_artifact_version: 3,
    });
  });

  it("imports the exact accepted artifact through the viewer identity", async () => {
    const requests = setup();
    const result = await POST(
      post({ action: "propose", artifactId, artifactVersion: 3, title: "Observed convention" }),
      params,
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(requests.at(-1)).toMatchObject({
      args: {
        ...scope,
        p_artifact_id: artifactId,
        p_artifact_version: 3,
        p_title: "Observed convention",
      },
    });
    expect(requests.at(-1)?.url.pathname).toMatch(/\/rpc\/propose_factory_memory$/);
  });

  it("rejects proposal bodies supplied by the caller and unbounded corrections", async () => {
    const requests = setup();
    const invalid = [
      { action: "propose", artifactId, artifactVersion: 3, title: "Observation", body: "Forged" },
      {
        action: "correct",
        memoryId,
        expectedCurrentRevisionId: null,
        expectedPendingRevisionId: revisionId,
        body: "é".repeat(2049),
      },
    ];
    for (const input of invalid) {
      expect((await POST(post(input), params)).status).toBe(400);
    }
    expect(requests.some((request) => request.url.pathname.includes("/rpc/"))).toBe(false);
  });

  it("propagates a stale decision as 409 while withholding internal database details", async () => {
    const requests = setup({ databaseError: "PT409" });
    const result = await POST(
      post({
        action: "review",
        memoryId,
        decision: "approve",
        expectedCurrentRevisionId: null,
        expectedPendingRevisionId: revisionId,
      }),
      params,
    );
    expect(result.status).toBe(409);
    expect(await result.text()).not.toContain("Private diagnostic");
    expect(requests.at(-1)?.args).toEqual({
      ...scope,
      p_memory_id: memoryId,
      p_decision: "approve",
      p_expected_pending_revision_id: revisionId,
    });
  });

  it("keeps forgotten provenance without reconstructing a deleted body", async () => {
    setup();
    const result = await GET(new Request(`${url}?memoryId=${memoryId}`), params);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      memory,
      revisions: [{ id: revisionId, revision_number: 1, body_md: null }],
      decisions: [{ action: "forgotten", revision_id: null }],
      nextBeforeVersion: null,
    });
  });

  it("returns only scoped metadata and a stable list cursor", async () => {
    setup();
    const result = await GET(new Request(`${url}?limit=1`), params);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ memories: [memory], nextAfterId: memoryId });
  });

  it("does not query memory in an inaccessible factory", async () => {
    const requests = setup({ hiddenFactory: true });
    expect((await GET(new Request(url), params)).status).toBe(404);
    expect(requests).toHaveLength(1);
  });
});

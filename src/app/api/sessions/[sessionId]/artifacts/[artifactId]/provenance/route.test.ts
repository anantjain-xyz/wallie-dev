import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";
import type { Database } from "@/lib/supabase/database.types";

const mock = vi.hoisted(() => ({ user: vi.fn(), supabase: vi.fn() }));
vi.mock("@/lib/supabase/auth", () => ({ getSupabaseUserOrNull: mock.user }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mock.supabase }));

const sessionId = "11111111-1111-4111-8111-111111111111";
const artifactId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";

function fixture(overrides: Record<string, object[]> = {}) {
  const queries: URL[] = [];
  const data: Record<string, object[]> = {
    sessions: [{ id: sessionId, workspace_id: workspaceId }],
    workspace_members: [{ id: "member", role: "member" }],
    session_artifacts: [{ id: artifactId, session_id: sessionId, workspace_id: workspaceId }],
    workspaces: [{ slug: "acme" }],
    session_git_checkpoints: [{ run_id: runId }],
    ...overrides,
  };
  mock.supabase.mockReturnValue(
    createClient<Database>("https://database.example.test", "test-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (request) => {
          const url = new URL(
            typeof request === "string" ? request : request instanceof URL ? request : request.url,
          );
          queries.push(url);
          return Response.json(data[url.pathname.split("/").at(-1) ?? ""] ?? []);
        },
      },
    }),
  );
  return queries;
}

function load(selectedArtifact = artifactId) {
  return GET(
    new Request(
      `https://wallie.test/api/sessions/${sessionId}/artifacts/${selectedArtifact}/provenance`,
    ),
    { params: Promise.resolve({ sessionId, artifactId: selectedArtifact }) },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mock.user.mockResolvedValue({ id: userId });
});

describe("review artifact provenance", () => {
  it("binds an authorized physical artifact to exactly its accepted attempt", async () => {
    const queries = fixture();
    const response = await load();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ workspaceId, workspaceSlug: "acme", runId });
    const checkpoint = queries.find((query) => query.pathname.endsWith("/session_git_checkpoints"));
    expect(Object.fromEntries(checkpoint!.searchParams)).toEqual({
      select: "run_id",
      artifact_id: `eq.${artifactId}`,
      session_id: `eq.${sessionId}`,
      workspace_id: `eq.${workspaceId}`,
    });
    expect(queries.map((query) => query.pathname.split("/").at(-1)).sort()).toEqual([
      "session_artifacts",
      "session_git_checkpoints",
      "sessions",
      "workspace_members",
      "workspaces",
    ]);
  });

  it("leaves a historical artifact without a checkpoint unlinked", async () => {
    fixture({ session_git_checkpoints: [] });
    expect(await (await load()).json()).toEqual({
      workspaceId,
      workspaceSlug: "acme",
      runId: null,
    });
  });

  it.each([
    { table: "sessions", status: 404 },
    { table: "workspace_members", status: 403 },
    { table: "session_artifacts", status: 404 },
    { table: "workspaces", status: 404 },
  ])("does not look up a checkpoint when $table is unavailable", async ({ table, status }) => {
    const queries = fixture({ [table]: [] });
    const response = await load();
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(runId);
    expect(queries.some((query) => query.pathname.endsWith("/session_git_checkpoints"))).toBe(
      false,
    );
  });

  it("requires authorization and a valid physical artifact id", async () => {
    const queries = fixture();
    mock.user.mockResolvedValue(null);
    expect((await load()).status).toBe(401);
    expect((await load("2")).status).toBe(400);
    expect(queries).toHaveLength(0);
  });
});

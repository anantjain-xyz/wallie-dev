import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { loadFactoryActivityData } from "@/features/factory-activity/activity-data";
import type { ActivityQuery } from "@/features/factory-activity/activity-query";
import type { Database } from "@/lib/supabase/database.types";

const workspaceId = "88458b88-ec52-4e8e-a441-b6e6a9186bd3";
const factory = { id: "d18b4467-122d-4367-8628-f76856b8615e", name: "Research" };
const actorId = "17575802-5051-4835-a916-9f6419560ab6";
const runId = "217ccf29-a6d8-4bc7-8825-8081502dc5c8";
const timestamp = "2026-11-18T15:45:00.123456+00:00";

function supabaseWith(fetch: typeof globalThis.fetch) {
  return createClient<Database>("https://activity.example.test", "viewer-fixture", {
    auth: { persistSession: false },
    global: { fetch },
  });
}

function jsonResponse(rows: object[], contentRange?: string) {
  return Response.json(rows, { headers: contentRange ? { "content-range": contentRange } : {} });
}

describe("factory activity data", () => {
  it("requests exact bounded filtered rows and attributes each to its recorded actor and factory", async () => {
    const requests = new Map<string, { params: URLSearchParams; prefer: string | null }>();
    const actor = { full_name: "Sam Roberts", username: "sam", kind: "human" };
    const supabase = supabaseWith(async (input, init) => {
      const url = new URL(String(input));
      requests.set(url.pathname, {
        params: url.searchParams,
        prefer: new Headers(init?.headers).get("prefer"),
      });
      if (url.pathname.endsWith("/sessions")) {
        return jsonResponse(
          [
            {
              id: "35de4887-3414-4614-b9a2-27bca7df5363",
              number: 42,
              title: "Qualify research",
              phase_status: "completed",
              archived_at: null,
              updated_at: timestamp,
              creator_member_id: actorId,
              factory,
              actor,
            },
          ],
          "0-0/14",
        );
      }
      expect(url.pathname).toBe("/rest/v1/agent_runs");
      return jsonResponse(
        [
          {
            id: runId,
            created_at: timestamp,
            status: "error",
            stage_name: "Validate",
            model_provider: "codex",
            model_name: "gpt-5",
            triggered_by_member_id: actorId,
            session: { title: "Qualify research", factory },
            actor,
          },
        ],
        "0-0/23",
      );
    });

    const data = await loadFactoryActivityData({
      supabase,
      workspaceId,
      workspaceSlug: "wallie",
      query: { factory: factory.id, actor: actorId, status: "error" },
    });

    expect(data.sessions).toMatchObject({
      kind: "available",
      count: 14,
      rows: [
        {
          href: "/w/wallie/sessions/42",
          title: "Qualify research",
          factory,
          actor: { id: actorId, label: "Sam Roberts" },
        },
      ],
    });
    expect(data.runs).toMatchObject({
      kind: "available",
      count: 23,
      rows: [
        {
          href: "/w/wallie/runs/" + runId,
          title: "Qualify research",
          description: "Validate · Codex · gpt-5",
          factory,
          actor: { id: actorId, label: "Sam Roberts" },
        },
      ],
    });

    const sessions = requests.get("/rest/v1/sessions");
    const runs = requests.get("/rest/v1/agent_runs");
    for (const request of [sessions, runs]) {
      expect(request?.prefer).toBe("count=exact");
      expect(request?.params.get("workspace_id")).toBe("eq." + workspaceId);
      expect(request?.params.get("actor.workspace_id")).toBe("eq." + workspaceId);
      expect(request?.params.get("limit")).toBe("11");
      expect(request?.params.get("select")).toContain(
        "factory:factories!sessions_workspace_factory_fkey!inner(",
      );
    }
    expect(sessions?.params.get("factory_id")).toBe("eq." + factory.id);
    expect(sessions?.params.get("creator_member_id")).toBe("eq." + actorId);
    expect(sessions?.params.has("status")).toBe(false);
    expect(sessions?.params.get("order")).toBe("updated_at.desc,id.desc");
    expect(runs?.params.get("select")).toContain(
      "session:sessions!agent_runs_session_id_fkey!inner(",
    );
    expect(runs?.params.get("session.workspace_id")).toBe("eq." + workspaceId);
    expect(runs?.params.get("session.factory_id")).toBe("eq." + factory.id);
    expect(runs?.params.get("triggered_by_member_id")).toBe("eq." + actorId);
    expect(runs?.params.get("status")).toBe("eq.error");
    expect(runs?.params.get("order")).toBe("created_at.desc,id.desc");
  });

  it("distinguishes an empty source from a source without a reliable count", async () => {
    const supabase = supabaseWith(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.has("factory_id")).toBe(false);
      expect(url.searchParams.has("session.factory_id")).toBe(false);
      return url.pathname.endsWith("/sessions") ? jsonResponse([], "*/0") : jsonResponse([]);
    });

    const data = await loadFactoryActivityData({
      supabase,
      workspaceId,
      workspaceSlug: "wallie",
      query: { factory: "all" },
    });

    expect(data.sessions).toEqual({ kind: "available", count: 0, rows: [] });
    expect(data.runs).toEqual({ kind: "unavailable" });
  });

  it("reports a failed source as unavailable and retains a safe link for a recorded actor whose label is missing", async () => {
    const supabase = supabaseWith(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/sessions")) {
        return Response.json({ code: "42501", message: "Permission denied" }, { status: 403 });
      }
      return jsonResponse(
        [
          {
            id: runId,
            created_at: timestamp,
            status: "queued",
            stage_name: null,
            model_provider: "codex",
            model_name: "gpt-5",
            triggered_by_member_id: actorId,
            session: { title: "Queued run with unavailable actor label", factory },
            actor: null,
          },
        ],
        "0-0/1",
      );
    });

    const data = await loadFactoryActivityData({
      supabase,
      workspaceId,
      workspaceSlug: "wallie",
      query: { factory: "all" },
    });

    expect(data.sessions).toEqual({ kind: "unavailable" });
    expect(data.runs).toMatchObject({
      kind: "available",
      count: 1,
      rows: [{ actor: { id: actorId, label: "Name unavailable" } }],
    });
  });

  it("continues runs at the exact timestamp and ID, preserving original scoped totals", async () => {
    const ids = Array.from(
      { length: 11 },
      (_, i) => `71a5cf29-a6d8-4bc7-8825-8081502dc5${(20 - i).toString(16).padStart(2, "0")}`,
    );
    const requests: { table: string; method: string; params: URLSearchParams }[] = [];
    const supabase = supabaseWith(async (input, init) => {
      const { pathname, searchParams } = new URL(String(input));
      requests.push({
        table: pathname.split("/").at(-1)!,
        method: init?.method ?? "GET",
        params: searchParams,
      });
      if (pathname.endsWith("/sessions")) return jsonResponse([], "*/0");
      if (init?.method === "HEAD")
        return new Response(null, { headers: { "content-range": "*/11" } });
      return jsonResponse(
        (searchParams.has("or") ? ids.slice(10) : ids).map((id) => ({
          id,
          created_at: timestamp,
          status: "error",
          model_provider: "codex",
          triggered_by_member_id: actorId,
          session: { title: "Qualify research", factory },
          actor: null,
        })),
        searchParams.has("or") ? undefined : "0-10/11",
      );
    });
    const query: ActivityQuery = { factory: factory.id, actor: actorId, status: "error" };
    const context = { supabase, workspaceId, workspaceSlug: "wallie" };
    const initial = await loadFactoryActivityData({ ...context, query });
    if (initial.runs.kind !== "available") throw new Error("Missing run page");
    expect(initial.runs.rows.map((row) => row.id)).toEqual(ids.slice(0, 10));
    expect(initial.runs.olderQuery).toMatchObject({ ...query, runsBefore: expect.any(String) });
    const next = initial.runs.olderQuery!;
    requests.length = 0;

    const older = await loadFactoryActivityData({ ...context, query: next });
    expect(older.runs).toMatchObject({
      kind: "available",
      count: 11,
      rows: [{ id: ids[10] }],
    });
    expect(older.runs).not.toHaveProperty("olderQuery");
    for (const { table, method, params } of requests) {
      if (table === "sessions") {
        expect(params.has("or")).toBe(false);
        continue;
      }
      expect(params.get("session.factory_id")).toBe("eq." + factory.id);
      expect(params.get("triggered_by_member_id")).toBe("eq." + actorId);
      expect(params.get("status")).toBe("eq.error");
      expect(params.get("or")).toBe(
        method === "HEAD"
          ? null
          : `(created_at.lt.${timestamp},and(created_at.eq.${timestamp},id.lt.${ids[9]}))`,
      );
    }

    requests.length = 0;
    await loadFactoryActivityData({ ...context, query: { ...next, status: "success" } });
    expect(requests.some(({ params }) => params.has("or"))).toBe(false);
  });
});

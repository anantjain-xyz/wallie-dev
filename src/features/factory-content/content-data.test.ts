import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { loadMemoryPage, parseMemoryQuery } from "./content-data";

const id = (n: number) => `58100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [workspaceId, factoryId, actorId, memoryId, revisionId, decisionId, cursorId] = [
  1, 2, 3, 4, 5, 6, 7,
].map(id);
const createdAt = "2024-01-02T12:30:00.000123+00:00";

function mockScope(read: (table: string, search: URLSearchParams) => Response) {
  const calls: string[] = [];
  const supabase = createClient<Database>("https://database.example.test", "user-key", {
    global: {
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const table = url.pathname.split("/").at(-1)!;
        calls.push(table);
        if (table.startsWith("factory_memory") || table === "factory_memories") {
          expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
          expect(url.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
        }
        return read(table, url.searchParams);
      },
    },
  });
  const scope = {
    workspaceId,
    workspaceSlug: "atlas",
    factory: { id: factoryId, name: "Atlas", status: "active" as const, isDefault: true },
    actorUserId: actorId,
    isOperator: true,
    supabase,
  };
  return { scope, calls };
}

it("uses a scoped, literal title filter and newest-first cursor with an exact timestamp tie-break", async () => {
  const { scope, calls } = mockScope((table, query) => {
    expect(table).toBe("factory_memories");
    if (query.get("id")) {
      expect(query.get("id")).toBe(`eq.${cursorId}`);
      expect(query.get("select")).toBe("created_at");
      return Response.json([{ created_at: createdAt }]);
    }
    expect(query.get("order")).toBe("created_at.desc,id.desc");
    expect(query.get("or")).toBe(
      `(created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${cursorId}))`,
    );
    expect(query.get("title")).toBe(String.raw`imatch.\[Build\] \* \(100%\)`);
    expect(query.get("limit")).toBe("21");
    return Response.json(
      Array.from({ length: 21 }, (_, index) => ({
        id: id(50 - index),
        current_revision_id: null,
        pending_revision_id: null,
        forgotten_at: null,
      })),
    );
  });
  const parsed = parseMemoryQuery({ after: cursorId, q: "  [Build] * (100%)  " });
  if (!parsed.success) throw parsed.error;
  const { list } = await loadMemoryPage(scope, parsed.data);
  expect(list?.items).toHaveLength(20);
  expect(list?.nextMemory).toBe(id(31));
  expect(calls).toEqual(["factory_memories", "factory_memories"]);
});

it("batches read-only eligibility metadata without fetching any note bodies", async () => {
  const { scope, calls } = mockScope((table, query) => {
    if (table === "factory_memories") {
      return Response.json([
        { id: id(11), current_revision_id: id(21) },
        { id: id(12), current_revision_id: id(22) },
        { id: id(13), current_revision_id: id(23) },
        { id: id(14), current_revision_id: null, pending_revision_id: id(24) },
        { id: id(15), current_revision_id: null, pending_revision_id: id(25) },
      ]);
    }
    if (table === "workspaces") {
      expect(query.get("id")).toBe(`eq.${workspaceId}`);
      return Response.json({ deletion_requested_at: null });
    }
    expect(table).toBe("factory_memory_revisions");
    expect(query.get("select")).toBe("id,expires_at,factory_memory_revision_bodies(revision_id)");
    expect(query.get("id")).toBe(`in.(${[21, 22, 23, 24, 25].map(id).join(",")})`);
    return Response.json(
      [21, 22, 23, 24, 25].map((n) => ({
        id: id(n),
        expires_at: n === 22 || n === 25 ? createdAt : null,
        factory_memory_revision_bodies: n === 23 || n === 25 ? [] : [{ revision_id: id(n) }],
      })),
    );
  });
  const result = await loadMemoryPage(scope, {});
  expect(result.list?.items.map(({ eligibility }) => eligibility)).toEqual([
    "eligible",
    "expired",
    "note-unavailable",
    "awaiting-review",
    "expired",
  ]);
  expect(calls.sort()).toEqual(["factory_memories", "factory_memory_revisions", "workspaces"]);
});

it("loads the exact revision and decision, then batches actor names using the viewer’s workspace", async () => {
  const actorIds = [actorId, id(30), id(31)];
  const { scope, calls } = mockScope((table, query) => {
    switch (table) {
      case "factory_memories":
        return Response.json([
          {
            id: memoryId,
            current_revision_id: null,
            pending_revision_id: null,
            source_session_id: id(40),
            source_artifact_id: id(41),
            source_artifact_version: 3,
          },
        ]);
      case "factory_memory_revisions":
        expect(query.get("memory_id")).toBe(`eq.${memoryId}`);
        if (!query.has("id")) return Response.json([{ id: id(42) }]);
        expect(query.get("id")).toBe(`eq.${revisionId}`);
        return Response.json([{ id: revisionId }]);
      case "factory_memory_revision_bodies":
        expect(query.get("revision_id")).toBe(`eq.${revisionId}`);
        return Response.json([{ body_md: "The original release checklist." }]);
      case "factory_memory_review_events":
        if (query.has("id")) {
          expect(query.get("id")).toBe(`eq.${decisionId}`);
          expect(query.get("revision_id")).toBe(`eq.${revisionId}`);
          return Response.json([{ id: decisionId, actor_member_id: actorId }]);
        }
        return Response.json(actorIds.map((actor_member_id) => ({ actor_member_id })));
      case "workspace_members":
        expect(query.get("workspace_id")).toBe(`eq.${workspaceId}`);
        expect(query.get("kind")).toBe("eq.human");
        expect(query.get("id")).toBe(`in.(${actorIds.join(",")})`);
        return Response.json([
          { id: actorId, full_name: "Maya Chen", is_active: true },
          { id: actorIds[1], full_name: "Inactive name", is_active: false },
        ]);
      case "sessions":
        expect(query.get("id")).toBe(`eq.${id(40)}`);
        return Response.json([{ number: 12 }]);
      case "session_artifacts":
        expect(query.get("id")).toBe(`eq.${id(41)}`);
        expect(query.get("version")).toBe("eq.3");
        return Response.json([{ stage_slug: "build" }]);
      default:
        throw new Error(`Unexpected query for ${table}`);
    }
  });
  const { detail, list } = await loadMemoryPage(scope, {
    memory: memoryId,
    revision: revisionId,
    decision: decisionId,
  });
  expect(list).toBeNull();
  expect(detail).toMatchObject({
    revision: { id: revisionId },
    requestedDecision: { id: decisionId },
    body: "The original release checklist.",
    actorNames: { [actorId]: "Maya Chen", [actorIds[1]]: "Former member" },
    sourceSessionNumber: 12,
    sourceArtifactStage: "build",
  });
  expect(detail?.actorNames[actorIds[2]]).toBeUndefined();
  expect(calls.filter((table) => table === "workspace_members")).toHaveLength(1);
});

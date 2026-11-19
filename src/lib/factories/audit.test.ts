import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { FactoryAuditCursorError, readFactoryAuditPage, type FactoryAuditSource } from "./audit";

const workspaceId = "56200000-0000-4000-8000-000000000001";
const factoryId = "56200000-0000-4000-8000-000000000002";
const sourceId = "56200000-0000-4000-8000-000000000003";
const otherFactoryId = "56200000-0000-4000-8000-000000000004";
const createdAt = "2026-11-18T20:15:00.123456+00:00";
const eventId = "9007199254740993";
const previousEventId = "9007199254740992";

function fixture(responses: unknown[][]) {
  const requests: URL[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    requests.push(new URL(input instanceof Request ? input.url : input));
    return Response.json(responses[requests.length - 1] ?? []);
  });
  const client = createClient<Database>("http://factory-audit.test", "fixture", {
    auth: { persistSession: false },
    global: { fetch },
  });
  return { client, requests };
}

function row(id: string) {
  return {
    event_id: id,
    factory_id: factoryId,
    action: "execution_grant.revoked",
    actor_member_id: sourceId,
    subject_member_id: null,
    detail: { id: sourceId, version: 3 },
    created_at: createdAt,
  };
}

describe("factory audit query", () => {
  it("paginates using the exact microsecond timestamp and numeric event ID", async () => {
    const { client, requests } = fixture([
      [row(eventId), row(previousEventId)],
      [row(previousEventId)],
    ]);
    const query = { facet: "governance", limit: 1 } as const;
    const firstPage = await readFactoryAuditPage(client, workspaceId, factoryId, query);
    expect(firstPage.events.map((event) => event.id)).toEqual([eventId]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await readFactoryAuditPage(client, workspaceId, factoryId, {
      ...query,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.events.map((event) => event.id)).toEqual([previousEventId]);
    expect(secondPage.nextCursor).toBeNull();
    const search = requests[1].searchParams;
    expect(search.get("workspace_id")).toBe(`eq.${workspaceId}`);
    expect(search.get("factory_id")).toBe(`eq.${factoryId}`);
    expect(search.get("limit")).toBe("2");
    expect(search.get("order")).toBe("created_at.desc,id.desc");
    expect(search.get("select")).toContain("event_id:id::text");
    expect(search.get("or")).toBe(
      `(created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${eventId}))`,
    );
  });

  it("rejects a cursor issued for a different factory, resource or facet before querying", async () => {
    const { client, requests } = fixture([[row(eventId), row(previousEventId)]]);
    const source = { kind: "grant", id: sourceId } as const;
    const page = await readFactoryAuditPage(client, workspaceId, factoryId, { limit: 1, source });
    const cursor = page.nextCursor ?? undefined;
    await expect(
      readFactoryAuditPage(client, workspaceId, otherFactoryId, { cursor, source }),
    ).rejects.toThrow(FactoryAuditCursorError);
    await expect(
      readFactoryAuditPage(client, workspaceId, factoryId, {
        cursor,
        source: { kind: "principal", id: sourceId },
      }),
    ).rejects.toThrow(FactoryAuditCursorError);
    await expect(
      readFactoryAuditPage(client, workspaceId, factoryId, { cursor, source, facet: "governance" }),
    ).rejects.toThrow(FactoryAuditCursorError);
    await expect(
      readFactoryAuditPage(client, workspaceId, factoryId, { cursor: "forged,or" }),
    ).rejects.toThrow(FactoryAuditCursorError);
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["principal", "detail->>id", "in.(service_principal.created)"],
    ["binding", "detail->>bindingId", "in.(credential_binding.created,credential_binding.revoked)"],
    [
      "mcp-binding",
      "detail->>bindingId",
      "in.(mcp_secret_binding.created,mcp_secret_binding.revoked)",
    ],
  ] satisfies Array<[FactoryAuditSource["kind"], string, string]>)(
    "matches the exact %s source action and ID",
    async (kind, field, actions) => {
      const { client, requests } = fixture([[]]);
      await readFactoryAuditPage(client, workspaceId, factoryId, {
        source: { kind, id: sourceId },
        facet: "governance",
      });
      expect(requests[0].searchParams.get("action")).toBe(actions);
      expect(requests[0].searchParams.get(field)).toBe(`eq.${sourceId}`);
    },
  );

  it("paginates grant actions and token actions using their own exact grant fields", async () => {
    const { client, requests } = fixture([
      [row(eventId), row(previousEventId)],
      [row(previousEventId)],
    ]);
    const query = {
      source: { kind: "grant", id: sourceId },
      facet: "governance",
      limit: 1,
    } as const;
    const firstPage = await readFactoryAuditPage(client, workspaceId, factoryId, query);
    await readFactoryAuditPage(client, workspaceId, factoryId, {
      ...query,
      cursor: firstPage.nextCursor ?? undefined,
    });

    const filter =
      `(and(action.in.(execution_grant.approved,execution_grant.updated,execution_grant.revoked),detail->>id.eq.${sourceId}),` +
      `and(action.in.(machine_token.issued,machine_token.revoked),detail->>grantId.eq.${sourceId}))`;
    for (const { searchParams } of requests) {
      expect(searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
      expect(searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
    }
    expect(requests[0].searchParams.getAll("or")).toEqual([filter]);
    expect(requests[1].searchParams.getAll("or")).toEqual([
      filter,
      `(created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${eventId}))`,
    ]);
  });

  it("supports exact event and actor links", async () => {
    const { client, requests } = fixture([[], []]);
    await readFactoryAuditPage(client, workspaceId, factoryId, {
      source: { kind: "event", id: eventId },
    });
    await readFactoryAuditPage(client, workspaceId, factoryId, {
      source: { kind: "actor", id: sourceId },
      facet: "governance",
    });
    expect(requests[0].searchParams.get("id")).toBe(`eq.${eventId}`);
    expect(requests[0].searchParams.get("action")).toBeNull();
    expect(requests[1].searchParams.get("actor_member_id")).toBe(`eq.${sourceId}`);
    expect(requests[1].searchParams.get("action")).toContain("execution_grant.revoked");
    expect(requests[1].searchParams.get("action")).not.toContain("membership.granted");
  });
});

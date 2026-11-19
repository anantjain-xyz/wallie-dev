import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import { loadGovernance } from "@/features/factory-governance/governance-data";
import type { Database } from "@/lib/supabase/database.types";

function fixtureId(value: number) {
  return `47fa1e80-b955-4d48-b776-${String(value).padStart(12, "0")}`;
}

const workspaceId = fixtureId(2001);
const factoryId = fixtureId(2002);
const revisionId = fixtureId(2003);
const publishedBindingId = fixtureId(1197);
const selectedBindingId = fixtureId(1199);

vi.mock("@/lib/factories/audit", () => ({
  readFactoryAuditPage: async () => ({ events: [], nextCursor: null }),
}));

vi.mock("@/lib/factory-definitions/authority", () => ({
  loadFactoryDefinitionRepositories: async () => [],
}));

vi.mock("@/lib/factory-definitions/storage", () => ({
  selectCurrentFactoryActivation: async () => ({ data: { revision_id: revisionId }, error: null }),
  selectStoredFactoryDefinition: async () => ({
    data: { id: revisionId, definition_json: "fixture", canonical_digest: "fixture" },
    error: null,
  }),
}));

vi.mock("@/lib/factory-definitions/stored-definition", () => ({
  readVerifiedFactoryDefinition: () => ({
    credentialBindingId: publishedBindingId,
    executionGrant: { id: fixtureId(2004), version: 1 },
  }),
}));

it("uses a scoped server cursor and resolves selected and published bindings independently", async () => {
  const requests: Database["public"]["Functions"]["read_factory_credential_ownership"]["Args"][] =
    [];
  const supabase = createClient<Database>("https://governance.example.test", "viewer-fixture", {
    auth: { persistSession: false },
    global: {
      fetch: async (input, init) => {
        if (!new URL(String(input)).pathname.endsWith("/rpc/read_factory_credential_ownership")) {
          return Response.json([]);
        }
        const args = JSON.parse(String(init?.body)) as (typeof requests)[number];
        requests.push(args);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer viewer-fixture");
        const rows = Array.from({ length: 1200 }, (_, index) => ({
          id: fixtureId(index + 1),
          status: "ready",
        }));
        if (args.p_binding_id) {
          return Response.json(rows.filter(({ id }) => id === args.p_binding_id));
        }
        return Response.json(
          rows
            .filter(({ id }) => !args.p_after_id || id > args.p_after_id)
            .slice(0, args.p_limit ?? 1000),
        );
      },
    },
  });

  const governance = {
    workspaceId,
    actorUserId: fixtureId(2005),
    workspaceSlug: "wallie",
    supabase,
    factory: {
      id: factoryId,
      isDefault: false,
      name: "Finance",
      status: "active" as const,
      canManage: true,
    },
    isOperator: true,
  };
  const data = await loadGovernance(governance, { afterBinding: fixtureId(1000) });

  const ids = data.bindings.map(({ id }) => id);
  expect(ids).toHaveLength(21);
  expect(new Set(ids)).toEqual(
    new Set([
      publishedBindingId,
      ...Array.from({ length: 20 }, (_, index) => fixtureId(1001 + index)),
    ]),
  );
  expect(data.nextBinding).toBe(fixtureId(1020));
  const scope = { p_workspace_id: workspaceId, p_factory_id: factoryId };
  expect(requests).toHaveLength(2);
  expect(requests).toEqual(
    expect.arrayContaining([
      { ...scope, p_after_id: fixtureId(1000), p_limit: 21 },
      { ...scope, p_binding_id: publishedBindingId },
    ]),
  );

  requests.length = 0;
  const focused = await loadGovernance(governance, {
    source: { kind: "binding", id: selectedBindingId },
  });
  expect(focused.bindings.map(({ id }) => id)).toEqual([selectedBindingId]);
  expect(focused.selectedBindingId).toBe(selectedBindingId);
  expect(requests).toEqual([{ ...scope, p_binding_id: selectedBindingId }]);
});

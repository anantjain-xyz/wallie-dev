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

function governanceScope(supabase: ReturnType<typeof createClient<Database>>) {
  return {
    workspaceId,
    actorUserId: fixtureId(2005),
    actorMemberId: fixtureId(2006),
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
}

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

  const governance = governanceScope(supabase);
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

it("resolves off-page principals with factory scope independently of the picker and list cursor", async () => {
  const requests: URL[] = [];
  const principalRows = Array.from({ length: 25 }, (_, index) => ({
    id: fixtureId(index + 1),
    name: `Runner ${index + 1}`,
    slug: `runner-${index + 1}`,
  }));
  const grant = {
    id: fixtureId(2100),
    service_principal_id: fixtureId(25),
    github_repository_id: fixtureId(2101),
    read_context_repository_ids: [],
    tool_ids: [],
    execution_policy_revision_id: fixtureId(2102),
    version: 2,
    revoked_at: null,
    expires_at: "2099-01-01T00:00:00Z",
  };
  const supabase = createClient<Database>("https://governance.example.test", "viewer-fixture", {
    auth: { persistSession: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const table = url.pathname.split("/").at(-1);
        if (
          ["service_principals", "factory_execution_grants", "github_repositories"].includes(
            table ?? "",
          )
        ) {
          requests.push(url);
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer viewer-fixture");
          expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
          expect(url.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
        }
        switch (table) {
          case "service_principals": {
            const filter = url.searchParams.get("id");
            if (filter?.startsWith("in.")) {
              expect(filter).toBe(`in.(${fixtureId(25)})`);
              return Response.json(principalRows.slice(-1));
            }
            return Response.json(principalRows.slice(0, Number(url.searchParams.get("limit"))));
          }
          case "factory_execution_grants":
            return Response.json([grant]);
          case "github_repositories":
            return Response.json([
              { id: grant.github_repository_id, full_name: "example/releases", is_archived: true },
            ]);
          default:
            return Response.json([]);
        }
      },
    },
  });
  const data = await loadGovernance(governanceScope(supabase), {});
  expect(data.principalList.entries).toHaveLength(20);
  expect(data.principalList.entries.map(({ id }) => id)).not.toContain(fixtureId(25));
  expect(data.principalOptions).toContainEqual({
    id: fixtureId(25),
    label: "Runner 25 (runner-25)",
  });
  expect(data.evidence.principals).toEqual([principalRows[24]]);
  expect(data.evidence.repositories).toEqual([
    { id: grant.github_repository_id, full_name: "example/releases", is_archived: true },
  ]);
  expect(requests.filter((url) => url.pathname.endsWith("/service_principals"))).toHaveLength(3);
});

it.each([
  { failingTable: null, entries: [] },
  { failingTable: "factory_machine_tokens", entries: [] },
  { failingTable: "factory_oauth_client_bindings", entries: ["Machine token: Release job"] },
])(
  "retains focused grant dependency evidence when $failingTable fails",
  async ({ failingTable, entries }) => {
    const grant = {
      id: fixtureId(2100),
      service_principal_id: fixtureId(25),
      github_repository_id: fixtureId(2101),
      read_context_repository_ids: [],
      tool_ids: [],
      execution_policy_revision_id: fixtureId(2102),
      version: 2,
      revoked_at: null,
      expires_at: "2099-01-01T00:00:00Z",
    };
    const dependencyReads: string[] = [];
    const credentialReads: string[] = [];
    const supabase = createClient<Database>("https://governance.example.test", "viewer-fixture", {
      auth: { persistSession: false },
      global: {
        fetch: async (input, init) => {
          const url = new URL(String(input));
          const table = url.pathname.split("/").at(-1);
          if (table === "factory_execution_grants") return Response.json([grant]);
          if (table === "read_factory_credential_ownership") credentialReads.push(url.pathname);
          if (
            (table === "factory_machine_tokens" || table === "factory_oauth_client_bindings") &&
            url.searchParams.get("execution_grant_id")?.startsWith("in.")
          ) {
            dependencyReads.push(table);
            expect(url.searchParams.get("execution_grant_id")).toBe(`in.(${grant.id})`);
            expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
            expect(url.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer viewer-fixture");
            if (table === failingTable) {
              return Response.json(
                { message: "Synthetic dependency read failed" },
                { status: 403 },
              );
            }
            if (table === "factory_machine_tokens" && entries.length) {
              return Response.json([
                {
                  id: fixtureId(2110),
                  name: "Release job",
                  execution_grant_id: grant.id,
                  execution_grant_version: grant.version,
                  expires_at: null,
                },
              ]);
            }
          }
          return Response.json([]);
        },
      },
    });
    const data = await loadGovernance(governanceScope(supabase), {
      source: { kind: "grant", id: grant.id },
    });
    expect(data.bindings).toEqual([]);
    expect(credentialReads).toEqual([]);
    expect(dependencyReads.sort()).toEqual([
      "factory_machine_tokens",
      "factory_oauth_client_bindings",
    ]);
    expect(data.evidence.dependencies[grant.id]).toEqual({
      entries,
      readFailed: Boolean(failingTable),
    });
  },
);

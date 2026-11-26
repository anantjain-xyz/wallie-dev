import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { loadContextPage, parseContextQuery } from "./content-data";

const id = (n: number) => `57800000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [
  workspaceId,
  factoryId,
  sourceId,
  otherSourceId,
  repoId,
  installationId,
  grantId,
  revisionId,
] = [1, 2, 3, 4, 5, 6, 7, 8].map(id);
const source = {
  id: sourceId,
  repository_id: repoId,
  github_installation_id: installationId,
  upstream_repository_id: 21,
  grant_id: grantId,
  grant_version: 3,
  file_path: "docs/architecture.md",
  current_revision_id: revisionId,
  status: "synced",
};

function setup({ detail = false, missingGrantVersion = false } = {}) {
  const reads: URL[] = [];
  const supabase = createClient<Database>("http://fixture.test", "viewer", {
    global: {
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        reads.push(url);
        switch (url.pathname.split("/").at(-1)) {
          case "factory_definition_activations":
            return Response.json([]);
          case "factory_context_sources":
            return Response.json(
              detail
                ? [source]
                : [
                    source,
                    {
                      ...source,
                      id: otherSourceId,
                      github_installation_id: id(9),
                    },
                  ],
            );
          case "factory_context_source_revisions":
            return Response.json([]);
          case "list_factory_context_repository_options":
            return Response.json([
              {
                grant_id: grantId,
                grant_version: 3,
                repository_id: repoId,
                repository_full_name: "atlas/design",
              },
            ]);
          case "list_factory_context_source_access":
            return Response.json([{ source_id: sourceId, status: "available" }]);
          case "github_repositories":
            return Response.json([
              {
                id: repoId,
                full_name: "atlas/design",
                repo_id: 21,
                github_installation_id: installationId,
              },
            ]);
          case "factory_execution_grants":
            return Response.json([
              {
                id: grantId,
                version: missingGrantVersion ? 4 : 3,
                expires_at: "2032-01-02T12:00:00.000Z",
                service_principals: { name: "Docs reader" },
              },
            ]);
          default:
            throw new Error(`Unexpected read: ${url.pathname}`);
        }
      },
    },
  });
  return {
    reads,
    scope: {
      supabase,
      workspaceId,
      workspaceSlug: "atlas",
      actorUserId: id(10),
      factory: { id: factoryId, name: "Design", isDefault: true, status: "active" as const },
      isOperator: false,
    },
  };
}

describe("Context read scope", () => {
  it.each([true, false])(
    "uses scoped repository and exact-version grant metadata (grant changed: %s)",
    async (missingGrantVersion) => {
      const { scope, reads } = setup({ missingGrantVersion });
      const data = await loadContextPage(scope, {});
      expect(data.repositoryNames).toEqual({ [sourceId]: "atlas/design" });
      expect(data.options[0].grant).toEqual(
        missingGrantVersion
          ? null
          : {
              principalName: "Docs reader",
              published: false,
              expiresAt: "2032-01-02T12:00:00.000Z",
            },
      );
      expect(data.publishedDocuments).toEqual([]);
      for (const table of ["github_repositories", "factory_execution_grants"]) {
        const read = reads.find(({ pathname }) => pathname.endsWith(`/${table}`));
        expect(read?.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
        expect(read?.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
        expect(read?.searchParams.get("id")).toBe(
          `in.(${table === "github_repositories" ? repoId : grantId})`,
        );
      }
    },
  );

  it("does not fall back to the current revision when the exact requested one is missing", async () => {
    const { scope, reads } = setup({ detail: true });
    const requested = id(11);
    const data = await loadContextPage(scope, { source: sourceId, revision: requested });
    expect(data.revision).toBeNull();
    const revisions = reads.filter(({ pathname }) =>
      pathname.endsWith("/factory_context_source_revisions"),
    );
    expect(revisions).toHaveLength(2);
    for (const request of revisions) {
      expect(request.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
      expect(request.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
      expect(request.searchParams.get("source_id")).toBe(`eq.${sourceId}`);
      expect(request.searchParams.get("id")).not.toBe(`eq.${revisionId}`);
      expect(request.searchParams.get("select")?.split(",")).not.toContain("content");
    }
    expect(revisions.some(({ searchParams }) => searchParams.get("id") === `eq.${requested}`)).toBe(
      true,
    );
    expect(parseContextQuery({ revision: requested }).success).toBe(false);
  });
});

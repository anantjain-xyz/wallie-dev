import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import { reconcileLinearIssueDiscovery } from "./linear-discovery";

function id(index: number) {
  return `67200000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

const task = {
  workspaceId: id(1),
  factoryId: id(2),
  resourceId: id(3),
  externalTenantId: id(4),
  externalResourceId: id(5),
  resourceKind: "project",
  stateIds: [id(6)],
  labelId: id(7),
  serviceActorId: null,
  configRevision: 2,
  installationGeneration: 4,
  mappingRevision: 3,
  cursorGeneration: 5,
  cursorPosition: "page-one",
};

const issue = {
  id: id(8),
  identifier: "DISC-8",
  title: "Test issue",
  description: "Work description",
  url: "https://linear.app/fixture/issue/DISC-8/test-issue",
  team: { id: id(9) },
  project: { id: task.externalResourceId },
  state: { id: task.stateIds[0] },
  creator: { id: id(10) },
  labelIds: [task.labelId],
};

const page = {
  organization: { id: task.externalTenantId },
  viewer: { id: id(11) },
  issues: {
    nodes: [issue],
    pageInfo: { hasNextPage: true, endCursor: "page-two" },
  },
};

const fixtureKey = "synthetic-linear-discovery-key";

function setup(rpcResults: unknown[]) {
  const database = vi.fn<typeof globalThis.fetch>();
  for (const result of rpcResults) database.mockResolvedValueOnce(Response.json(result));
  const provider = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", provider);
  const admin = createClient<Database>("https://database.example.test", "fixture-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: database },
  });
  return { admin, database, provider };
}

function claimedTask() {
  return { ...task, encryptedApiKey: encryptSecretValue(fixtureKey) };
}

describe("Linear issue discovery sweep", () => {
  beforeEach(() => {
    vi.stubEnv("WALLIE_ENCRYPTION_KEY", "synthetic-linear-discovery-encryption");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("requests one scoped page and commits its exact observed issues and cursor together", async () => {
    const { admin, database, provider } = setup([claimedTask(), 1, null]);
    provider.mockResolvedValueOnce(Response.json({ data: page }));

    const result = await reconcileLinearIssueDiscovery(admin);

    expect(result).toEqual({ admitted: 1, rateLimited: false });
    const providerRequest = new Request(...provider.mock.calls[0]!);
    expect(providerRequest.headers.get("authorization")).toBe(fixtureKey);
    expect(await providerRequest.json()).toMatchObject({
      variables: {
        first: 20,
        after: "page-one",
        filter: {
          project: { id: { eq: task.externalResourceId } },
          state: { id: { in: task.stateIds } },
          labels: { id: { eq: task.labelId } },
        },
      },
    });
    const commit = new Request(...database.mock.calls[1]!);
    expect(new URL(commit.url).pathname).toBe("/rest/v1/rpc/commit_linear_issue_discovery_page");
    expect(await commit.json()).toEqual({
      p_workspace_id: task.workspaceId,
      p_factory_id: task.factoryId,
      p_resource_id: task.resourceId,
      p_config_revision: task.configRevision,
      p_installation_generation: task.installationGeneration,
      p_mapping_revision: task.mappingRevision,
      p_cursor_generation: task.cursorGeneration,
      p_external_tenant_id: task.externalTenantId,
      p_external_viewer_id: page.viewer.id,
      p_next_position: "page-two",
      p_issues: [
        {
          id: issue.id,
          identifier: issue.identifier,
          url: issue.url,
          title: issue.title,
          description: issue.description,
          team_id: issue.team.id,
          project_id: issue.project.id,
          state_id: issue.state.id,
          creator_id: issue.creator.id,
          label_ids: issue.labelIds,
        },
      ],
    });
  });

  it("clears the cursor at the end of a sweep so later changes can be seen", async () => {
    const { admin, database, provider } = setup([claimedTask(), 0, null]);
    provider.mockResolvedValueOnce(
      Response.json({
        data: {
          ...page,
          issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: "unused" } },
        },
      }),
    );

    expect(await reconcileLinearIssueDiscovery(admin)).toEqual({ admitted: 0, rateLimited: false });
    const commit = new Request(...database.mock.calls[1]!);
    expect(await commit.json()).not.toHaveProperty("p_next_position");
  });

  it("does not commit when Linear returns a different tenant", async () => {
    const { admin, database, provider } = setup([claimedTask(), null]);
    provider.mockResolvedValueOnce(
      Response.json({ data: { ...page, organization: { id: id(12) } } }),
    );

    expect(await reconcileLinearIssueDiscovery(admin)).toEqual({ admitted: 0, rateLimited: false });
    const rpcPaths = database.mock.calls.map((call) => new URL(new Request(...call).url).pathname);
    expect(rpcPaths).toEqual(Array(2).fill("/rest/v1/rpc/claim_linear_issue_discovery"));
  });

  it("does not commit when the next cursor repeats the current cursor", async () => {
    const { admin, database, provider } = setup([claimedTask(), null]);
    provider.mockResolvedValueOnce(
      Response.json({
        data: {
          ...page,
          issues: {
            ...page.issues,
            pageInfo: { hasNextPage: true, endCursor: task.cursorPosition },
          },
        },
      }),
    );

    expect(await reconcileLinearIssueDiscovery(admin)).toEqual({ admitted: 0, rateLimited: false });
    expect(database.mock.calls.map((call) => new URL(new Request(...call).url).pathname)).toEqual(
      Array(2).fill("/rest/v1/rpc/claim_linear_issue_discovery"),
    );
  });

  it.each([
    ["HTTP", () => new Response(null, { status: 429 })],
    [
      "GraphQL",
      () => Response.json({ data: null, errors: [{ extensions: { code: "RATELIMITED" } }] }),
    ],
  ])(
    "defers a workspace after %s rate limiting while another workspace advances",
    async (_, throttled) => {
      const next = { ...claimedTask(), workspaceId: id(13), resourceId: id(14) };
      const { admin, database, provider } = setup([claimedTask(), next, 1, null]);
      provider
        .mockResolvedValueOnce(throttled())
        .mockResolvedValueOnce(Response.json({ data: page }));

      expect(await reconcileLinearIssueDiscovery(admin)).toEqual({
        admitted: 1,
        rateLimited: true,
      });
      const secondClaim = new Request(...database.mock.calls[1]!);
      expect(await secondClaim.json()).toEqual({ p_skip_workspace_ids: [task.workspaceId] });
      const nextCommit = new Request(...database.mock.calls[2]!);
      expect(await nextCommit.json()).toMatchObject({ p_workspace_id: next.workspaceId });
    },
  );
});

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

const failureFence = {
  credentialRef: id(18),
  credentialMaterialRevision: 7,
  claimExpiresAt: "2026-11-24T03:41:00.000Z",
};

const issue = {
  id: id(8),
  identifier: "DISC-8",
  previousIdentifiers: ["OLD-51"],
  updatedAt: "2026-11-24T03:40:00.000Z",
  title: "Test issue",
  description: "Work description",
  url: "https://linear.app/fixture/issue/DISC-8/test-issue",
  team: { id: id(9) },
  project: { id: task.externalResourceId },
  state: { id: task.stateIds[0] },
  stateHistory: {
    nodes: [
      {
        id: id(16),
        stateId: task.stateIds[0],
        startedAt: "2026-11-24T03:30:00.000Z",
        endedAt: null,
      },
    ],
  },
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
  for (const result of rpcResults) {
    if (result instanceof Error) database.mockRejectedValueOnce(result);
    else database.mockResolvedValueOnce(Response.json(result));
  }
  const provider = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", provider);
  const admin = createClient<Database>("https://database.example.test", "fixture-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: database },
  });
  return { admin, database, provider };
}

function legacyClaimedTask() {
  return { ...task, encryptedApiKey: encryptSecretValue(fixtureKey) };
}

function claimedTask() {
  return { ...legacyClaimedTask(), ...failureFence };
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
    expect(providerRequest.redirect).toBe("manual");
    expect(await providerRequest.json()).toMatchObject({
      query: expect.stringContaining("stateHistory(last: 1)"),
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
          previous_identifiers: issue.previousIdentifiers,
          url: issue.url,
          title: issue.title,
          description: issue.description,
          team_id: issue.team.id,
          project_id: issue.project.id,
          state_id: issue.state.id,
          creator_id: issue.creator.id,
          label_ids: issue.labelIds,
          origin_span_id: issue.stateHistory.nodes[0]!.id,
          origin_span_started_at: issue.stateHistory.nodes[0]!.startedAt,
          origin_issue_updated_at: issue.updatedAt,
        },
      ],
    });
  });

  it("admits an issue without claiming an originating span when its history no longer matches", async () => {
    const { admin, database, provider } = setup([claimedTask(), 1, null]);
    const otherState = { ...issue.stateHistory.nodes[0], stateId: id(17) };
    provider.mockResolvedValueOnce(
      Response.json({
        data: {
          ...page,
          issues: { ...page.issues, nodes: [{ ...issue, stateHistory: { nodes: [otherState] } }] },
        },
      }),
    );
    expect(await reconcileLinearIssueDiscovery(admin)).toEqual({ admitted: 1, rateLimited: false });
    const commit = await new Request(...database.mock.calls[1]!).json();
    expect(commit.p_issues[0]).not.toHaveProperty("origin_span_id");
    expect(commit.p_issues[0]).not.toHaveProperty("origin_span_started_at");
    expect(commit.p_issues[0]).not.toHaveProperty("origin_issue_updated_at");
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

  it("commits a scoped page from an older discovery claim", async () => {
    const { admin, database, provider } = setup([legacyClaimedTask(), 1, null]);
    provider.mockResolvedValueOnce(Response.json({ data: page }));

    expect(await reconcileLinearIssueDiscovery(admin)).toEqual({ admitted: 1, rateLimited: false });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(database).toHaveBeenCalledTimes(3);
    const commit = new Request(...database.mock.calls[1]!);
    expect(new URL(commit.url).pathname).toBe("/rest/v1/rpc/commit_linear_issue_discovery_page");
    expect(await commit.json()).toMatchObject({
      p_workspace_id: task.workspaceId,
      p_factory_id: task.factoryId,
      p_resource_id: task.resourceId,
      p_config_revision: task.configRevision,
      p_installation_generation: task.installationGeneration,
      p_mapping_revision: task.mappingRevision,
      p_cursor_generation: task.cursorGeneration,
      p_next_position: "page-two",
    });
  });

  it("continues after a failed older claim without calling the failure recorder", async () => {
    const nextClaim = { ...legacyClaimedTask(), resourceId: id(19) };
    const { admin, database, provider } = setup([legacyClaimedTask(), nextClaim, 1, null]);
    provider
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: page }));

    expect(await reconcileLinearIssueDiscovery(admin)).toEqual({ admitted: 1, rateLimited: false });
    expect(provider).toHaveBeenCalledTimes(2);
    const requests = database.mock.calls.map((call) => new Request(...call));
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/rest/v1/rpc/claim_linear_issue_discovery",
      "/rest/v1/rpc/claim_linear_issue_discovery",
      "/rest/v1/rpc/commit_linear_issue_discovery_page",
      "/rest/v1/rpc/claim_linear_issue_discovery",
    ]);
    expect(await requests[2]!.json()).toMatchObject({ p_resource_id: nextClaim.resourceId });
  });

  it("records a bounded reason on the exact claim when Linear returns a different tenant", async () => {
    const { admin, database, provider } = setup([claimedTask(), true, null]);
    provider.mockResolvedValueOnce(
      Response.json({ data: { ...page, organization: { id: id(12) } } }),
    );

    expect(await reconcileLinearIssueDiscovery(admin)).toEqual({ admitted: 0, rateLimited: false });
    const failure = new Request(...database.mock.calls[1]!);
    expect(new URL(failure.url).pathname).toBe(
      "/rest/v1/rpc/record_linear_issue_discovery_failure",
    );
    expect(await failure.json()).toEqual({
      p_workspace_id: task.workspaceId,
      p_factory_id: task.factoryId,
      p_resource_id: task.resourceId,
      p_config_revision: task.configRevision,
      p_installation_generation: task.installationGeneration,
      p_mapping_revision: task.mappingRevision,
      p_cursor_generation: task.cursorGeneration,
      p_credential_ref: failureFence.credentialRef,
      p_credential_material_revision: failureFence.credentialMaterialRevision,
      p_claim_expires_at: failureFence.claimExpiresAt,
      p_reason: "scope_mismatch",
    });
  });

  it("records an invalid continuation without committing a provider page", async () => {
    const { admin, database, provider } = setup([claimedTask(), true, null]);
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
    const failure = new Request(...database.mock.calls[1]!);
    expect(new URL(failure.url).pathname).toBe(
      "/rest/v1/rpc/record_linear_issue_discovery_failure",
    );
    expect(await failure.json()).toMatchObject({ p_reason: "invalid_provider_response" });
  });

  it("never reads a redirected response body and emits a bounded failure reason", async () => {
    const { admin, database, provider } = setup([claimedTask(), true, null]);
    const redirect = Response.redirect("https://different-host.example.test", 307);
    const readBody = vi.spyOn(redirect, "json");
    provider.mockResolvedValueOnce(redirect);

    expect(await reconcileLinearIssueDiscovery(admin)).toEqual({ admitted: 0, rateLimited: false });
    expect(readBody).not.toHaveBeenCalled();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await new Request(...database.mock.calls[1]!).json()).toMatchObject({
      p_reason: "invalid_provider_response",
    });
  });

  it("records provider access denial without reading the provider error or exposing the key", async () => {
    const { admin, database, provider } = setup([claimedTask(), true, null]);
    const denied = new Response("Sensitive provider text", { status: 403 });
    const readBody = vi.spyOn(denied, "json");
    provider.mockResolvedValueOnce(denied);

    expect(await reconcileLinearIssueDiscovery(admin)).toEqual({ admitted: 0, rateLimited: false });
    expect(readBody).not.toHaveBeenCalled();
    const failure = await new Request(...database.mock.calls[1]!).json();
    expect(failure).toMatchObject({ p_reason: "provider_access_denied" });
    expect(JSON.stringify(failure)).not.toContain(fixtureKey);
    expect(JSON.stringify(failure)).not.toContain("Sensitive provider text");
  });

  it("classifies an invalid discovery commit count as a commit failure", async () => {
    const { admin, database, provider } = setup([claimedTask(), null, true, null]);
    provider.mockResolvedValueOnce(Response.json({ data: page }));

    expect(await reconcileLinearIssueDiscovery(admin)).toEqual({ admitted: 0, rateLimited: false });
    const failure = new Request(...database.mock.calls[2]!);
    expect(new URL(failure.url).pathname).toBe(
      "/rest/v1/rpc/record_linear_issue_discovery_failure",
    );
    expect(await failure.json()).toMatchObject({ p_reason: "discovery_commit_failed" });
  });

  it("continues to another scoped scan if diagnostic recording fails", async () => {
    const next = { ...claimedTask(), resourceId: id(19) };
    const { admin, database, provider } = setup([
      claimedTask(),
      new Error("Recorder unavailable"),
      next,
      1,
      null,
    ]);
    provider
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: page }));

    expect(await reconcileLinearIssueDiscovery(admin)).toEqual({ admitted: 1, rateLimited: false });
    const failure = new Request(...database.mock.calls[1]!);
    expect(new URL(failure.url).pathname).toBe(
      "/rest/v1/rpc/record_linear_issue_discovery_failure",
    );
    expect(await failure.json()).toMatchObject({ p_reason: "provider_unavailable" });
    expect(await new Request(...database.mock.calls[3]!).json()).toMatchObject({
      p_resource_id: next.resourceId,
    });
  });

  it("commits the page when title and description limits fall inside emoji", async () => {
    const { admin, database, provider } = setup([claimedTask(), 2, null]);
    const title = "x".repeat(199);
    const description = "y".repeat(19_499);
    const following = { ...issue, id: id(15), identifier: "DISC-15", previousIdentifiers: [] };
    provider.mockResolvedValueOnce(
      Response.json({
        data: {
          ...page,
          issues: {
            ...page.issues,
            nodes: [{ ...issue, title: title + "😃", description: description + "😃" }, following],
          },
        },
      }),
    );

    expect(await reconcileLinearIssueDiscovery(admin)).toEqual({ admitted: 2, rateLimited: false });
    const commit = new Request(...database.mock.calls[1]!);
    expect(await commit.json()).toMatchObject({
      p_issues: [
        { id: issue.id, title, description },
        { id: following.id, title: following.title, description: following.description },
      ],
    });
  });

  it.each([
    ["HTTP", () => new Response(null, { status: 429, headers: { "Retry-After": "120" } }), 120],
    [
      "GraphQL",
      () => Response.json({ data: null, errors: [{ extensions: { code: "RATELIMITED" } }] }),
      60,
    ],
  ])(
    "persists a credential cooldown after %s rate limiting before claiming another mapping",
    async (_, throttled, retryAfterSeconds) => {
      const next = { ...claimedTask(), workspaceId: id(13), resourceId: id(14) };
      const { admin, database, provider } = setup([claimedTask(), true, next, 1, null]);
      provider
        .mockResolvedValueOnce(throttled())
        .mockResolvedValueOnce(Response.json({ data: page }));

      expect(await reconcileLinearIssueDiscovery(admin)).toEqual({
        admitted: 1,
        rateLimited: true,
      });
      const cooldown = new Request(...database.mock.calls[1]!);
      expect(new URL(cooldown.url).pathname).toBe("/rest/v1/rpc/defer_linear_issue_discovery");
      expect(await cooldown.json()).toEqual({
        p_workspace_id: task.workspaceId,
        p_resource_id: task.resourceId,
        p_installation_generation: task.installationGeneration,
        p_retry_after_seconds: retryAfterSeconds,
      });
      const nextCommit = new Request(...database.mock.calls[3]!);
      expect(await nextCommit.json()).toMatchObject({ p_workspace_id: next.workspaceId });
    },
  );
});

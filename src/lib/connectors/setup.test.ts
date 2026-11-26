import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/workspaces/[workspaceId]/factories/[factoryId]/connectors/catalog/route";
import { POST } from "@/app/api/workspaces/[workspaceId]/factories/[factoryId]/connectors/setup/route";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

const mock = vi.hoisted(() => ({
  context: vi.fn(),
  admin: vi.fn(),
  github: vi.fn(),
  definition: vi.fn(),
}));
vi.mock("@/lib/factories/route-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/factories/route-context")>()),
  resolveFactoryRouteContext: mock.context,
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mock.admin }));
vi.mock("@/features/github/service", () => ({
  createGitHubApp: () => ({ octokit: { request: mock.github } }),
}));
vi.mock("@/lib/factory-definitions/stored-definition", () => ({
  readVerifiedFactoryDefinition: mock.definition,
}));

function id(slot: number) {
  return `68000000-0000-4000-8000-${slot.toString().padStart(12, "0")}`;
}

const workspaceId = id(1);
const factoryId = id(2);
const actorUserId = id(3);
const connectorId = id(4);
const resourceId = id(5);
const nativeId = id(6);
const repositoryId = id(7);
const organization = { id: id(8), name: "Fixture organization" };
const project = { id: id(9), name: "Fixture project" };
const team = { id: id(13), name: "Platform", key: "PLAT" };
const siblingTeam = { id: id(14), name: "Frontend", key: "WEB" };
const workflowStateId = id(15);
const secretId = id(10);
const activationId = id(11);
const grantId = id(12);
const key = "synthetic-linear-catalog-key";
const githubToken = "synthetic-github-repository-reader";
const canonicalGithubRepository = {
  id: 84,
  owner: { id: 83 },
  full_name: "fixture-org/renamed",
  archived: false,
};
const githubLabel = { id: 85, name: "Wallie issue", archived_at: null };
const archivedAt = "2026-11-20T00:00:00Z";
const scope = {
  p_workspace_id: workspaceId,
  p_factory_id: factoryId,
  p_actor_user_id: actorUserId,
};
const routeContext = { params: Promise.resolve({ workspaceId, factoryId }) };
const baseUrl = "https://wallie.test/connectors";

async function catalog(query: string) {
  return GET(new Request(`${baseUrl}/catalog?${query}`), routeContext);
}

async function setup(command: Record<string, unknown>) {
  return POST(
    new Request(`${baseUrl}/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    }),
    routeContext,
  );
}

function fixture(role = "owner", provider: "github" | "linear" = "linear") {
  mock.context.mockResolvedValue({
    ok: true,
    workspaceId,
    factoryId,
    access: {
      currentMember: { role },
      user: { id: actorUserId },
    },
  });
  mock.github.mockImplementation(async (endpoint) => {
    if (endpoint === "GET /app/installations/{installation_id}") {
      return {
        data: {
          id: 81,
          app_id: 82,
          suspended_at: null,
          account: { id: 83, login: "fixture-org" },
          permissions: { issues: "write", metadata: "read" },
        },
      };
    }
    if (endpoint === "POST /app/installations/{installation_id}/access_tokens") {
      return { data: { token: githubToken } };
    }
    throw new Error("Unexpected GitHub App call");
  });
  mock.definition.mockReturnValue({
    executionGrant: { id: grantId, version: 4 },
    implementationAgent: {},
  });
  const tenantId = provider === "github" ? "83" : organization.id;
  const catalogResult = [{ id: repositoryId, repo_id: 84, full_name: "fixture-org/work" }];
  const rows: Record<string, unknown[]> = {
    github_installations: [
      { id: nativeId, installation_id: 81, app_id: 82, target_name: "Cached name" },
    ],
    github_repositories: catalogResult,
    workspace_secrets: [
      { id: secretId, material_revision: 5, encrypted_value: encryptSecretValue(key) },
    ],
    factory_connector_resources: [
      {
        id: resourceId,
        installation_id: connectorId,
        provider,
        external_tenant_id: tenantId,
        resource_kind: provider === "github" ? "repository" : "project",
        external_resource_id: provider === "github" ? "84" : project.id,
        current_revision: 2,
      },
    ],
    factory_connector_mapping_revisions: [{ enabled: true }],
    factory_definition_activations: [{ revision_id: activationId }],
    factory_definition_revisions: [
      { definition_json: "published bytes", canonical_digest: "published digest" },
    ],
  };
  const rpcData: Record<string, unknown> = {
    read_connector_installation_state: [
      {
        installation_id: connectorId,
        generation: 7,
        provider,
        external_tenant_id: tenantId,
        external_installation_id: provider === "github" ? "81" : organization.id,
        status: "connected",
      },
    ],
    configure_connector_installation: [{ installation_id: connectorId, generation: 8 }],
    publish_connector_resource_mapping: [{ resource_id: resourceId, revision: 3 }],
    configure_github_connector_request: 2,
    disable_github_connector_request: 3,
    disconnect_connector_installation: 8,
  };
  const requests: Array<{ name: string; query: URLSearchParams; body: unknown }> = [];
  const databaseFetch = vi.fn<typeof fetch>().mockImplementation(async (...args) => {
    const request = new Request(...args);
    const url = new URL(request.url);
    const name = url.pathname.replace("/rest/v1/", "");
    requests.push({
      name,
      query: url.searchParams,
      body: request.method === "POST" ? await request.json() : null,
    });
    if (name.startsWith("rpc/")) return Response.json(rpcData[name.slice(4)]);
    if (rows[name]) return Response.json(rows[name]);
    throw new Error("Unexpected database call");
  });
  const upstream = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", upstream);
  mock.admin.mockReturnValue(
    createClient<Database>("https://database.example.test", "synthetic-service", {
      global: { fetch: databaseFetch },
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  );
  return {
    upstream,
    rows,
    rpcData,
    read: (name: string) => requests.find((request) => request.name === name)?.query,
    called: (name: string) =>
      requests.filter((request) => request.name === `rpc/${name}`).map(({ body }) => body),
  };
}

function githubRepositoryResponse(overrides: Partial<typeof canonicalGithubRepository> = {}) {
  return Response.json({
    total_count: 1,
    repositories: [{ ...canonicalGithubRepository, ...overrides }],
  });
}

function linearPage<T>(nodes: T[]) {
  return { nodes, pageInfo: { endCursor: null, hasNextPage: false } };
}

function linearProjectTeams(teams = [team], tenant = organization) {
  return Response.json({
    data: {
      organization: tenant,
      project: { ...project, archivedAt: null, teams: linearPage(teams) },
    },
  });
}

describe("factory connector setup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("WALLIE_ENCRYPTION_KEY", "synthetic-catalog-encryption-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps native provider catalogs and setup writes behind workspace admin authority", async () => {
    const { upstream } = fixture("member");
    const results = await Promise.all([
      catalog("provider=github"),
      catalog(`provider=linear&kind=state&resourceId=${resourceId}`),
      setup({ action: "disconnect", installationId: connectorId, expectedGeneration: 7 }),
    ]);
    expect(results.map((response) => response.status)).toEqual([403, 403, 403]);
    expect(results[0]?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mock.admin).not.toHaveBeenCalled();
    expect(mock.github).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("lists named states only for the selected eligible project team", async () => {
    const { upstream, read } = fixture("admin");
    upstream.mockResolvedValueOnce(linearProjectTeams([team, siblingTeam])).mockResolvedValueOnce(
      Response.json({
        data: {
          organization,
          workflowStates: linearPage([
            { id: workflowStateId, name: "In progress", team, type: "started" },
          ]),
        },
      }),
    );
    const response = await catalog(
      `provider=linear&kind=state&resourceId=${resourceId}&teamId=${team.id}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "linear",
      kind: "state",
      tenant: { id: organization.id, label: organization.name },
      resources: [
        {
          id: workflowStateId,
          label: "In progress",
          description: "Platform (PLAT) · started",
          teamId: team.id,
        },
      ],
      nextCursor: null,
    });
    expect(read("factory_connector_resources")?.get("factory_id")).toBe(`eq.${factoryId}`);
    expect(read("factory_connector_mapping_revisions")?.get("revision")).toBe("eq.2");
    expect(await new Request(...upstream.mock.calls[1]!).json()).toMatchObject({
      variables: { filter: { team: { id: { in: [team.id] } } } },
    });
  });

  it("returns eligible project teams with their keys and refuses a team outside the project", async () => {
    const { upstream } = fixture();
    upstream
      .mockResolvedValueOnce(linearProjectTeams())
      .mockResolvedValueOnce(linearProjectTeams());
    const teams = await catalog(`provider=linear&kind=team&resourceId=${resourceId}`);
    expect(teams.status).toBe(200);
    expect(await teams.json()).toMatchObject({
      resources: [{ id: team.id, label: "Platform", description: "PLAT" }],
      nextCursor: null,
    });
    const response = await catalog(
      `provider=linear&kind=state&resourceId=${resourceId}&teamId=${siblingTeam.id}`,
    );
    expect(response.status).toBe(422);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("shows workspace and mapped team labels but excludes label groups", async () => {
    const { upstream } = fixture();
    upstream.mockResolvedValueOnce(linearProjectTeams()).mockResolvedValueOnce(
      Response.json({
        data: {
          organization,
          issueLabels: linearPage([
            { id: id(16), name: "Intake", team: null, isGroup: false },
            { id: id(17), name: "Bug", team, isGroup: false },
            { id: id(18), name: "Group", team, isGroup: true },
          ]),
        },
      }),
    );
    const response = await catalog(`provider=linear&kind=label&resourceId=${resourceId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resources: [
        { id: id(16), label: "Intake", description: "Linear workspace label" },
        { id: id(17), label: "Bug", description: "Platform (PLAT)", teamId: team.id },
      ],
    });
    expect(await new Request(...upstream.mock.calls[1]!).json()).toMatchObject({
      variables: {
        filter: { or: [{ team: { null: true } }, { team: { id: { in: [team.id] } } }] },
      },
    });
  });

  it("does not return choices if the authorized organization changed", async () => {
    const { upstream } = fixture();
    upstream.mockResolvedValueOnce(linearProjectTeams([team], { ...organization, id: id(19) }));
    const response = await catalog(`provider=linear&kind=label&resourceId=${resourceId}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Could not verify Linear access." });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("returns only the verified Linear organization and scoped page options", async () => {
    const { upstream, read } = fixture();
    upstream.mockResolvedValueOnce(
      Response.json({
        data: {
          organization,
          projects: {
            nodes: [project],
            pageInfo: { hasNextPage: true, endCursor: "next-projects" },
          },
        },
      }),
    );
    const response = await catalog("provider=linear&kind=project&cursor=first-projects");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "linear",
      kind: "project",
      tenant: { id: organization.id, label: organization.name },
      resources: [{ id: project.id, label: project.name }],
      nextCursor: "next-projects",
    });
    expect(read("workspace_secrets")?.get("workspace_id")).toBe(`eq.${workspaceId}`);
    expect(read("workspace_secrets")?.get("key")).toBe("eq.LINEAR_API_KEY");
    const request = new Request(...upstream.mock.calls[0]!);
    expect(request.headers.get("Authorization")).toBe(key);
    expect(request.redirect).toBe("error");
    expect(await request.json()).toMatchObject({
      query: expect.stringContaining("projects(first:"),
      variables: { first: 25, after: "first-projects" },
    });
  });

  it("lists only native GitHub repositories in the selected workspace and factory", async () => {
    const { upstream, read } = fixture("admin", "github");
    const response = await catalog("provider=github");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "github",
      kind: "repository",
      tenant: { id: "83", label: "fixture-org" },
      resources: [{ id: repositoryId, label: "fixture-org/work", externalId: "84" }],
      nextCursor: null,
    });
    expect(Object.fromEntries(read("github_repositories")!)).toMatchObject({
      workspace_id: `eq.${workspaceId}`,
      factory_id: `eq.${factoryId}`,
      github_installation_id: `eq.${nativeId}`,
      is_archived: "eq.false",
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("connects only the displayed Linear tenant using the verified secret revision", async () => {
    const { upstream, called } = fixture();
    upstream
      .mockResolvedValueOnce(
        Response.json({ data: { organization: { ...organization, id: id(20) } } }),
      )
      .mockResolvedValueOnce(Response.json({ data: { organization } }));
    const command = {
      action: "connect",
      provider: "linear",
      expectedTenantId: organization.id,
      expectedGeneration: 7,
    };
    expect((await setup(command)).status).toBe(409);
    expect(called("configure_connector_installation")).toEqual([]);

    const response = await setup(command);
    expect(await response.json()).toEqual({ installationId: connectorId, generation: 8 });
    expect(called("configure_connector_installation")).toEqual([
      {
        ...scope,
        p_provider: "linear",
        p_external_tenant_id: organization.id,
        p_external_installation_id: organization.id,
        p_expected_generation: 7,
        p_linear_secret_id: secretId,
        p_linear_material_revision: 5,
      },
    ]);
  });

  it("checks the selected Linear organization and exact project again on map", async () => {
    const { upstream, called } = fixture();
    upstream
      .mockResolvedValueOnce(
        Response.json({ data: { organization, project: { ...project, id: id(20) } } }),
      )
      .mockResolvedValueOnce(Response.json({ data: { organization, project } }));
    const command = {
      action: "map",
      installationId: connectorId,
      expectedGeneration: 7,
      expectedMappingRevision: 2,
      resource: { kind: "project", id: project.id },
    };
    expect((await setup(command)).status).toBe(409);
    expect(called("publish_connector_resource_mapping")).toEqual([]);
    const response = await setup(command);
    expect(await response.json()).toEqual({ resourceId, mappingRevision: 3 });
    expect(called("publish_connector_resource_mapping")).toEqual([
      {
        ...scope,
        p_installation_id: connectorId,
        p_expected_installation_generation: 7,
        p_expected_revision: 2,
        p_resource_kind: "project",
        p_external_resource_id: project.id,
        p_enabled: true,
      },
    ]);
  });

  it("verifies GitHub’s exact selected repository and owner before publishing the numeric ID", async () => {
    const { upstream, called } = fixture("owner", "github");
    upstream
      .mockResolvedValueOnce(githubRepositoryResponse({ owner: { id: 99 } }))
      .mockResolvedValueOnce(githubRepositoryResponse({ id: 99 }))
      .mockResolvedValueOnce(githubRepositoryResponse());
    const command = {
      action: "map",
      installationId: connectorId,
      expectedGeneration: 7,
      expectedMappingRevision: 0,
      resource: { kind: "repository", id: repositoryId },
    };
    const wrongTenant = await setup(command);
    expect(wrongTenant.status).toBe(502);
    expect(JSON.stringify(await wrongTenant.json())).not.toContain(githubToken);
    expect((await setup(command)).status).toBe(502);
    expect(called("publish_connector_resource_mapping")).toEqual([]);
    const response = await setup(command);
    expect(response.status).toBe(200);
    expect(called("publish_connector_resource_mapping")).toEqual([
      expect.objectContaining({
        p_external_resource_id: "84",
        p_expected_revision: 0,
        p_resource_kind: "repository",
      }),
    ]);
    expect(mock.github).toHaveBeenCalledWith(
      "POST /app/installations/{installation_id}/access_tokens",
      expect.objectContaining({
        installation_id: 81,
        repository_ids: [84],
        permissions: { metadata: "read" },
        request: { redirect: "error", signal: expect.any(AbortSignal) },
      }),
    );
  });

  it("lists active labels at the repository’s current name and verifies the label again when saving", async () => {
    const { upstream, read, called } = fixture("owner", "github");
    upstream
      .mockResolvedValueOnce(githubRepositoryResponse())
      .mockResolvedValueOnce(
        Response.json([githubLabel, { id: 86, name: "Archived issue", archived_at: archivedAt }]),
      )
      .mockResolvedValueOnce(githubRepositoryResponse())
      .mockResolvedValueOnce(Response.json(githubLabel));
    const options = await catalog(`provider=github&kind=label&resourceId=${resourceId}`);
    expect(options.status).toBe(200);
    expect((await options.json()).resources).toEqual([{ id: "85", label: "Wallie issue" }]);
    const response = await setup({
      action: "github_request",
      resourceId,
      sourceKind: "issue",
      expectedRevision: 1,
      labelId: 85,
      labelName: "Wallie issue",
    });
    expect(await response.json()).toEqual({ revision: 2 });
    expect(read("factory_definition_activations")?.get("factory_id")).toBe(`eq.${factoryId}`);
    expect(read("factory_definition_revisions")?.get("factory_id")).toBe(`eq.${factoryId}`);
    expect(called("configure_github_connector_request")).toEqual([
      {
        ...scope,
        p_resource_id: resourceId,
        p_source_kind: "issue",
        p_expected_revision: 1,
        p_enabled: true,
        p_label_id: 85,
        p_execution_grant_id: grantId,
        p_execution_grant_version: 4,
      },
    ]);
    const requests = upstream.mock.calls.map((args) => new Request(...args));
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/installation/repositories",
      "/repos/fixture-org/renamed/labels",
      "/installation/repositories",
      "/repos/fixture-org/renamed/labels/Wallie%20issue",
    ]);
    for (const request of requests) {
      expect(request.headers.get("Authorization")).toBe(`Bearer ${githubToken}`);
      expect(request.headers.get("X-GitHub-Api-Version")).toBe("2026-03-10");
      expect(request.redirect).toBe("error");
    }
  });

  it("continues paginating after an archived-only page and rejects a label archived after selection", async () => {
    const { upstream, called } = fixture("owner", "github");
    const archived = { ...githubLabel, archived_at: archivedAt };
    upstream
      .mockResolvedValueOnce(githubRepositoryResponse())
      .mockResolvedValueOnce(
        Response.json([archived], {
          headers: {
            Link: '<https://api.github.com/repos/fixture-org/renamed/labels?page=2>; rel="next"',
          },
        }),
      )
      .mockResolvedValueOnce(githubRepositoryResponse())
      .mockResolvedValueOnce(Response.json(archived));
    const page = await catalog(`provider=github&kind=label&resourceId=${resourceId}`);
    expect(await page.json()).toMatchObject({ resources: [], nextCursor: "2" });
    const response = await setup({
      action: "github_request",
      resourceId,
      sourceKind: "issue",
      expectedRevision: 1,
      labelId: 85,
      labelName: "Wallie issue",
    });
    expect(response.status).toBe(409);
    expect(called("configure_github_connector_request")).toEqual([]);
  });

  it("disables only the selected GitHub rule revision without provider access or a published grant", async () => {
    const { upstream, called, read } = fixture("owner", "github");
    mock.definition.mockReturnValue(null);
    const response = await setup({
      action: "disable_github_request",
      resourceId,
      sourceKind: "pull_request",
      expectedRevision: 2,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 3 });
    expect(called("disable_github_connector_request")).toEqual([
      {
        ...scope,
        p_resource_id: resourceId,
        p_source_kind: "pull_request",
        p_expected_revision: 2,
      },
    ]);
    expect(called("publish_connector_resource_mapping")).toEqual([]);
    expect(called("disconnect_connector_installation")).toEqual([]);
    expect(read("factory_definition_activations")).toBeUndefined();
    expect(mock.github).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("uses the retained scoped mapping when disabling or disconnecting without provider access", async () => {
    const { upstream, called } = fixture();
    const disabled = await setup({
      action: "disable",
      resourceId,
      expectedGeneration: 7,
      expectedMappingRevision: 2,
    });
    const disconnected = await setup({
      action: "disconnect",
      installationId: connectorId,
      expectedGeneration: 7,
    });
    expect(await disabled.json()).toEqual({ resourceId, mappingRevision: 3 });
    expect(await disconnected.json()).toEqual({ disconnected: true });
    expect(called("publish_connector_resource_mapping")).toEqual([
      expect.objectContaining({
        p_installation_id: connectorId,
        p_external_resource_id: project.id,
        p_expected_revision: 2,
        p_enabled: false,
      }),
    ]);
    expect(mock.github).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
});

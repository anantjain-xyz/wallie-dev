import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { factoryActivationRequirements, loadFactoryDefinitionCatalog } from "./authority";
import type { CompiledFactoryDefinition } from "./compiler";

const workspaceId = "81b90000-0000-4000-8000-000000000001";
const factoryId = "81b90000-0000-4000-8000-000000000003";
const skillRevisionId = "81b90000-0000-4000-8000-000000000006";
const installationId = "81b90000-0000-4000-8000-000000000002";
const promptRevisionId = "81b90000-0000-4000-8000-000000000004";

function fixtureClient({ installationActive = true } = {}) {
  const requests: URL[] = [];
  const fetchCatalog: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url);
    const page = url.searchParams.get("offset") ?? "0";
    const table = url.pathname.split("/").at(-1);
    const records: Record<string, unknown[]> = {
      pipelines: [{ id: "pipeline", name: "Release" }],
      github_installations: installationActive ? [{ id: installationId }] : [],
      github_repositories: [
        { id: "repo", full_name: "team/product", github_installation_id: installationId },
        { id: "disconnected", full_name: "team/disconnected", github_installation_id: "old" },
      ],
      execution_policy_revisions:
        page === "0"
          ? Array.from({ length: 500 }, (_, index) => ({ id: `revision-${index}` }))
          : [{ id: "another-page" }],
      delivery_policy_revisions: [{ id: "delivery", pipeline_id: "pipeline" }],
      workspace_members: [{ id: "reviewer" }],
      factory_agent_prompt_revisions: [
        {
          id: "81b90000-0000-4000-8000-000000000004",
          agent_id: "81b90000-0000-4000-8000-000000000005",
          prompt_md: "",
          prompt_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      ],
      factory_skill_revisions: [{ id: skillRevisionId }],
    };
    const record = table ? records[table] : undefined;
    if (table === "factory_agent_prompt_revisions") {
      expect(url.searchParams.get("id")).toBe(`eq.${promptRevisionId}`);
      expect(url.searchParams.get("limit")).toBe("1");
      expect(url.searchParams.has("offset")).toBe(false);
    }
    return Response.json(record ?? [], { status: record ? 200 : 404 });
  };

  return {
    admin: createClient<Database>("http://factory.test", "test-service-key", {
      auth: { persistSession: false },
      global: { fetch: fetchCatalog },
    }),
    requests,
  };
}

describe("factory activation authority inputs", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("loads the scoped catalog without losing policy revisions beyond the first page", async () => {
    vi.stubEnv("WALLIE_ENABLED_SANDBOX_PROVIDERS", "e2b");
    const { admin, requests } = fixtureClient();
    const catalog = await loadFactoryDefinitionCatalog(admin, { workspaceId, factoryId });

    expect(catalog).toMatchObject({
      pipelines: [{ id: "pipeline", workspaceId, aliases: ["Release"] }],
      repositories: [{ id: "repo", workspaceId, aliases: ["team/product"] }],
      deliveryPolicyRevisions: [{ id: "delivery", workspaceId, pipelineId: "pipeline" }],
      approvers: [{ id: "reviewer", workspaceId }],
      sandboxProviders: ["e2b"],
      skills: [],
      tools: [],
    });
    expect(catalog.executionPolicyRevisions).toHaveLength(501);
    expect(catalog.executionPolicyRevisions.at(-1)).toEqual({ id: "another-page", workspaceId });
    expect(
      requests.every((url) => url.searchParams.get("workspace_id") === `eq.${workspaceId}`),
    ).toBe(true);
    const installation = requests.find((url) => url.pathname.endsWith("/github_installations"));
    const repos = requests.find((url) => url.pathname.endsWith("/github_repositories"));
    const members = requests.find((url) => url.pathname.endsWith("/workspace_members"));
    expect(installation?.searchParams.get("suspended")).toBe("eq.false");
    const pipelines = requests.find((url) => url.pathname.endsWith("/pipelines"));
    expect(repos?.searchParams.get("is_archived")).toBe("eq.false");
    expect(repos?.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
    expect(pipelines?.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
    expect(requests.some((url) => url.pathname.endsWith("/factory_agent_prompt_revisions"))).toBe(
      false,
    );
    expect(catalog.agentPromptRevisions).toEqual([]);
    expect(requests.some((url) => url.pathname.endsWith("/factory_skill_revisions"))).toBe(false);
    expect(members?.searchParams.get("kind")).toBe("eq.human");
    expect(members?.searchParams.get("is_active")).toBe("eq.true");
  });

  it("loads only eligible IDs from the selected skill revisions in the factory", async () => {
    const { admin, requests } = fixtureClient();
    const catalog = await loadFactoryDefinitionCatalog(admin, {
      workspaceId,
      factoryId,
      skillRevisionIds: [skillRevisionId.toUpperCase(), skillRevisionId, "bad revision"],
    });
    const request = requests.find((url) => url.pathname.endsWith("/factory_skill_revisions"));
    expect(request?.searchParams.get("select")).toBe("id");
    expect(request?.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
    expect(request?.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
    expect(request?.searchParams.get("revoked_at")).toBe("is.null");
    expect(request?.searchParams.get("id")).toBe(`in.(${skillRevisionId})`);
    expect(catalog.skills).toEqual([{ id: skillRevisionId, workspaceId }]);
  });

  it("excludes every repository binding when the installation becomes unavailable", async () => {
    const { admin } = fixtureClient({ installationActive: false });
    const catalog = await loadFactoryDefinitionCatalog(admin, { workspaceId, factoryId });
    expect(catalog.repositories).toEqual([]);
  });

  it("loads only the selected immutable prompt without scanning revision history", async () => {
    const { admin, requests } = fixtureClient();
    const catalog = await loadFactoryDefinitionCatalog(admin, {
      workspaceId,
      factoryId,
      agentPromptRevisionId: promptRevisionId,
    });
    const promptRequests = requests.filter((url) =>
      url.pathname.endsWith("/factory_agent_prompt_revisions"),
    );
    expect(promptRequests).toHaveLength(1);
    expect(promptRequests[0]?.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
    expect(promptRequests[0]?.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
    expect(promptRequests[0]?.searchParams.get("id")).toBe(`eq.${promptRevisionId}`);
    expect(catalog.agentPromptRevisions).toEqual([
      {
        id: promptRevisionId,
        workspaceId,
        agentId: "81b90000-0000-4000-8000-000000000005",
        promptRevisionId,
        promptMd: "",
        promptSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    ]);
  });

  it("combines deployment provider eligibility with the agent-specific probe contract", () => {
    vi.stubEnv("WALLIE_ENABLED_SANDBOX_PROVIDERS", "e2b,daytona");
    const bundle: CompiledFactoryDefinition = {
      kind: "serial",
      schemaVersion: 1,
      sandboxProvider: "e2b",
      agent: {
        provider: "codex",
        model: "gpt-5.5",
        effort: null,
        concurrencyLimit: 1,
        maxRetries: 0,
        maxTurns: 2,
        stallTimeoutMs: 30_000,
      },
      pipelineId: "pipeline",
      repositoryId: "repo",
      executionPolicyRevisionId: null,
      deliveryPolicyRevisionId: null,
      skillIds: [],
      toolIds: [],
      operatingRuleStageIds: [],
      operatingRulesMd: "",
      stages: [],
    };
    const codex = factoryActivationRequirements(bundle);
    const cursor = factoryActivationRequirements({
      ...bundle,
      agent: { ...bundle.agent, provider: "cursor", model: "auto" },
    });
    expect(codex.enabledSandboxProviders).toEqual(["e2b", "daytona"]);
    expect(codex.requiredProbes).toEqual(expect.arrayContaining(["git", "codexExternalSandbox"]));
    expect(cursor.requiredProbes).toContain("git");
    expect(cursor.requiredProbes).not.toContain("codexExternalSandbox");
  });
});

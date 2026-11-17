import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { createFactoryAgentSchema, saveFactoryAgentPromptSchema } from "./contracts";
import {
  createFactoryAgent,
  listFactoryAgentPromptRevisions,
  listFactoryAgents,
  saveFactoryAgentPromptRevision,
} from "./service";

const workspaceId = "55200000-0000-4000-8000-000000000001";
const factoryId = "55200000-0000-4000-8000-000000000002";
const actorUserId = "55200000-0000-4000-8000-000000000003";
const agentId = "55200000-0000-4000-8000-000000000004";
const revisionId = "55200000-0000-4000-8000-000000000005";

function fixture(fetch: typeof globalThis.fetch) {
  return createClient<Database>("http://factory-agent.test", "fixture", {
    auth: { persistSession: false },
    global: { fetch },
  });
}

describe("named factory agent requests", () => {
  it("uses exact factory scope and bounds the agent list", async () => {
    const client = fixture(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.pathname).toBe("/rest/v1/factory_agents");
      expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
      expect(url.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
      expect(url.searchParams.get("id")).toBe(`gt.${agentId}`);
      expect(url.searchParams.get("limit")).toBe("2");
      return Response.json([
        { id: revisionId, name: "Release" },
        { id: actorUserId, name: "Review" },
      ]);
    });
    expect(
      await listFactoryAgents(client, { workspaceId, factoryId, afterId: agentId, limit: 1 }),
    ).toEqual({
      agents: [{ id: revisionId, name: "Release" }],
      nextAfterId: revisionId,
    });
  });

  it("keeps revision pagination inside the agent and factory", async () => {
    const client = fixture(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.searchParams.get("agent_id")).toBe(`eq.${agentId}`);
      expect(url.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
      expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
      expect(url.searchParams.get("revision_number")).toBe("lt.4");
      expect(url.searchParams.get("order")).toBe("revision_number.desc");
      return Response.json([
        { id: revisionId, revision_number: 3 },
        { id: actorUserId, revision_number: 2 },
      ]);
    });
    expect(
      await listFactoryAgentPromptRevisions(client, {
        workspaceId,
        factoryId,
        agentId,
        beforeRevisionNumber: 4,
        limit: 1,
      }),
    ).toEqual({ revisions: [{ id: revisionId, revision_number: 3 }], nextBeforeRevisionNumber: 3 });
  });

  it("creates immutable candidates with an explicit actor and optimistic revision", async () => {
    const requests: { path: string; body: unknown }[] = [];
    const client = fixture(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
      return Response.json({ id: revisionId, agent_id: agentId, revision_number: requests.length });
    });
    const scope = { workspaceId, factoryId, actorUserId };
    await createFactoryAgent(client, {
      ...scope,
      name: "Release",
      slug: "release",
      promptMd: "Static {{session.prompt}}",
    });
    await saveFactoryAgentPromptRevision(client, {
      ...scope,
      agentId,
      expectedRevisionNumber: 1,
      promptMd: "Revised",
    });
    expect(requests).toEqual([
      {
        path: "/rest/v1/rpc/create_factory_agent",
        body: {
          p_workspace_id: workspaceId,
          p_factory_id: factoryId,
          p_actor_user_id: actorUserId,
          p_name: "Release",
          p_slug: "release",
          p_prompt_md: "Static {{session.prompt}}",
        },
      },
      {
        path: "/rest/v1/rpc/save_factory_agent_prompt_revision",
        body: {
          p_workspace_id: workspaceId,
          p_factory_id: factoryId,
          p_actor_user_id: actorUserId,
          p_agent_id: agentId,
          p_expected_revision_number: 1,
          p_prompt_md: "Revised",
        },
      },
    ]);
  });

  it("rejects authority fields and invalid prompt text at the input boundary", () => {
    expect(
      createFactoryAgentSchema.safeParse({ name: "Agent", slug: "agent", authority: "owner" })
        .success,
    ).toBe(false);
    expect(
      saveFactoryAgentPromptSchema.safeParse({
        expectedRevisionNumber: 1,
        promptMd: "Candidate",
        agentId,
        authority: "owner",
      }).success,
    ).toBe(false);
    expect(
      saveFactoryAgentPromptSchema.safeParse({ expectedRevisionNumber: 1, promptMd: "\u0000" })
        .success,
    ).toBe(false);
    expect(
      saveFactoryAgentPromptSchema.safeParse({ expectedRevisionNumber: 0, promptMd: "" }).success,
    ).toBe(false);
    expect(
      saveFactoryAgentPromptSchema.safeParse({
        expectedRevisionNumber: 1,
        promptMd: "🚀".repeat(20_000),
      }).success,
    ).toBe(true);
    expect(
      saveFactoryAgentPromptSchema.safeParse({
        expectedRevisionNumber: 1,
        promptMd: "🚀".repeat(20_001),
      }).success,
    ).toBe(false);
  });
});

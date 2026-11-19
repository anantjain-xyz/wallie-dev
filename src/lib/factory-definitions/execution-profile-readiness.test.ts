import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { resolveFactoryExecutionProfile } from "./execution-profile";
import { checkFactoryProfileCredentialReadiness } from "./execution-profile-readiness";

const scope = { workspaceId: "workspace", factoryId: "factory" };
const humanDefinition = {
  agent: { provider: "opencode", model: "openai/gpt-5.6-sol" },
  sandboxProvider: "vercel",
} as const;
const serviceDefinition = {
  ...humanDefinition,
  executionGrant: { id: "grant", version: 2 },
  credentialBindingId: "binding",
  implementationAgent: { agentId: "agent" },
};

function credentialDatabase(result: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(result, { status }));
  const admin = createClient<Database>("https://database.example.test", "test-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch },
  });
  return { admin, fetch };
}

describe("factory execution credential readiness", () => {
  it("checks only the exact scoped service binding, never the human invoker", async () => {
    const profile = resolveFactoryExecutionProfile(serviceDefinition, "human-invoker");
    const { admin, fetch } = credentialDatabase("ready");
    await expect(
      checkFactoryProfileCredentialReadiness({ ...scope, admin, profile }),
    ).resolves.toEqual({
      status: "ready",
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://database.example.test/rest/v1/rpc/check_factory_credential_binding",
      expect.objectContaining({
        body: JSON.stringify({
          p_workspace_id: "workspace",
          p_factory_id: "factory",
          p_binding_id: "binding",
          p_execution_grant_id: "grant",
          p_execution_grant_version: 2,
          p_factory_agent_id: "agent",
          p_agent_provider: "opencode",
          p_agent_model: "openai/gpt-5.6-sol",
        }),
      }),
    );
  });

  it("checks the original human owner's credential for the pinned model", async () => {
    const profile = resolveFactoryExecutionProfile(humanDefinition, "original-owner");
    const { admin, fetch } = credentialDatabase("ready");
    await expect(
      checkFactoryProfileCredentialReadiness({ ...scope, admin, profile }),
    ).resolves.toEqual({
      status: "ready",
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://database.example.test/rest/v1/rpc/check_session_agent_credential",
      expect.objectContaining({
        body: JSON.stringify({
          p_workspace_id: "workspace",
          p_creator_member_id: "original-owner",
          p_agent_provider: "opencode",
          p_agent_model: "openai/gpt-5.6-sol",
        }),
      }),
    );
  });

  it("keeps an unbound service profile unavailable without consulting a human credential", async () => {
    const profile = resolveFactoryExecutionProfile(
      { ...serviceDefinition, credentialBindingId: undefined },
      "human-invoker",
    );
    const { admin, fetch } = credentialDatabase("ready");
    await expect(
      checkFactoryProfileCredentialReadiness({ ...scope, admin, profile }),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "Choose an available service credential binding in Factory Definition.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["revoked", "grant_unavailable"])(
    "keeps a %s service binding unavailable",
    async (value) => {
      const profile = resolveFactoryExecutionProfile(serviceDefinition, "human-invoker");
      const { admin, fetch } = credentialDatabase(value);
      await expect(
        checkFactoryProfileCredentialReadiness({ ...scope, admin, profile }),
      ).resolves.toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining(
          value === "revoked" ? "active service credential" : "execution grant",
        ),
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["expired", "reconnect_required"])(
    "directs the original owner to reconnect for a %s credential",
    async (value) => {
      const profile = resolveFactoryExecutionProfile(humanDefinition, "original-owner");
      const { admin } = credentialDatabase(value);
      await expect(
        checkFactoryProfileCredentialReadiness({ ...scope, admin, profile }),
      ).resolves.toEqual({
        status: "unavailable",
        reason: "Reconnect the session owner’s OpenCode openai API key in Settings.",
      });
    },
  );

  it("returns an actionable message when the selected OpenCode provider has no credential", async () => {
    const profile = resolveFactoryExecutionProfile(humanDefinition, "original-owner");
    const { admin } = credentialDatabase("missing");
    await expect(
      checkFactoryProfileCredentialReadiness({ ...scope, admin, profile }),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "Connect the session owner’s OpenCode openai API key in Settings.",
    });
  });

  it("returns a safe unavailable message when the metadata lookup fails", async () => {
    const profile = resolveFactoryExecutionProfile(humanDefinition, "original-owner");
    const { admin } = credentialDatabase({ message: "private backend detail" }, 400);
    await expect(
      checkFactoryProfileCredentialReadiness({ ...scope, admin, profile }),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "Could not verify the session owner’s agent credential. Try again.",
    });
  });
});

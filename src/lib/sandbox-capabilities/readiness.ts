import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SandboxCapabilityReport } from "./contracts";
import { capabilityReportSucceeded } from "./probe";
import type { AgentProvider, SandboxConnection, SandboxProvider } from "@/lib/sandbox/types";
import { providerLabel } from "@/lib/sandbox/provider-contract";
import type { Database } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

export class SandboxCapabilityCheckStaleError extends Error {
  readonly provider: SandboxProvider;

  constructor(provider: SandboxProvider) {
    super(
      `Run a successful ${providerLabel(provider)} capability check for this repository and agent configuration before starting Wallie.`,
    );
    this.name = "SandboxCapabilityCheckStaleError";
    this.provider = provider;
  }
}

export async function assertCurrentSandboxCapabilityCheck(input: {
  admin: AdminClient;
  agent: { model: string; provider: AgentProvider };
  connection: Pick<SandboxConnection, "provider" | "revision">;
  definitionDigest?: string;
  repositoryId: string;
  workspaceId: string;
}): Promise<void> {
  async function latestCheck(digest: string | null, exactRuntime = false) {
    const checks = input.admin
      .from("sandbox_capability_checks")
      .select(
        "status, capabilities, agent_provider, agent_model, sandbox_provider, sandbox_connection_revision",
      )
      .eq("workspace_id", input.workspaceId)
      .eq("github_repository_id", input.repositoryId);
    const scope = digest
      ? checks.eq("factory_definition_digest", digest)
      : checks.is("factory_definition_digest", null);
    if (exactRuntime) {
      scope
        .eq("sandbox_provider", input.connection.provider)
        .eq("sandbox_connection_revision", input.connection.revision)
        .eq("agent_provider", input.agent.provider)
        .eq("agent_model", input.agent.model);
    }
    const { data, error } = await scope
      .order("checked_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  // Activation can reuse a current live check for the same runtime when there
  // is no candidate-specific check. Unrelated live settings stay out of scope.
  const data = input.definitionDigest
    ? ((await latestCheck(input.definitionDigest, true)) ?? (await latestCheck(null, true)))
    : await latestCheck(null);

  const agentMatch =
    data?.agent_provider === input.agent.provider && data?.agent_model === input.agent.model;
  const capabilities =
    typeof data?.capabilities === "object" && data.capabilities !== null
      ? (data.capabilities as Partial<SandboxCapabilityReport>)
      : {};
  const ready =
    data?.status === "success" &&
    data.sandbox_provider === input.connection.provider &&
    data.sandbox_connection_revision === input.connection.revision &&
    agentMatch &&
    capabilityReportSucceeded(capabilities, input.connection.provider, input.agent.provider);

  if (!ready) throw new SandboxCapabilityCheckStaleError(input.connection.provider);
}

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SandboxCapabilityReport } from "./contracts";
import { capabilityReportSucceeded } from "./probe";
import type { SandboxConnection, SandboxProvider } from "@/lib/sandbox/types";
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
  agent: { model: string; provider: string };
  connection: Pick<SandboxConnection, "provider" | "revision">;
  repositoryId: string;
  workspaceId: string;
}): Promise<void> {
  const { data, error } = await input.admin
    .from("sandbox_capability_checks")
    .select(
      "status, capabilities, agent_provider, agent_model, sandbox_provider, sandbox_connection_revision",
    )
    .eq("workspace_id", input.workspaceId)
    .eq("github_repository_id", input.repositoryId)
    .order("checked_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;

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
    capabilityReportSucceeded(capabilities);

  if (!ready) throw new SandboxCapabilityCheckStaleError(input.connection.provider);
}

function providerLabel(provider: SandboxProvider): string {
  if (provider === "e2b") return "E2B";
  if (provider === "daytona") return "Daytona";
  return "Vercel Sandbox";
}

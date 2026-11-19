import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { OPENCODE_ZEN_PROVIDER_ID, parseOpenCodeModelId } from "@/lib/agent-config/contracts";
import type { Database } from "@/lib/supabase/database.types";

import type { FactoryExecutionProfile } from "./execution-profile";

type CredentialReadiness = { status: "ready" } | { status: "unavailable"; reason: string };

const serviceCredentialReasons = {
  missing: "Choose an available service credential binding in Factory Definition.",
  revoked: "Publish a definition with an active service credential binding.",
  grant_unavailable: "Review the factory execution grant and its credential binding.",
} as const;

const providerNames: Record<FactoryExecutionProfile["provider"], string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
};

/** Check the credential authority of this pinned profile without loading key material. */
export async function checkFactoryProfileCredentialReadiness({
  admin,
  factoryId,
  profile,
  workspaceId,
}: {
  admin: Pick<SupabaseClient<Database>, "rpc">;
  factoryId: string;
  profile: Pick<FactoryExecutionProfile, "credentialAuthority" | "model" | "provider">;
  workspaceId: string;
}): Promise<CredentialReadiness> {
  const { credentialAuthority, model, provider } = profile;
  if (credentialAuthority.kind === "service") {
    const { agentId, bindingId, grantId, grantVersion } = credentialAuthority;
    if (!bindingId || !agentId) {
      return { status: "unavailable", reason: serviceCredentialReasons.missing };
    }

    const { data, error } = await admin.rpc("check_factory_credential_binding", {
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_binding_id: bindingId,
      p_execution_grant_id: grantId,
      p_execution_grant_version: grantVersion,
      p_factory_agent_id: agentId,
      p_agent_provider: provider,
      p_agent_model: model,
    });
    if (error) {
      return {
        status: "unavailable",
        reason: "Could not verify the factory service credential binding. Try again.",
      };
    }
    switch (data) {
      case "ready":
        return { status: "ready" };
      case "revoked":
      case "grant_unavailable":
        return { status: "unavailable", reason: serviceCredentialReasons[data] };
      default:
        return { status: "unavailable", reason: serviceCredentialReasons.missing };
    }
  }

  if (!credentialAuthority.memberId) {
    return {
      status: "unavailable",
      reason: "An active workspace member must own the session credential.",
    };
  }
  const { data, error } = await admin.rpc("check_session_agent_credential", {
    p_workspace_id: workspaceId,
    p_creator_member_id: credentialAuthority.memberId,
    p_agent_provider: provider,
    p_agent_model: model,
  });
  if (error) {
    return {
      status: "unavailable",
      reason: "Could not verify the session owner’s agent credential. Try again.",
    };
  }
  if (data === "ready") return { status: "ready" };

  const openCodeProvider =
    provider === "opencode" ? parseOpenCodeModelId(model)?.providerId : undefined;
  const credentialName = openCodeProvider
    ? `${openCodeProvider === OPENCODE_ZEN_PROVIDER_ID ? "OpenCode Zen" : `OpenCode ${openCodeProvider}`} API key`
    : `${providerNames[provider]} credential`;
  const action = data === "expired" || data === "reconnect_required" ? "Reconnect" : "Connect";
  return {
    status: "unavailable",
    reason: `${action} the session owner’s ${credentialName} in Settings.`,
  };
}

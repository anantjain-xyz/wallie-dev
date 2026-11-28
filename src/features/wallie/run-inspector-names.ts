import "server-only";

import type { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  RunInspectorCredential,
  RunInspectorExecutionProfile,
  RunInspectorRoutingDecision,
} from "./run-inspector-data";

export type RunInspectorNames = Awaited<ReturnType<typeof loadRunInspectorNames>>;

export async function loadRunInspectorNames({
  supabase,
  workspaceId,
  executionProfile,
  routingDecision,
  credential,
  factoryId,
}: {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  workspaceId: string;
  executionProfile: RunInspectorExecutionProfile;
  routingDecision: RunInspectorRoutingDecision;
  credential: RunInspectorCredential | null;
  factoryId: string;
}) {
  const profile =
    executionProfile.kind === "recorded" && executionProfile.profile.factoryId === factoryId
      ? executionProfile.profile
      : null;
  const receipt =
    routingDecision.kind === "recorded" && routingDecision.receipt.factoryId === factoryId
      ? routingDecision.receipt
      : null;
  const routedAgent =
    receipt?.decision.disposition === "selected" ? receipt.decision.configuration.agentId : null;
  const principalIds = [
    profile?.authority.kind === "service" ? profile.authority.servicePrincipalId : null,
    credential?.servicePrincipalId,
  ].filter((id): id is string => Boolean(id));
  const memberIds = [
    profile?.invokingMemberId,
    profile?.triggeredByMemberId,
    profile?.authority.kind === "human" ? profile.authority.memberId : null,
    receipt?.override?.actorMemberId,
  ].filter((id): id is string => Boolean(id));
  const agentIds = [profile?.agentId, routedAgent].filter((id): id is string => Boolean(id));
  const [agents, members, prompt, principal] = await Promise.all([
    agentIds.length
      ? supabase
          .from("factory_agents")
          .select("id, name")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .in("id", agentIds)
      : null,
    memberIds.length
      ? supabase
          .from("workspace_members")
          .select("id, full_name, username, kind, is_active")
          .eq("workspace_id", workspaceId)
          .in("id", memberIds)
      : null,
    profile?.agentId && profile.promptRevisionId
      ? supabase
          .from("factory_agent_prompt_revisions")
          .select("revision_number")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .eq("agent_id", profile.agentId)
          .eq("id", profile.promptRevisionId)
          .maybeSingle()
      : null,
    principalIds.length
      ? supabase
          .from("service_principals")
          .select("id, name")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .in("id", principalIds)
      : null,
  ]);
  return {
    agents: Object.fromEntries((agents?.data ?? []).map(({ id, name }) => [id, name])),
    members: Object.fromEntries(
      (members?.data ?? []).map((member) => {
        const name = member.full_name?.trim() || (member.username ? `@${member.username}` : null);
        const type =
          member.kind === "system"
            ? "System member"
            : member.is_active
              ? "Member"
              : "Former member";
        return [member.id, name ? `${name} · ${type}` : type];
      }),
    ),
    promptRevisionNumber: prompt?.data?.revision_number ?? null,
    principals: Object.fromEntries((principal?.data ?? []).map(({ id, name }) => [id, name])),
  };
}

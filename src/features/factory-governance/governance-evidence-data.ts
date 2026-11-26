import "server-only";

import { z } from "zod";

import { auditDetailSchema } from "./governance-audit-detail";
import type { GovernanceScope } from "./governance-data";
import type { FactoryAuditEvent } from "@/lib/factories/audit";
import type { FactoryAuditSource } from "@/lib/factories/audit-contracts";
import { executionRequirementsSchema } from "@/lib/execution-policy/contracts";
import type { Tables } from "@/lib/supabase/database.types";

type Grant = Pick<
  Tables<"factory_execution_grants">,
  | "id"
  | "service_principal_id"
  | "github_repository_id"
  | "read_context_repository_ids"
  | "tool_ids"
  | "execution_policy_revision_id"
  | "version"
  | "revoked_at"
  | "expires_at"
>;

const uuid = z.string().uuid();

async function readGovernanceIdResults<T>(
  values: Array<string | undefined>,
  query: (ids: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
) {
  const ids = [...new Set(values.filter((id): id is string => uuid.safeParse(id).success))];
  const groups = Array.from({ length: Math.ceil(ids.length / 75) }, (_, index) =>
    ids.slice(index * 75, (index + 1) * 75),
  );
  const results = await Promise.all(
    groups.map(async (group) => ({ ids: group, result: await query(group) })),
  );
  return {
    rows: results.flatMap(({ result }) => (result.error ? [] : (result.data ?? []))),
    failedIds: new Set(
      results.flatMap(({ ids, result }) => (result.error || result.data === null ? ids : [])),
    ),
  };
}

export async function readGovernanceIds<T>(
  values: Array<string | undefined>,
  query: (ids: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
) {
  return (await readGovernanceIdResults(values, query)).rows;
}

export function governancePolicy(
  {
    id,
    requirements,
    revision,
  }: Pick<Tables<"execution_policy_revisions">, "id" | "requirements" | "revision">,
  currentId?: string,
) {
  return {
    id,
    label: `Revision ${revision}${id === currentId ? " (current workspace policy)" : ""}`,
    requirements: executionRequirementsSchema.safeParse(requirements).data ?? null,
  };
}

export async function loadGovernanceEvidence(
  { factory, supabase, workspaceId }: GovernanceScope,
  {
    asOf,
    bindings,
    events,
    source,
    visibleGrants,
  }: {
    asOf: number;
    bindings: {
      grantId: string;
      agentId: string;
      principalId: string;
      provider: string;
      revokedAt: string | null;
    }[];
    events: FactoryAuditEvent[];
    source?: FactoryAuditSource;
    visibleGrants: Grant[];
  },
) {
  const details = events.flatMap((event) => {
    const detail = auditDetailSchema.safeParse(event.detail).data;
    return detail ? [{ action: event.action, detail }] : [];
  });
  const active = visibleGrants.filter(
    (grant) => !grant.revoked_at && Date.parse(grant.expires_at) > asOf,
  );
  const activeIds = active.map(({ id }) => id);
  const [linkedGrants, mcpBindings, clients, tokens, registrations] = await Promise.all([
    readGovernanceIds(
      [
        ...bindings.map(({ grantId }) => grantId),
        ...details.map(
          ({ action, detail }) =>
            detail.grantId ??
            detail.executionGrantId ??
            (action.startsWith("execution_grant.") ? detail.id : undefined),
        ),
      ].filter((id) => !visibleGrants.some((grant) => grant.id === id)),
      (ids) =>
        supabase
          .from("factory_execution_grants")
          .select(
            "id, service_principal_id, github_repository_id, read_context_repository_ids, tool_ids, execution_policy_revision_id, version, revoked_at, expires_at",
          )
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .in("id", ids),
    ),
    readGovernanceIds(
      [
        source?.kind === "mcp-binding" ? source.id : undefined,
        ...details
          .filter(({ action }) => action.startsWith("mcp_secret_binding."))
          .map(({ detail }) => detail.bindingId),
      ],
      (ids) =>
        supabase
          .from("factory_mcp_secret_bindings")
          .select("id, tool_revision_id, factory_agent_id")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .in("id", ids),
    ),
    readGovernanceIds(
      details.map(({ detail }) => detail.clientId),
      (ids) =>
        supabase
          .from("factory_oauth_clients")
          .select("id, name")
          .eq("workspace_id", workspaceId)
          .in("id", ids),
    ),
    readGovernanceIdResults(activeIds, (ids) =>
      supabase
        .from("factory_machine_tokens")
        .select("id, name, execution_grant_id, execution_grant_version, expires_at")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factory.id)
        .is("revoked_at", null)
        .in("execution_grant_id", ids)
        .order("id"),
    ),
    readGovernanceIdResults(activeIds, (ids) =>
      supabase
        .from("factory_oauth_client_bindings")
        .select(
          "client_id, execution_grant_id, execution_grant_version, factory_oauth_clients(name, revoked_at)",
        )
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factory.id)
        .in("execution_grant_id", ids)
        .order("client_id"),
    ),
  ]);

  const grants = [...visibleGrants, ...linkedGrants];
  const [principals, repositories, policies, agents, toolRevisions] = await Promise.all([
    readGovernanceIds(
      [
        ...grants.map(({ service_principal_id }) => service_principal_id),
        ...bindings.map(({ principalId }) => principalId),
        ...details.map(
          ({ action, detail }) =>
            detail.service_principal_id ??
            detail.servicePrincipalId ??
            (action === "service_principal.created" ? detail.id : undefined),
        ),
      ],
      (ids) =>
        supabase
          .from("service_principals")
          .select("id, name, slug")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .in("id", ids),
    ),
    readGovernanceIds(
      [
        ...grants.flatMap((grant) => [
          grant.github_repository_id,
          ...grant.read_context_repository_ids,
        ]),
        ...details.flatMap(({ detail }) => [
          detail.github_repository_id,
          ...(detail.read_context_repository_ids ?? []),
        ]),
      ],
      (ids) =>
        supabase
          .from("github_repositories")
          .select("id, full_name, is_archived")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .in("id", ids),
    ),
    readGovernanceIds(
      [
        ...grants.map(({ execution_policy_revision_id }) => execution_policy_revision_id),
        ...details.map(({ detail }) => detail.execution_policy_revision_id),
      ],
      (ids) =>
        supabase
          .from("execution_policy_revisions")
          .select("id, revision, requirements")
          .eq("workspace_id", workspaceId)
          .in("id", ids),
    ),
    readGovernanceIds(
      [
        ...bindings.map(({ agentId }) => agentId),
        ...mcpBindings.map(({ factory_agent_id }) => factory_agent_id),
        ...details.map(({ detail }) => detail.factoryAgentId ?? detail.agentId),
      ],
      (ids) =>
        supabase
          .from("factory_agents")
          .select("id, name")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .in("id", ids),
    ),
    readGovernanceIds(
      [
        ...grants.flatMap(({ tool_ids }) => tool_ids.map((id) => id.split("/")[0])),
        ...mcpBindings.map(({ tool_revision_id }) => tool_revision_id),
        ...details.flatMap(({ detail }) => [
          detail.revisionId,
          ...(detail.tool_ids ?? []).map((id) => id.split("/")[0]),
        ]),
      ],
      (ids) =>
        supabase
          .from("factory_mcp_server_revisions")
          .select("id, revision_number, operation_names, factory_mcp_servers!inner(name)")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .in("id", ids),
    ),
  ]);

  const dependencies: Partial<Record<string, { entries: string[]; readFailed: boolean }>> =
    Object.fromEntries(
      active.map((grant) => [
        grant.id,
        {
          readFailed: tokens.failedIds.has(grant.id) || registrations.failedIds.has(grant.id),
          entries: [
            ...tokens.rows
              .filter(
                (row) =>
                  row.execution_grant_id === grant.id &&
                  row.execution_grant_version === grant.version &&
                  (!row.expires_at || Date.parse(row.expires_at) > asOf),
              )
              .map(({ name }) => `Machine token: ${name}`),
            ...registrations.rows
              .filter(
                (row) =>
                  row.execution_grant_id === grant.id &&
                  row.execution_grant_version === grant.version &&
                  row.factory_oauth_clients &&
                  !row.factory_oauth_clients.revoked_at,
              )
              .map((row) => `OAuth client: ${row.factory_oauth_clients?.name}`),
            ...bindings
              .filter((row) => row.grantId === grant.id && !row.revokedAt)
              .map(
                (row) =>
                  `Credential binding: ${agents.find(({ id }) => id === row.agentId)?.name ?? "Agent unavailable"} · ${row.provider}`,
              ),
          ],
        },
      ]),
    );

  return {
    agents,
    clients,
    dependencies,
    grants,
    mcpBindings,
    policies,
    principals,
    repositories,
    toolRevisions,
  };
}

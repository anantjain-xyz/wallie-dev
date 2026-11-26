import "server-only";

import type { GovernanceScope } from "@/features/factory-governance/governance-data";
import { readGovernanceIds } from "./governance-evidence-data";
import { factoryCommandLabels } from "@/lib/factory-machine-tokens/contracts";

const pageSize = 20;

type OAuthDataQuery = {
  afterOAuthClient?: string;
  afterOAuthGrant?: string;
} & (
  | { isOperator: boolean; consentingMemberId?: never }
  | { consentingMemberId: string; isOperator?: never }
);

export async function loadOAuthClientData(
  { supabase, workspaceId }: Pick<GovernanceScope, "supabase" | "workspaceId">,
  { afterOAuthClient, afterOAuthGrant, consentingMemberId, isOperator }: OAuthDataQuery,
) {
  const asOf = new Date().toISOString();
  const clientQuery = supabase
    .from("factory_oauth_clients")
    .select("id, name, redirect_uris, allowed_scopes, created_at, revoked_at")
    .eq("workspace_id", workspaceId)
    .order("id")
    .limit(pageSize + 1);
  let grantQuery = supabase
    .from("factory_oauth_grants")
    .select("id, client_id, consenting_member_id, created_at, expires_at, revoked_at")
    .eq("workspace_id", workspaceId)
    .order("id")
    .limit(pageSize + 1);
  if (consentingMemberId) grantQuery = grantQuery.eq("consenting_member_id", consentingMemberId);
  const [clients, grants, factories, executionGrants] = await Promise.all([
    !isOperator ? null : afterOAuthClient ? clientQuery.gt("id", afterOAuthClient) : clientQuery,
    afterOAuthGrant ? grantQuery.gt("id", afterOAuthGrant) : grantQuery,
    supabase
      .from("factories")
      .select("id, name, status")
      .eq("workspace_id", workspaceId)
      .order("name"),
    isOperator
      ? supabase
          .from("factory_execution_grants")
          .select(
            "id, factory_id, github_repository_id, version, command_scopes, expires_at, service_principals(name, slug)",
          )
          .eq("workspace_id", workspaceId)
          .is("revoked_at", null)
          .gt("expires_at", asOf)
          .not("command_scopes", "eq", "{}")
          .order("id")
      : null,
  ]);
  for (const response of [clients, grants, factories, executionGrants]) {
    if (response?.error) throw response.error;
  }

  const clientRows = (clients?.data ?? []).slice(0, pageSize);
  const grantRows = (grants.data ?? []).slice(0, pageSize);
  const linkedClientIds = [...new Set(grantRows.map((grant) => grant.client_id))];
  const [clientBindings, grantBindings, linkedClients] = await Promise.all([
    clientRows.length
      ? supabase
          .from("factory_oauth_client_bindings")
          .select("client_id, factory_id")
          .eq("workspace_id", workspaceId)
          .in(
            "client_id",
            clientRows.map((client) => client.id),
          )
          .order("factory_id")
      : null,
    grantRows.length
      ? supabase
          .from("factory_oauth_grant_bindings")
          .select("grant_id, factory_id, scopes")
          .eq("workspace_id", workspaceId)
          .in(
            "grant_id",
            grantRows.map((grant) => grant.id),
          )
          .order("factory_id")
      : null,
    linkedClientIds.length
      ? supabase
          .from("factory_oauth_clients")
          .select("id, name, revoked_at")
          .eq("workspace_id", workspaceId)
          .in("id", linkedClientIds)
      : null,
  ]);
  for (const response of [clientBindings, grantBindings, linkedClients]) {
    if (response?.error) throw response.error;
  }

  const factoryRows = factories.data ?? [];
  const eligibleGrants = executionGrants?.data ?? [];
  const repositories = await readGovernanceIds(
    eligibleGrants.map(({ github_repository_id }) => github_repository_id),
    (ids) =>
      supabase
        .from("github_repositories")
        .select("id, factory_id, full_name")
        .eq("workspace_id", workspaceId)
        .in("id", ids),
  );
  const factoryName = (id: string) =>
    factoryRows.find((factory) => factory.id === id)?.name ?? "Unavailable factory";
  return {
    asOf,
    registered: clientRows.map((client) => ({
      ...client,
      factories: (clientBindings?.data ?? [])
        .filter((binding) => binding.client_id === client.id)
        .map((binding) => factoryName(binding.factory_id)),
    })),
    connected: grantRows.map((grant) => ({
      ...grant,
      client: linkedClients?.data?.find((client) => client.id === grant.client_id),
      factories: (grantBindings?.data ?? [])
        .filter((binding) => binding.grant_id === grant.id)
        .map((binding) => ({
          id: binding.factory_id,
          name: factoryName(binding.factory_id),
          scopes: binding.scopes,
        })),
    })),
    nextClient: (clients?.data?.length ?? 0) > pageSize ? clientRows.at(-1)?.id : undefined,
    nextGrant: (grants.data?.length ?? 0) > pageSize ? grantRows.at(-1)?.id : undefined,
    grantOptions: factoryRows.flatMap((factory) => {
      if (factory.status !== "active") return [];
      const choices = eligibleGrants
        .filter((grant) => grant.factory_id === factory.id)
        .map((grant) => {
          const principal = grant.service_principals;
          const repository = repositories.find(
            ({ id, factory_id }) => id === grant.github_repository_id && factory_id === factory.id,
          );
          const scopeLabels = grant.command_scopes
            .map((scope) => factoryCommandLabels[scope])
            .join(", ");
          return {
            id: grant.id,
            version: grant.version,
            scopes: grant.command_scopes,
            label: `${principal ? `${principal.name} (${principal.slug})` : "Service principal unavailable"} · ${repository?.full_name ?? "Repository unavailable"} · v${grant.version} · ${scopeLabels} · Expires ${grant.expires_at.slice(0, 16).replace("T", " ")} UTC`,
          };
        });
      return choices.length ? [{ id: factory.id, name: factory.name, choices }] : [];
    }),
  };
}

export type GovernanceOAuthData = Awaited<ReturnType<typeof loadOAuthClientData>>;

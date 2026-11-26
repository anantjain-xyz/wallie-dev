import "server-only";

import type { GovernanceScope } from "./governance-data";
import { readGovernanceIds } from "./governance-evidence-data";
import { loadFactoryEventSubscriptionSettings } from "@/lib/factory-event-subscriptions/management";

export async function loadGovernanceSubscriptions(scope: GovernanceScope) {
  const { actorUserId, factory, supabase, workspaceId } = scope;
  const { subscriptions, authorizations } = await loadFactoryEventSubscriptionSettings({
    actorUserId,
    factoryId: factory.id,
    workspaceId,
  });
  const credentials = [...subscriptions, ...authorizations];
  const credentialIds = (kind: "machine_token" | "oauth_grant") => [
    ...new Set(
      credentials
        .filter(({ credential_kind }) => credential_kind === kind)
        .map(({ credential_id }) => credential_id),
    ),
  ];
  const tokenIds = credentialIds("machine_token");
  const connectionIds = credentialIds("oauth_grant");
  const [tokens, connections] = await Promise.all([
    tokenIds.length
      ? supabase
          .from("factory_machine_tokens")
          .select("id, name, execution_grant_id, execution_grant_version")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .in("id", tokenIds)
      : null,
    connectionIds.length
      ? supabase
          .from("factory_oauth_grant_bindings")
          .select(
            "grant_id, execution_grant_id, execution_grant_version, factory_oauth_grants(factory_oauth_clients(name))",
          )
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .in("grant_id", connectionIds)
      : null,
  ]);

  const metadata = new Map<string, { name?: string; grantId: string; version: number }>();
  for (const token of tokens?.data ?? []) {
    metadata.set(`machine_token:${token.id}`, {
      name: token.name,
      grantId: token.execution_grant_id,
      version: token.execution_grant_version,
    });
  }
  for (const connection of connections?.data ?? []) {
    metadata.set(`oauth_grant:${connection.grant_id}`, {
      name: connection.factory_oauth_grants?.factory_oauth_clients?.name,
      grantId: connection.execution_grant_id,
      version: connection.execution_grant_version,
    });
  }

  const principalIds = [
    ...new Set(authorizations.map(({ service_principal_id }) => service_principal_id)),
  ];
  const grantIds = [...new Set([...metadata.values()].map(({ grantId }) => grantId))];
  const [principals, grants] = await Promise.all([
    principalIds.length
      ? supabase
          .from("service_principals")
          .select("id, name, slug")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .in("id", principalIds)
      : null,
    grantIds.length
      ? supabase
          .from("factory_execution_grants")
          .select("id, github_repository_id")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .in("id", grantIds)
      : null,
  ]);
  const repositories = await readGovernanceIds(
    (grants?.data ?? []).map(({ github_repository_id }) => github_repository_id),
    (ids) =>
      supabase
        .from("github_repositories")
        .select("id, full_name")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factory.id)
        .in("id", ids),
  );
  const key = (credential: (typeof credentials)[number]) =>
    `${credential.credential_kind}:${credential.credential_id}`;
  const eligibleNames = new Map(
    authorizations.map((authorization) => [key(authorization), authorization.credential_name]),
  );

  return {
    subscriptions: subscriptions.map((subscription) => {
      const backing = metadata.get(key(subscription));
      return {
        ...subscription,
        credentialLabel: backing?.name ?? eligibleNames.get(key(subscription)) ?? null,
        grantId: backing?.grantId,
        grantVersion: backing?.version,
      };
    }),
    authorizations: authorizations.map((authorization) => {
      const backing = metadata.get(key(authorization));
      const principal = principals?.data?.find(
        ({ id }) => id === authorization.service_principal_id,
      );
      const grant = grants?.data?.find(({ id }) => id === backing?.grantId);
      const repository = repositories.find(({ id }) => id === grant?.github_repository_id);
      const principalLabel = principal
        ? `${principal.name} (${principal.slug})`
        : "Service principal unavailable";
      const grantLabel = backing
        ? `${repository?.full_name ?? "Repository unavailable"} · Grant v${backing.version}`
        : "Grant details unavailable";
      return { ...authorization, scopeLabel: `${principalLabel} · ${grantLabel}` };
    }),
  };
}

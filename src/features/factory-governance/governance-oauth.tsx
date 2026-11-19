import type { ReactNode } from "react";

import { MetadataItem, MetadataList, PageSection } from "@/components/ui/page-shell";
import {
  RegisterOAuthClient,
  RevokeOAuthAccess,
} from "@/features/factory-governance/governance-oauth-actions";
import type { GovernanceOAuthData } from "@/features/factory-governance/governance-oauth-data";
import { GovernanceTime } from "@/features/factory-governance/governance-resource-link";
import { factoryCommandLabels } from "@/lib/factory-machine-tokens/contracts";

type ResourceProps = { data: GovernanceOAuthData; navigation?: ReactNode; workspaceId: string };

export function RegisteredOAuthClients({ data, navigation, workspaceId }: ResourceProps) {
  return (
    <PageSection anchorId="oauth-clients" title="OAuth clients">
      <div className="space-y-4">
        {data.registered.length ? (
          <div className="ui-sheet divide-y divide-border">
            {data.registered.map((client) => (
              <article className="min-w-0 space-y-3 p-4 sm:p-5" key={client.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-foreground [overflow-wrap:anywhere]">
                    {client.name}
                  </h3>
                  {client.revoked_at ? (
                    <span className="type-label text-muted">Revoked</span>
                  ) : (
                    <RevokeOAuthAccess
                      command={{ action: "revoke-client", clientId: client.id }}
                      name={client.name}
                      workspaceId={workspaceId}
                    />
                  )}
                </div>
                <MetadataList>
                  <MetadataItem
                    label="Client ID"
                    monospace
                    value={<span className="[overflow-wrap:anywhere]">{client.id}</span>}
                  />
                  <MetadataItem label="Factories" value={client.factories.join(", ")} />
                  <MetadataItem
                    label="Scopes"
                    value={client.allowed_scopes
                      .map((scope) => factoryCommandLabels[scope])
                      .join(", ")}
                  />
                  <MetadataItem
                    label="Registered"
                    value={<GovernanceTime value={client.created_at} />}
                  />
                  <MetadataItem
                    label="Redirect URIs"
                    value={
                      <ul className="[overflow-wrap:anywhere]">
                        {client.redirect_uris.map((uri) => (
                          <li className="font-mono" key={uri}>
                            {uri}
                          </li>
                        ))}
                      </ul>
                    }
                  />
                </MetadataList>
              </article>
            ))}
          </div>
        ) : (
          <p className="type-secondary text-muted">No OAuth clients on this page.</p>
        )}
        {navigation}
        <RegisterOAuthClient options={data.grantOptions} workspaceId={workspaceId} />
      </div>
    </PageSection>
  );
}

export function ConnectedOAuthClients({
  data,
  memberOptions,
  navigation,
  workspaceId,
}: ResourceProps & { memberOptions: Array<{ id: string; label: string }> }) {
  return (
    <PageSection anchorId="connected-clients" title="Connected clients">
      {data.connected.length ? (
        <div className="ui-sheet divide-y divide-border">
          {data.connected.map((grant) => {
            const name = grant.client?.name ?? "OAuth client";
            const revoked = grant.revoked_at || grant.client?.revoked_at;
            const expired = Date.parse(grant.expires_at) <= Date.parse(data.asOf);
            return (
              <article className="min-w-0 space-y-3 p-4 sm:p-5" key={grant.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-foreground [overflow-wrap:anywhere]">{name}</h3>
                  {revoked || expired ? (
                    <span className="type-label text-muted">
                      {revoked ? "Disconnected" : "Expired"}
                    </span>
                  ) : (
                    <RevokeOAuthAccess
                      command={{ action: "revoke-grant", grantId: grant.id }}
                      name={name}
                      workspaceId={workspaceId}
                    />
                  )}
                </div>
                <MetadataList>
                  <MetadataItem
                    label="Connection ID"
                    monospace
                    value={<span className="[overflow-wrap:anywhere]">{grant.id}</span>}
                  />
                  <MetadataItem
                    label="Factories"
                    value={grant.factories.join(", ") || "No current factory access"}
                  />
                  <MetadataItem
                    label="Authorized by"
                    value={
                      memberOptions.find(({ id }) => id === grant.consenting_member_id)?.label ??
                      "Unavailable"
                    }
                  />
                  <MetadataItem
                    label="Scopes"
                    value={grant.scopes.map((scope) => factoryCommandLabels[scope]).join(", ")}
                  />
                  <MetadataItem
                    label="Connected"
                    value={<GovernanceTime value={grant.created_at} />}
                  />
                  <MetadataItem
                    label="Expires"
                    value={<GovernanceTime value={grant.expires_at} />}
                  />
                </MetadataList>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="type-secondary text-muted">No connected clients on this page.</p>
      )}
      {navigation}
    </PageSection>
  );
}

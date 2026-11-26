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
    <PageSection anchorId="oauth-clients" title="Workspace OAuth clients">
      <div className="space-y-4">
        <p className="type-secondary text-muted">
          A registration can cover more than one factory. This list is not filtered by the factory
          selector.
        </p>
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
                      factories={client.factories}
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
  governanceScope,
  memberOptions,
  navigation,
  workspaceId,
}: ResourceProps & {
  governanceScope?: "workspace" | "personal";
  memberOptions?: Array<{ id: string; label: string }>;
}) {
  return (
    <PageSection
      anchorId="connected-clients"
      title={
        governanceScope === "workspace"
          ? "Workspace connected clients"
          : governanceScope === "personal"
            ? "Your connected clients"
            : "Connected clients"
      }
    >
      {governanceScope && (
        <p className="mb-3 type-secondary text-muted">
          {governanceScope === "workspace"
            ? "Connections authorized by workspace members."
            : "Only connections you authorized."}{" "}
          The factory selector does not filter this list.
        </p>
      )}
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
                      factories={
                        governanceScope ? grant.factories.map(({ name }) => name) : undefined
                      }
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
                    label="Factories and scopes"
                    value={
                      grant.factories.length ? (
                        <ul className="space-y-1">
                          {grant.factories.map((factory) => (
                            <li key={factory.id} className="[overflow-wrap:anywhere]">
                              {factory.name} ·{" "}
                              {factory.scopes
                                .map((scope) => factoryCommandLabels[scope])
                                .join(", ")}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        "No current factory access"
                      )
                    }
                  />
                  {memberOptions && (
                    <MetadataItem
                      label="Authorized by"
                      value={
                        memberOptions.find(({ id }) => id === grant.consenting_member_id)?.label ??
                        "Unavailable"
                      }
                    />
                  )}
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

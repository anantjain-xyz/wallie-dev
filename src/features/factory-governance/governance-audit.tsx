import Link from "next/link";
import { z } from "zod";

import { MetadataItem, MetadataList, PageSection } from "@/components/ui/page-shell";
import type {
  GovernanceData,
  GovernanceScope,
} from "@/features/factory-governance/governance-data";
import {
  governanceSourceQuery,
  GovernanceResourceLink,
  GovernanceTime,
} from "@/features/factory-governance/governance-resource-link";
import type { FactoryAuditEvent } from "@/lib/factories/audit";
import { factoryAuditSourceSchema, type FactoryAuditSource } from "@/lib/factories/audit-contracts";
import {
  factoryCommandLabels,
  factoryCommandScopesSchema,
} from "@/lib/factory-machine-tokens/contracts";
import { workspaceAgentDetailPath, workspaceGovernancePath } from "@/lib/routes";

const auditActions = {
  "service_principal.created": {
    label: "Service principal created",
    source: "principal",
    idKey: "id",
  },
  "execution_grant.approved": { label: "Grant approved", source: "grant", idKey: "id" },
  "execution_grant.updated": { label: "Grant updated", source: "grant", idKey: "id" },
  "execution_grant.revoked": { label: "Grant revoked", source: "grant", idKey: "id" },
  "machine_token.issued": { label: "Machine token issued", source: "grant", idKey: "grantId" },
  "machine_token.revoked": { label: "Machine token revoked", source: "grant", idKey: "grantId" },
  "oauth_client.registered": {
    label: "OAuth client registered",
    source: "grant",
    idKey: "grantId",
  },
  "oauth_client.revoked": { label: "OAuth client revoked" },
  "oauth_grant.connected": { label: "OAuth client connected", source: "grant", idKey: "grantId" },
  "oauth_grant.revoked": { label: "OAuth client disconnected", source: "grant", idKey: "grantId" },
  "credential_binding.created": {
    label: "Credential attached",
    source: "binding",
    idKey: "bindingId",
  },
  "credential_binding.revoked": {
    label: "Credential revoked",
    source: "binding",
    idKey: "bindingId",
  },
  "mcp_secret_binding.created": {
    label: "MCP credential attached",
    source: "mcp-binding",
    idKey: "bindingId",
  },
  "mcp_secret_binding.revoked": {
    label: "MCP credential revoked",
    source: "mcp-binding",
    idKey: "bindingId",
  },
} as const;

const auditDetailSchema = z.object({
  id: z.string().optional(),
  clientId: z.string().uuid().optional(),
  oauthGrantId: z.string().uuid().optional(),
  grantVersion: z.number().int().positive().safe().optional(),
  scopes: factoryCommandScopesSchema.optional(),
  reason: z.unknown().optional(),
  bindingId: z.string().optional(),
  name: z.string().optional(),
  version: z.number().int().positive().safe().optional(),
  service_principal_id: z.string().uuid().optional(),
  servicePrincipalId: z.string().uuid().optional(),
  executionGrantId: z.string().uuid().optional(),
  grantId: z.string().uuid().optional(),
  factoryAgentId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  revisionId: z.string().uuid().optional(),
  github_repository_id: z.string().uuid().optional(),
  read_context_repository_ids: z.array(z.string()).optional(),
  tool_ids: z.array(z.string()).optional(),
  execution_policy_revision_id: z.string().uuid().optional(),
  budget_payer_member_id: z.string().uuid().optional(),
  expires_at: z.string().datetime({ offset: true }).optional(),
  revocation_reason: z.string().nullable().optional(),
});

const oauthRevocationReasonSchema = z.enum(["disconnected", "refresh_reuse", "client_revoked"]);
const oauthRevocationReasons = {
  disconnected: "Disconnected by a member",
  refresh_reuse: "Refresh credential reused",
  client_revoked: "Client registration revoked",
};
const resourceNames = {
  grant: "Grant",
  principal: "Service principal",
  binding: "Credential binding",
  "mcp-binding": "MCP credential binding",
};

function AuditEventCard({
  data,
  event,
  focused,
  scope,
}: {
  data: GovernanceData;
  event: FactoryAuditEvent;
  focused: boolean;
  scope: GovernanceScope;
}) {
  const { factory, workspaceSlug } = scope;
  const action = auditActions[event.action as keyof typeof auditActions];
  const detail = auditDetailSchema.safeParse(event.detail).data;
  const resource =
    action && "source" in action
      ? factoryAuditSourceSchema.safeParse({
          kind: action.source,
          id: detail?.[action.idKey],
        }).data
      : undefined;
  const actor = data.memberOptions.find(({ id }) => id === event.actor_member_id);
  const label = action?.label ?? "Governance operation";
  const linkProps = { factoryId: factory.id, workspaceSlug };
  const principalId = detail?.service_principal_id ?? detail?.servicePrincipalId;
  const grantId = detail?.executionGrantId ?? detail?.grantId;
  const agentId = detail?.factoryAgentId ?? detail?.agentId;
  const oauthRevocationReason = oauthRevocationReasonSchema.safeParse(detail?.reason).data;

  return (
    <article className="min-w-0 space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-foreground">
          {focused ? (
            label
          ) : (
            <GovernanceResourceLink {...linkProps} source={{ kind: "event", id: event.id }}>
              {label}
            </GovernanceResourceLink>
          )}
        </h3>
        <span className="type-label text-muted">
          <GovernanceTime value={event.created_at} />
        </span>
      </div>
      <MetadataList>
        <MetadataItem
          label="Source factory"
          value={
            <Link
              className="font-medium underline underline-offset-4"
              href={workspaceGovernancePath(workspaceSlug, { factory: event.factory_id })}
            >
              {factory.name}
            </Link>
          }
        />
        <MetadataItem
          label="Actor"
          value={
            event.actor_member_id ? (
              <GovernanceResourceLink
                {...linkProps}
                source={{ kind: "actor", id: event.actor_member_id }}
              >
                {actor?.label ?? event.actor_member_id}
              </GovernanceResourceLink>
            ) : (
              "Unavailable"
            )
          }
        />
        <MetadataItem
          label="Resource"
          value={
            resource && resource.kind !== "event" && resource.kind !== "actor" ? (
              <GovernanceResourceLink {...linkProps} source={resource}>
                {detail?.name ?? `${resourceNames[resource.kind]} ${resource.id.slice(0, 8)}`}
              </GovernanceResourceLink>
            ) : detail?.clientId ? (
              `OAuth client ${detail.clientId.slice(0, 8)}`
            ) : (
              "Unavailable"
            )
          }
        />
        {detail?.grantVersion && (
          <MetadataItem label="Recorded grant version" value={detail.grantVersion} />
        )}
        {detail?.version && <MetadataItem label="Recorded version" value={detail.version} />}
        {oauthRevocationReason && (
          <MetadataItem label="Reason" value={oauthRevocationReasons[oauthRevocationReason]} />
        )}
        {detail?.revocation_reason && (
          <MetadataItem
            label="Revocation reason"
            value={<span className="[overflow-wrap:anywhere]">{detail.revocation_reason}</span>}
          />
        )}
        {focused && (
          <>
            <MetadataItem label="Event ID" value={event.id} monospace />
            {detail?.clientId && (
              <MetadataItem label="OAuth client ID" value={detail.clientId} monospace />
            )}
            {detail?.oauthGrantId && (
              <MetadataItem label="Connection ID" value={detail.oauthGrantId} monospace />
            )}
            {detail?.scopes && (
              <MetadataItem
                label="Command scopes"
                value={detail.scopes.map((scope) => factoryCommandLabels[scope]).join(", ")}
              />
            )}
            {detail?.id &&
              (event.action === "machine_token.issued" ||
                event.action === "machine_token.revoked") && (
                <MetadataItem label="Token ID" value={detail.id} monospace />
              )}
            {principalId && (
              <MetadataItem
                label="Service principal"
                value={
                  <GovernanceResourceLink
                    {...linkProps}
                    source={{ kind: "principal", id: principalId }}
                  >
                    {data.principalList.entries.find(({ id }) => id === principalId)?.name ??
                      principalId}
                  </GovernanceResourceLink>
                }
              />
            )}
            {grantId && (
              <MetadataItem
                label="Execution grant"
                value={
                  <GovernanceResourceLink {...linkProps} source={{ kind: "grant", id: grantId }}>
                    Grant {grantId.slice(0, 8)}
                  </GovernanceResourceLink>
                }
              />
            )}
            {agentId && (
              <MetadataItem
                label="Agent"
                value={
                  <Link
                    className="font-medium underline underline-offset-4"
                    href={workspaceAgentDetailPath(workspaceSlug, agentId, { factory: factory.id })}
                  >
                    Agent {agentId.slice(0, 8)}
                  </Link>
                }
              />
            )}
            {detail?.revisionId && (
              <MetadataItem
                label="Recorded tool revision"
                monospace
                value={<span className="[overflow-wrap:anywhere]">{detail.revisionId}</span>}
              />
            )}
            {detail?.budget_payer_member_id && (
              <MetadataItem
                label="Recorded budget payer"
                value={
                  <GovernanceResourceLink
                    {...linkProps}
                    source={{ kind: "actor", id: detail.budget_payer_member_id }}
                  >
                    {data.memberOptions.find(({ id }) => id === detail.budget_payer_member_id)
                      ?.label ?? detail.budget_payer_member_id}
                  </GovernanceResourceLink>
                }
              />
            )}
            {detail?.github_repository_id && (
              <MetadataItem
                label="Recorded writable repository"
                value={
                  <span className="[overflow-wrap:anywhere]">{detail.github_repository_id}</span>
                }
                monospace
              />
            )}
            {detail?.read_context_repository_ids?.length ? (
              <MetadataItem
                label="Recorded read-only repositories"
                value={
                  <span className="[overflow-wrap:anywhere]">
                    {detail.read_context_repository_ids.join(", ")}
                  </span>
                }
                monospace
              />
            ) : null}
            {detail?.tool_ids?.length ? (
              <MetadataItem
                label="Recorded tool operations"
                value={
                  <span className="[overflow-wrap:anywhere]">{detail.tool_ids.join(", ")}</span>
                }
                monospace
              />
            ) : null}
            {detail?.execution_policy_revision_id && (
              <MetadataItem
                label="Recorded policy revision"
                value={
                  <span className="[overflow-wrap:anywhere]">
                    {detail.execution_policy_revision_id}
                  </span>
                }
                monospace
              />
            )}
            {detail?.expires_at && (
              <MetadataItem
                label="Recorded expiry"
                value={<GovernanceTime value={detail.expires_at} />}
              />
            )}
          </>
        )}
      </MetadataList>
    </article>
  );
}

export function GovernanceAudit({
  cursor,
  data,
  scope,
  source,
}: {
  cursor?: string;
  data: GovernanceData;
  scope: GovernanceScope;
  source?: FactoryAuditSource;
}) {
  const { events, nextCursor } = data.audit;
  const focused = source?.kind === "event";
  const query = { factory: scope.factory.id, ...governanceSourceQuery(source) };
  return (
    <PageSection anchorId="governance-audit" title={focused ? "Audit event" : "Governance audit"}>
      {events.length > 0 ? (
        <ul
          aria-label={focused ? "Selected audit event" : "Audit events"}
          className="ui-sheet divide-y divide-border"
        >
          {events.map((event) => (
            <li key={event.id}>
              <AuditEventCard data={data} event={event} focused={focused} scope={scope} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-secondary text-muted">
          {focused
            ? "This audit event is unavailable."
            : "No governance operations are recorded for this selection."}
        </p>
      )}
      {cursor || nextCursor ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {cursor && (
            <Link
              className="ui-button"
              href={`${workspaceGovernancePath(scope.workspaceSlug, query)}#governance-audit`}
            >
              Latest audit events
            </Link>
          )}
          {nextCursor && (
            <Link
              className="ui-button"
              href={`${workspaceGovernancePath(scope.workspaceSlug, { ...query, beforeAudit: nextCursor })}#governance-audit`}
            >
              Older audit events
            </Link>
          )}
        </div>
      ) : null}
    </PageSection>
  );
}

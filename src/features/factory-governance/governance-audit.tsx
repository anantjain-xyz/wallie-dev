import Link from "next/link";
import { z } from "zod";

import { MetadataItem, MetadataList, PageSection } from "@/components/ui/page-shell";
import { auditDetailSchema } from "./governance-audit-detail";
import { CopyGovernanceId } from "./governance-fields";
import { grantName, principalName, repositoryName, toolName } from "./governance-names";
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
import { factoryCommandLabels } from "@/lib/factory-machine-tokens/contracts";
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

const oauthRevocationReasonSchema = z.enum(["disconnected", "refresh_reuse", "client_revoked"]);
const oauthRevocationReasons = {
  disconnected: "Disconnected by a member",
  refresh_reuse: "Refresh credential reused",
  client_revoked: "Client registration revoked",
};
function historicalName(name: string | undefined, kind: string) {
  return name ? `${name} (current name)` : `Unresolved historical ${kind}`;
}

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
  const grantId =
    detail?.executionGrantId ??
    detail?.grantId ??
    (resource?.kind === "grant" ? resource.id : undefined);
  const agentId = detail?.factoryAgentId ?? detail?.agentId;
  const grant = data.evidence.grants.find(({ id }) => id === grantId);
  const agent = data.evidence.agents.find(({ id }) => id === agentId)?.name;
  const client = data.evidence.clients.find(({ id }) => id === detail?.clientId)?.name;
  const grantLabel =
    detail?.service_principal_id && detail.github_repository_id
      ? `${historicalName(principalName(data, detail.service_principal_id), "service principal")} · ${historicalName(repositoryName(data, detail.github_repository_id), "repository")}`
      : grant
        ? `${grantName(data, grant)} (current grant)`
        : "Unresolved historical execution grant";
  const resourceLabel =
    resource?.kind === "principal"
      ? (detail?.name ?? historicalName(principalName(data, resource.id), "service principal"))
      : resource?.kind === "grant"
        ? grantLabel
        : resource?.kind === "binding"
          ? [historicalName(agent, "agent"), detail?.agentProvider ?? "Credential binding"].join(
              " · ",
            )
          : resource?.kind === "mcp-binding"
            ? detail?.revisionId
              ? historicalName(toolName(data, detail.revisionId), "MCP revision")
              : "Unresolved historical MCP credential binding"
            : detail?.clientId
              ? historicalName(client, "OAuth client")
              : "Resource unavailable";
  const scopes = detail?.command_scopes ?? detail?.scopes;
  const policy = data.evidence.policies.find(
    ({ id }) => id === detail?.execution_policy_revision_id,
  );
  const technical = [
    ["Event ID", event.id],
    ["Actor ID", event.actor_member_id],
    ["Resource ID", resource?.id],
    ["Service principal ID", principalId],
    ["Execution grant ID", grantId],
    ["Agent ID", agentId],
    ["OAuth client ID", detail?.clientId],
    ["OAuth connection ID", detail?.oauthGrantId],
    ["Tool revision ID", detail?.revisionId],
    ["Budget payer ID", detail?.budget_payer_member_id],
    ["Writable repository ID", detail?.github_repository_id],
    ["Policy revision ID", detail?.execution_policy_revision_id],
    ...(detail?.read_context_repository_ids ?? []).map((id) => ["Read-only repository ID", id]),
    ...(detail?.tool_ids ?? []).map((id) => ["Tool operation ID", id]),
  ];
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
                {actor?.label ?? "Unresolved historical workspace member"}
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
                {resourceLabel}
              </GovernanceResourceLink>
            ) : (
              resourceLabel
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
            {scopes && (
              <MetadataItem
                label="Recorded command scopes"
                value={scopes.map((scope) => factoryCommandLabels[scope]).join(", ") || "None"}
              />
            )}
            {detail?.id &&
              (event.action === "machine_token.issued" ||
                event.action === "machine_token.revoked") && (
                <MetadataItem
                  label="Token ID"
                  value={<CopyGovernanceId label="Token ID" value={detail.id} />}
                />
              )}
            {principalId && (
              <MetadataItem
                label="Service principal"
                value={
                  <GovernanceResourceLink
                    {...linkProps}
                    source={{ kind: "principal", id: principalId }}
                  >
                    {historicalName(principalName(data, principalId), "service principal")}
                  </GovernanceResourceLink>
                }
              />
            )}
            {grantId && (
              <MetadataItem
                label="Execution grant"
                value={
                  <GovernanceResourceLink {...linkProps} source={{ kind: "grant", id: grantId }}>
                    {grantLabel}
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
                    {historicalName(agent, "agent")}
                  </Link>
                }
              />
            )}
            {detail?.revisionId && (
              <MetadataItem
                label="Recorded tool revision"
                value={historicalName(toolName(data, detail.revisionId), "tool revision")}
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
                    {historicalName(
                      data.memberOptions.find(({ id }) => id === detail.budget_payer_member_id)
                        ?.label,
                      "budget payer",
                    )}
                  </GovernanceResourceLink>
                }
              />
            )}
            {detail?.github_repository_id && (
              <MetadataItem
                label="Recorded writable repository"
                value={historicalName(
                  repositoryName(data, detail.github_repository_id),
                  "repository",
                )}
              />
            )}
            {detail?.read_context_repository_ids?.length ? (
              <MetadataItem
                label="Recorded read-only repositories"
                value={detail.read_context_repository_ids
                  .map((id) => historicalName(repositoryName(data, id), "repository"))
                  .join(", ")}
              />
            ) : null}
            {detail?.tool_ids?.length ? (
              <MetadataItem
                label="Recorded tool operations"
                value={detail.tool_ids
                  .map((id) => historicalName(toolName(data, id), "tool operation"))
                  .join(", ")}
              />
            ) : null}
            {detail?.execution_policy_revision_id && (
              <MetadataItem
                label="Recorded policy revision"
                value={
                  policy ? `Revision ${policy.revision}` : "Unresolved historical policy revision"
                }
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
      {focused && (
        <details>
          <summary className="cursor-pointer type-label text-muted">Recorded identifiers</summary>
          <MetadataList className="mt-2">
            {technical.map(([label, id]) =>
              label && id ? (
                <MetadataItem
                  key={`${label}:${id}`}
                  label={label}
                  value={<CopyGovernanceId label={label} value={id} />}
                />
              ) : null,
            )}
          </MetadataList>
        </details>
      )}
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

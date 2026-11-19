import Link from "next/link";

import { MetadataItem, MetadataList } from "@/components/ui/page-shell";
import { RevokeGrant } from "@/features/factory-governance/governance-actions";
import type {
  GovernanceData,
  GovernanceScope,
} from "@/features/factory-governance/governance-data";
import {
  GovernanceResourceLink,
  GovernanceTime,
} from "@/features/factory-governance/governance-resource-link";
import { workspaceAgentDetailPath, workspaceFactoryDefinitionPath } from "@/lib/routes";

type ScopeProps = { scope: GovernanceScope; data: GovernanceData };

function actorLabel(data: GovernanceData, memberId: string | null) {
  return data.memberOptions.find(({ id }) => id === memberId)?.label ?? memberId ?? "Unavailable";
}

function principalLabel(data: GovernanceData, principalId: string) {
  return data.principalList.entries.find(({ id }) => id === principalId)?.name ?? principalId;
}

function MemberLink({ scope, data, id }: ScopeProps & { id: string }) {
  return (
    <GovernanceResourceLink
      factoryId={scope.factory.id}
      source={{ kind: "actor", id }}
      workspaceSlug={scope.workspaceSlug}
    >
      {actorLabel(data, id)}
    </GovernanceResourceLink>
  );
}

function PrincipalLink({ scope, data, id }: ScopeProps & { id: string }) {
  return (
    <GovernanceResourceLink
      factoryId={scope.factory.id}
      source={{ kind: "principal", id }}
      workspaceSlug={scope.workspaceSlug}
    >
      {principalLabel(data, id)}
    </GovernanceResourceLink>
  );
}

export function PrincipalCard({
  scope,
  data,
  principal,
  focused,
}: ScopeProps & {
  principal: GovernanceData["principalList"]["entries"][number];
  focused?: boolean;
}) {
  return (
    <article className="min-w-0 space-y-3 p-4 sm:p-5">
      <h3 className="font-semibold text-foreground [overflow-wrap:anywhere]">
        {focused ? principal.name : <PrincipalLink scope={scope} data={data} id={principal.id} />}
      </h3>
      <MetadataList>
        <MetadataItem label="Identifier" value={principal.slug} monospace />
        <MetadataItem
          label="Created by"
          value={<MemberLink scope={scope} data={data} id={principal.created_by_member_id} />}
        />
        <MetadataItem label="Created" value={<GovernanceTime value={principal.created_at} />} />
        {focused && (
          <MetadataItem
            label="Principal ID"
            monospace
            value={<span className="[overflow-wrap:anywhere]">{principal.id}</span>}
          />
        )}
      </MetadataList>
    </article>
  );
}

export function GrantCard({
  scope,
  data,
  grant,
  focused,
}: ScopeProps & {
  grant: GovernanceData["grantList"]["entries"][number];
  focused?: boolean;
}) {
  const revoked = Boolean(grant.revoked_at);
  const expired = Date.parse(grant.expires_at) <= data.asOf;
  const status = revoked ? "Revoked" : expired ? "Expired" : "Approved";
  const authority = data.authority?.grantId === grant.id ? data.authority : null;
  const blocked = authority && (revoked || expired || authority.grantVersion !== grant.version);
  const repository = (id: string) =>
    data.repositoryOptions.find((row) => row.id === id)?.label ?? id;
  const policy =
    data.policyOptions.find(({ id }) => id === grant.execution_policy_revision_id)?.label ??
    grant.execution_policy_revision_id;
  const toolName = (id: string) => data.toolOptions.find((row) => row.id === id)?.label ?? id;
  const grantName = `Grant ${grant.id.slice(0, 8)}`;
  const shortDetails = !focused;

  return (
    <article className="min-w-0 space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-foreground">
          {focused ? (
            grantName
          ) : (
            <GovernanceResourceLink
              factoryId={scope.factory.id}
              source={{ kind: "grant", id: grant.id }}
              workspaceSlug={scope.workspaceSlug}
            >
              {grantName}
            </GovernanceResourceLink>
          )}
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          <span className={revoked ? "type-label text-danger" : "type-label text-muted"}>
            {status}
          </span>
          {!revoked && (
            <RevokeGrant
              grantId={grant.id}
              scope={{
                factoryId: scope.factory.id,
                workspaceId: scope.workspaceId,
                workspaceSlug: scope.workspaceSlug,
              }}
              version={grant.version}
            />
          )}
        </div>
      </div>
      <MetadataList>
        <MetadataItem
          label="Service principal"
          value={<PrincipalLink scope={scope} data={data} id={grant.service_principal_id} />}
        />
        <MetadataItem label="Grant version" value={grant.version} />
        <MetadataItem
          label="Writable repository"
          value={
            <span className="[overflow-wrap:anywhere]">
              {repository(grant.github_repository_id)}
            </span>
          }
        />
        <MetadataItem label="Expires at" value={<GovernanceTime value={grant.expires_at} />} />
        {!shortDetails && (
          <>
            <MetadataItem
              label="Grant ID"
              monospace
              value={<span className="[overflow-wrap:anywhere]">{grant.id}</span>}
            />
            <MetadataItem
              label="Budget payer"
              value={<MemberLink scope={scope} data={data} id={grant.budget_payer_member_id} />}
            />
            <MetadataItem
              label="Approved by"
              value={<MemberLink scope={scope} data={data} id={grant.approved_by_member_id} />}
            />
            <MetadataItem
              label="Approved at"
              value={<GovernanceTime value={grant.approved_at} />}
            />
            <MetadataItem
              label="Execution policy"
              value={<span className="[overflow-wrap:anywhere]">{policy}</span>}
            />
            <MetadataItem
              label="Read-only repositories"
              value={
                <span className="[overflow-wrap:anywhere]">
                  {grant.read_context_repository_ids.map(repository).join(", ") || "None"}
                </span>
              }
            />
            <MetadataItem
              label="Tool operations"
              value={
                <span className="[overflow-wrap:anywhere]">
                  {grant.tool_ids.map(toolName).join(", ") || "None"}
                </span>
              }
            />
          </>
        )}
        {grant.revoked_by_member_id && (
          <MetadataItem
            label="Revoked by"
            value={<MemberLink scope={scope} data={data} id={grant.revoked_by_member_id} />}
          />
        )}
        {grant.revoked_at && (
          <MetadataItem label="Revoked at" value={<GovernanceTime value={grant.revoked_at} />} />
        )}
        {grant.revocation_reason && (
          <MetadataItem
            label="Revocation reason"
            value={<span className="[overflow-wrap:anywhere]">{grant.revocation_reason}</span>}
          />
        )}
      </MetadataList>
      {authority && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="type-secondary text-muted">
            {blocked
              ? `New admission is blocked for the published definition using grant v${authority.grantVersion}.`
              : `The published definition uses grant v${authority.grantVersion}.`}
          </p>
          {scope.isOperator && (
            <Link
              className="ui-button"
              href={`${workspaceFactoryDefinitionPath(scope.workspaceSlug, {
                factory: scope.factory.id,
                revision: authority.definitionRevisionId,
              })}#execution-profile`}
            >
              Review admission readiness
            </Link>
          )}
        </div>
      )}
    </article>
  );
}

function credentialStatusLabel(status: string) {
  switch (status) {
    case "ready":
      return "Ready";
    case "revoked":
      return "Revoked";
    case "grant_unavailable":
      return "Grant unavailable";
    case "missing":
      return "Saved secret unavailable";
    default:
      return "Unavailable";
  }
}

export function CredentialCard({
  scope,
  data,
  credential,
  focused,
}: ScopeProps & {
  credential: GovernanceData["bindings"][number];
  focused?: boolean;
}) {
  const credentialLabel = `Binding ${credential.id.slice(0, 8)}`;
  const published =
    data.authority && data.authority.bindingId === credential.id ? data.authority : null;
  return (
    <article className="min-w-0 space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-foreground">
          {focused ? (
            credentialLabel
          ) : (
            <GovernanceResourceLink
              factoryId={scope.factory.id}
              source={{ kind: "binding", id: credential.id }}
              workspaceSlug={scope.workspaceSlug}
            >
              {credentialLabel}
            </GovernanceResourceLink>
          )}
        </h3>
        <span className="type-label text-muted">{credentialStatusLabel(credential.status)}</span>
      </div>
      <MetadataList>
        <MetadataItem
          label="Owned by"
          value={<PrincipalLink scope={scope} data={data} id={credential.principalId} />}
        />
        <MetadataItem
          label="Execution grant"
          value={
            <GovernanceResourceLink
              factoryId={scope.factory.id}
              source={{ kind: "grant", id: credential.grantId }}
              workspaceSlug={scope.workspaceSlug}
            >
              Grant {credential.grantId.slice(0, 8)}
            </GovernanceResourceLink>
          }
        />
        <MetadataItem
          label="Agent"
          value={
            <Link
              className="font-medium underline underline-offset-4"
              href={workspaceAgentDetailPath(scope.workspaceSlug, credential.agentId, {
                factory: scope.factory.id,
              })}
            >
              Agent {credential.agentId.slice(0, 8)}
            </Link>
          }
        />
        <MetadataItem
          label="Harness"
          value={
            credential.openCodeProviderId
              ? `${credential.provider} · ${credential.openCodeProviderId}`
              : credential.provider
          }
        />
        <MetadataItem label="Binding version" value={credential.version} />
        {focused && (
          <MetadataItem
            label="Attached at"
            value={<GovernanceTime value={credential.createdAt} />}
          />
        )}
        {credential.materialRevision != null && (
          <MetadataItem label="Material revision" value={credential.materialRevision} />
        )}
        {credential.rotatedAt && (
          <MetadataItem
            label="Material updated"
            value={<GovernanceTime value={credential.rotatedAt} />}
          />
        )}
        {credential.revokedAt && (
          <MetadataItem
            label="Revoked at"
            value={<GovernanceTime value={credential.revokedAt} />}
          />
        )}
        {focused && (
          <MetadataItem
            label="Binding ID"
            monospace
            value={<span className="[overflow-wrap:anywhere]">{credential.id}</span>}
          />
        )}
      </MetadataList>
      {published && scope.isOperator && (
        <Link
          className="ui-button"
          href={`${workspaceFactoryDefinitionPath(scope.workspaceSlug, {
            factory: scope.factory.id,
            revision: published.definitionRevisionId,
          })}#service-credentials`}
        >
          Open published credential settings
        </Link>
      )}
    </article>
  );
}

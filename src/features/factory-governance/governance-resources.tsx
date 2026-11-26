import Link from "next/link";

import { MetadataItem, MetadataList } from "@/components/ui/page-shell";
import { RevokeGrant } from "@/features/factory-governance/governance-actions";
import { governancePolicy } from "./governance-evidence-data";
import { CopyGovernanceId } from "./governance-fields";
import { GrantScopeSummary } from "./governance-grant-summary";
import { grantName, principalName, repositoryName, toolName } from "./governance-names";
import type {
  GovernanceData,
  GovernanceScope,
} from "@/features/factory-governance/governance-data";
import {
  GovernanceResourceLink,
  GovernanceTime,
} from "@/features/factory-governance/governance-resource-link";
import { factoryCommandLabels } from "@/lib/factory-machine-tokens/contracts";
import {
  workspaceAgentDetailPath,
  workspaceFactoryDefinitionPath,
  workspaceGovernancePath,
} from "@/lib/routes";

type ScopeProps = { scope: GovernanceScope; data: GovernanceData };

function actorLabel(data: GovernanceData, memberId: string | null) {
  return (
    data.memberOptions.find(({ id }) => id === memberId)?.label ??
    "Former workspace member or unavailable"
  );
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
      {principalName(data, id) ?? "Service principal unavailable"}
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
            value={<CopyGovernanceId label="Principal ID" value={principal.id} />}
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
  eventDependencies = [],
}: ScopeProps & {
  grant: GovernanceData["grantList"]["entries"][number];
  focused?: boolean;
  eventDependencies?: string[];
}) {
  const revoked = Boolean(grant.revoked_at);
  const expired = Date.parse(grant.expires_at) <= data.asOf;
  const status = revoked ? "Revoked" : expired ? "Expired" : "Approved";
  const authority = data.authority?.grantId === grant.id ? data.authority : null;
  const blocked = authority && (revoked || expired || authority.grantVersion !== grant.version);
  const repository = (id: string) => repositoryName(data, id) ?? "Repository unavailable";
  const policy = data.evidence.policies.find(({ id }) => id === grant.execution_policy_revision_id);
  const title = grantName(data, grant);
  const principal = <PrincipalLink scope={scope} data={data} id={grant.service_principal_id} />;
  const ids = [
    ["Grant ID", grant.id],
    ["Service principal ID", grant.service_principal_id],
    ["Writable repository ID", grant.github_repository_id],
    ["Execution policy revision ID", grant.execution_policy_revision_id],
    ["Budget payer ID", grant.budget_payer_member_id],
    ...grant.read_context_repository_ids.map((id) => ["Read-only repository ID", id]),
    ...grant.tool_ids.map((id) => ["Tool operation ID", id]),
  ];

  return (
    <article className="min-w-0 space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-foreground [overflow-wrap:anywhere]">
          {focused ? (
            title
          ) : (
            <GovernanceResourceLink
              factoryId={scope.factory.id}
              source={{ kind: "grant", id: grant.id }}
              workspaceSlug={scope.workspaceSlug}
            >
              {title}
            </GovernanceResourceLink>
          )}
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          <span className={revoked ? "type-label text-danger" : "type-label text-muted"}>
            {status}
          </span>
          {!revoked && (
            <RevokeGrant
              key={grant.version}
              dependencies={[
                ...new Set([...(data.evidence.dependencies[grant.id] ?? []), ...eventDependencies]),
              ]}
              grantId={grant.id}
              pinned={authority?.grantVersion === grant.version}
              scope={{
                factoryId: scope.factory.id,
                workspaceId: scope.workspaceId,
                workspaceSlug: scope.workspaceSlug,
              }}
              target={title}
              version={grant.version}
            />
          )}
        </div>
      </div>
      <MetadataList>
        <MetadataItem label="Grant version" value={grant.version} />
        {!focused && (
          <MetadataItem label="Expires at" value={<GovernanceTime value={grant.expires_at} />} />
        )}
        {focused && (
          <>
            <MetadataItem
              label="Approved by"
              value={<MemberLink scope={scope} data={data} id={grant.approved_by_member_id} />}
            />
            <MetadataItem
              label="Approved at"
              value={<GovernanceTime value={grant.approved_at} />}
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
      {focused && (
        <>
          <GrantScopeSummary
            commands={grant.command_scopes.map((command) => factoryCommandLabels[command])}
            expires={<GovernanceTime value={grant.expires_at} />}
            payer={<MemberLink scope={scope} data={data} id={grant.budget_payer_member_id} />}
            policy={policy && governancePolicy(policy)}
            principal={principal}
            readOnly={grant.read_context_repository_ids.map(repository)}
            tools={grant.tool_ids.map((id) => toolName(data, id) ?? "Tool operation unavailable")}
            writable={repository(grant.github_repository_id)}
          />
          <details>
            <summary className="cursor-pointer type-label text-muted">Technical details</summary>
            <MetadataList className="mt-2">
              {ids.map(([label, id]) => (
                <MetadataItem
                  key={`${label}:${id}`}
                  label={label}
                  value={<CopyGovernanceId label={label} value={id} />}
                />
              ))}
            </MetadataList>
          </details>
        </>
      )}
      {revoked && (data.canApprove || blocked) && (
        <div className="space-y-2">
          <p className="type-secondary text-muted">
            {blocked
              ? scope.isOperator
                ? "Approve a replacement, then publish an updated definition pinned to it before resuming admission."
                : "Approve a replacement, then ask a workspace owner or admin to publish an updated definition pinned to it."
              : "If this grant is still needed, approve a replacement before reconnecting its integrations."}
          </p>
          {data.canApprove && (
            <Link
              className="ui-button"
              href={`${workspaceGovernancePath(scope.workspaceSlug, {
                factory: scope.factory.id,
                principal: principalName(data, grant.service_principal_id)
                  ? grant.service_principal_id
                  : undefined,
              })}#approve-grant`}
            >
              Approve a replacement grant
            </Link>
          )}
        </div>
      )}
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
  const agent =
    data.evidence.agents.find(({ id }) => id === credential.agentId)?.name ?? "Agent unavailable";
  const grant = data.evidence.grants.find(({ id }) => id === credential.grantId);
  const credentialLabel = `${agent} · ${credential.provider}`;
  const published =
    data.authority && data.authority.bindingId === credential.id ? data.authority : null;
  return (
    <article className="min-w-0 space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-foreground [overflow-wrap:anywhere]">
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
              {grant ? grantName(data, grant) : "Execution grant unavailable"}
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
              {agent}
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
            value={<CopyGovernanceId label="Binding ID" value={credential.id} />}
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

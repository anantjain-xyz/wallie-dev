import type { ReactNode } from "react";
import Link from "next/link";
import { z } from "zod";

import {
  MetadataItem,
  MetadataList,
  PageContainer,
  PageHeader,
  PageSection,
} from "@/components/ui/page-shell";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { FactorySelector } from "@/features/factories/factory-selector";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import {
  ApproveGrant,
  CreateServicePrincipal,
} from "@/features/factory-governance/governance-actions";
import { GrantMachineTokens } from "@/features/factory-governance/governance-machine-tokens";
import { GovernanceEventSubscriptions } from "@/features/factory-governance/governance-event-subscriptions";
import { GovernanceAudit } from "@/features/factory-governance/governance-audit";
import {
  loadGovernance,
  loadGovernanceScope,
  type GovernanceData,
  type GovernanceScope,
} from "@/features/factory-governance/governance-data";
import {
  GovernanceResourcePages,
  governanceSourceQuery,
} from "@/features/factory-governance/governance-resource-link";
import {
  CredentialCard,
  GrantCard,
  PrincipalCard,
} from "@/features/factory-governance/governance-resources";
import { CopyGovernanceId } from "@/features/factory-governance/governance-fields";
import { loadGovernanceSubscriptions } from "@/features/factory-governance/governance-subscriptions-data";
import { FactoryAuditCursorError } from "@/lib/factories/audit";
import {
  factoryAuditCursorTokenSchema,
  factoryAuditSourceSchema,
  type FactoryAuditSource,
} from "@/lib/factories/audit-contracts";
import { workspaceGovernancePath, workspaceSettingsPath } from "@/lib/routes";

const sourceKinds = {
  actor: "actor",
  binding: "binding",
  event: "event",
  grant: "grant",
  mcpBinding: "mcp-binding",
  principal: "principal",
} satisfies Record<string, FactoryAuditSource["kind"]>;

const filters = z.object({
  afterBinding: z.string().uuid().optional(),
  afterGrant: z.string().uuid().optional(),
  afterPrincipal: z.string().uuid().optional(),
  afterToken: z.string().uuid().optional(),
  beforeAudit: factoryAuditCursorTokenSchema.optional(),
  afterOAuthClient: z.string().uuid().optional(),
  afterOAuthGrant: z.string().uuid().optional(),
});

type Filters = z.output<typeof filters>;
type Query = Partial<
  Record<keyof typeof sourceKinds | keyof Filters | "factory", string | string[]>
>;

const GOVERNANCE_FACTORY_RESET_PARAMS = [
  "principal",
  "grant",
  "binding",
  "mcpBinding",
  "event",
  "actor",
  "afterGrant",
  "afterPrincipal",
  "afterBinding",
  "afterToken",
  "beforeAudit",
  "afterOAuthClient",
  "afterOAuthGrant",
] as const;

function Unavailable({ actions, href, text }: { actions?: ReactNode; href: string; text: string }) {
  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader actions={actions} actionsRightOnDesktop title="Governance" />
      <div className="ui-sheet space-y-3 p-4 sm:p-5">
        <p className="type-secondary text-muted">{text}</p>
        <Link className="ui-button" href={href}>
          Back to governance
        </Link>
      </div>
    </PageContainer>
  );
}

function GovernanceResources({
  data,
  filters: query,
  scope,
  source,
  subscriptions,
}: {
  data: GovernanceData;
  filters: Filters;
  scope: GovernanceScope;
  source?: FactoryAuditSource;
  subscriptions: Awaited<ReturnType<typeof loadGovernanceSubscriptions>> | null;
}) {
  const { factory, workspaceSlug } = scope;
  const { bindings, canApprove, grantList, memberOptions, nextBinding, principalList } = data;
  const actionScope = { factoryId: factory.id, workspaceId: scope.workspaceId, workspaceSlug };
  const selectedBinding = bindings.find(({ id }) => id === data.selectedBindingId);
  const selectedActor =
    source?.kind === "actor" ? memberOptions.find(({ id }) => id === source.id) : null;
  const grantDependencies = (grant: NonNullable<typeof grantList.selected>) =>
    subscriptions?.subscriptions
      .filter(
        (subscription) =>
          subscription.authorized &&
          subscription.status !== "revoked" &&
          subscription.grantId === grant.id &&
          subscription.grantVersion === grant.version,
      )
      .map(({ name }) => `Event subscription: ${name}`);
  const filterHref = (key: "afterBinding" | "afterGrant" | "afterPrincipal", value?: string) =>
    workspaceGovernancePath(workspaceSlug, { factory: factory.id, ...query, [key]: value });
  const approve = (
    <ApproveGrant
      key={principalList.selected?.id ?? factory.id}
      isOperator={scope.isOperator}
      members={memberOptions
        .filter(({ active }) => active)
        .map(({ id, choiceLabel }) => ({ id, label: choiceLabel }))}
      policies={data.policyOptions}
      principals={data.principalOptions}
      repositories={data.repositoryOptions}
      scope={actionScope}
      selectedPrincipal={principalList.selected?.id}
      tools={data.toolOptions}
    />
  );

  if (source) {
    switch (source.kind) {
      case "principal":
        return (
          <>
            <PageSection title="Service principal">
              {principalList.selected ? (
                <div className="ui-sheet">
                  <PrincipalCard
                    data={data}
                    focused
                    principal={principalList.selected}
                    scope={scope}
                  />
                </div>
              ) : (
                <p className="type-secondary text-muted">This service principal is unavailable.</p>
              )}
            </PageSection>
            {principalList.selected && canApprove && (
              <PageSection anchorId="approve-grant" title="Approve an execution grant">
                {approve}
              </PageSection>
            )}
          </>
        );
      case "grant":
        return (
          <>
            <PageSection title="Execution grant">
              {grantList.selected ? (
                <div className="ui-sheet">
                  <GrantCard
                    data={data}
                    eventDependencies={grantDependencies(grantList.selected)}
                    focused
                    grant={grantList.selected}
                    scope={scope}
                  />
                </div>
              ) : (
                <p className="type-secondary text-muted">This execution grant is unavailable.</p>
              )}
            </PageSection>
            {grantList.selected && (
              <PageSection anchorId="machine-tokens" title="Machine tokens">
                <GrantMachineTokens
                  key={`${source.id}:${grantList.selected.version}:${query.afterToken ?? ""}`}
                  asOf={data.asOf}
                  factoryActive={canApprove}
                  factoryId={factory.id}
                  grant={{
                    id: grantList.selected.id,
                    version: grantList.selected.version,
                    command_scopes: grantList.selected.command_scopes,
                    expires_at: grantList.selected.expires_at,
                    revoked_at: grantList.selected.revoked_at,
                  }}
                  tokens={data.tokenList.entries}
                  workspaceId={scope.workspaceId}
                />
                <GovernanceResourcePages
                  href={`${workspaceGovernancePath(workspaceSlug, {
                    factory: factory.id,
                    grant: source.id,
                  })}#machine-tokens`}
                  next={
                    data.tokenList.next &&
                    `${workspaceGovernancePath(workspaceSlug, {
                      factory: factory.id,
                      grant: source.id,
                      afterToken: data.tokenList.next,
                    })}#machine-tokens`
                  }
                  previous={Boolean(query.afterToken)}
                />
              </PageSection>
            )}
          </>
        );
      case "binding":
        return (
          <PageSection anchorId="credential-ownership" title="Credential ownership">
            {selectedBinding ? (
              <div className="ui-sheet">
                <CredentialCard credential={selectedBinding} data={data} focused scope={scope} />
              </div>
            ) : (
              <p className="type-secondary text-muted">This credential binding is unavailable.</p>
            )}
          </PageSection>
        );
      case "actor":
        return (
          <PageSection title="Audit actor">
            <div className="ui-sheet p-4 sm:p-5">
              <MetadataList>
                <MetadataItem
                  label="Workspace member"
                  value={selectedActor?.label ?? "Former workspace member or unavailable"}
                />
                <MetadataItem
                  label="Member ID"
                  monospace
                  value={<CopyGovernanceId label="Member ID" value={source.id} />}
                />
              </MetadataList>
            </div>
          </PageSection>
        );
      case "mcp-binding": {
        const binding = data.evidence.mcpBindings.find(({ id }) => id === source.id);
        const revision = data.evidence.toolRevisions.find(
          ({ id }) => id === binding?.tool_revision_id,
        );
        const agent = data.evidence.agents.find(({ id }) => id === binding?.factory_agent_id);
        return (
          <PageSection title="MCP credential binding">
            <div className="ui-sheet p-4 sm:p-5">
              {binding || data.audit.events.length || query.beforeAudit ? (
                <MetadataList>
                  <MetadataItem
                    label="Agent"
                    value={agent?.name ?? "Historical agent unavailable"}
                  />
                  <MetadataItem
                    label="MCP server revision"
                    value={
                      revision
                        ? `${revision.factory_mcp_servers.name} · v${revision.revision_number}`
                        : "Historical tool revision unavailable"
                    }
                  />
                  {revision && (
                    <MetadataItem
                      label="Operations in this revision"
                      value={revision.operation_names.join(", ") || "None"}
                    />
                  )}
                  <MetadataItem
                    label="Binding ID"
                    monospace
                    value={<CopyGovernanceId label="Binding ID" value={source.id} />}
                  />
                </MetadataList>
              ) : (
                <p className="type-secondary text-muted">
                  This MCP credential binding is unavailable.
                </p>
              )}
            </div>
          </PageSection>
        );
      }
      case "event":
        return null;
    }
  }

  return (
    <>
      <PageSection anchorId="service-principals" title="Service principals">
        {principalList.entries.length ? (
          <div className="ui-sheet divide-y divide-border">
            {principalList.entries.map((principal) => (
              <PrincipalCard data={data} key={principal.id} principal={principal} scope={scope} />
            ))}
          </div>
        ) : (
          <p className="type-secondary text-muted">No service principals on this page.</p>
        )}
        <GovernanceResourcePages
          href={`${filterHref("afterPrincipal")}#service-principals`}
          next={
            principalList.next &&
            `${filterHref("afterPrincipal", principalList.next)}#service-principals`
          }
          previous={Boolean(query.afterPrincipal)}
        />
        {canApprove && (
          <div className="mt-4">
            <CreateServicePrincipal key={factory.id} scope={actionScope} />
          </div>
        )}
      </PageSection>
      <PageSection anchorId="execution-grants" title="Execution grants">
        {grantList.entries.length ? (
          <div className="ui-sheet divide-y divide-border">
            {grantList.entries.map((grant) => (
              <GrantCard
                data={data}
                eventDependencies={grantDependencies(grant)}
                grant={grant}
                key={grant.id}
                scope={scope}
              />
            ))}
          </div>
        ) : (
          <p className="type-secondary text-muted">No execution grants on this page.</p>
        )}
        <GovernanceResourcePages
          href={`${filterHref("afterGrant")}#execution-grants`}
          next={grantList.next && `${filterHref("afterGrant", grantList.next)}#execution-grants`}
          previous={Boolean(query.afterGrant)}
        />
        {canApprove && (
          <div className="mt-4" id="approve-grant">
            {approve}
          </div>
        )}
      </PageSection>
      <PageSection anchorId="credential-ownership" title="Credential ownership">
        {bindings.length ? (
          <div className="ui-sheet divide-y divide-border">
            {bindings.map((credential) => (
              <CredentialCard
                credential={credential}
                data={data}
                key={credential.id}
                scope={scope}
              />
            ))}
          </div>
        ) : (
          <p className="type-secondary text-muted">No service credential bindings on this page.</p>
        )}
        <GovernanceResourcePages
          href={`${filterHref("afterBinding")}#credential-ownership`}
          next={nextBinding && `${filterHref("afterBinding", nextBinding)}#credential-ownership`}
          previous={Boolean(query.afterBinding)}
        />
      </PageSection>
    </>
  );
}

export default async function GovernancePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Query>;
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const [scope, factories] = await Promise.all([
    loadGovernanceScope(workspaceSlug, query.factory),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const managedFactories = factories.filter(({ canManage }) => canManage);
  if (!scope && managedFactories.length === 0) {
    return (
      <PageContainer className="pt-5 sm:pt-10">
        <PageHeader title="Governance" />
        <div className="ui-sheet space-y-3 p-4 sm:p-5">
          <h2 className="font-semibold text-foreground">Factory manager access required</h2>
          <p className="type-secondary text-muted">
            You can still review or disconnect your own clients in Personal settings.
          </p>
          <Link
            className="ui-button"
            href={`${workspaceSettingsPath(workspaceSlug, { category: "personal" })}#connected-clients`}
          >
            Manage your connected clients
          </Link>
        </div>
      </PageContainer>
    );
  }
  if (!scope)
    return (
      <FactoryUnavailable
        actions={
          <FactorySelector
            factories={managedFactories}
            resetParams={GOVERNANCE_FACTORY_RESET_PARAMS}
            selectedValue="unavailable"
          />
        }
        title="Governance"
        workspaceSlug={workspaceSlug}
      />
    );

  const { factory } = scope;
  const factorySelector = (
    <FactorySelector
      factories={managedFactories}
      resetParams={GOVERNANCE_FACTORY_RESET_PARAMS}
      selectedValue={factory.id}
    />
  );
  const overviewHref = workspaceGovernancePath(workspaceSlug, { factory: factory.id });
  const sources = Object.entries(sourceKinds).flatMap(([key, kind]) => {
    const id = query[key as keyof typeof sourceKinds];
    return id === undefined ? [] : [{ kind, id }];
  });
  const source = factoryAuditSourceSchema.optional().safeParse(sources[0]);
  if (sources.length > 1 || !source.success) {
    return (
      <Unavailable
        actions={factorySelector}
        href={overviewHref}
        text="This governance record is unavailable."
      />
    );
  }
  const parsed = filters.safeParse(query);
  const historyHref = workspaceGovernancePath(workspaceSlug, {
    factory: factory.id,
    ...governanceSourceQuery(source.data),
  });
  if (!parsed.success) {
    return (
      <Unavailable
        actions={factorySelector}
        href={historyHref}
        text="This governance page link is unavailable."
      />
    );
  }

  const { beforeAudit, afterOAuthClient, afterOAuthGrant, ...pages } = parsed.data;
  let data: GovernanceData;
  let subscriptions: Awaited<ReturnType<typeof loadGovernanceSubscriptions>> | null;
  try {
    [data, subscriptions] = await Promise.all([
      loadGovernance(scope, { ...pages, auditCursor: beforeAudit, source: source.data }),
      !source.data || source.data.kind === "grant"
        ? loadGovernanceSubscriptions(scope).catch(() => null)
        : null,
    ]);
  } catch (error) {
    if (error instanceof FactoryAuditCursorError) {
      return (
        <Unavailable
          actions={factorySelector}
          href={historyHref}
          text="This audit page link is unavailable. Open the latest audit events."
        />
      );
    }
    return (
      <Unavailable
        actions={factorySelector}
        href={historyHref}
        text="Governance records are temporarily unavailable."
      />
    );
  }

  const oauthClientsHref = `${workspaceSettingsPath(workspaceSlug, { category: "workspace", afterOAuthClient })}#oauth-clients`;
  const oauthConnectionsHref = scope.isOperator
    ? `${workspaceSettingsPath(workspaceSlug, { category: "workspace", afterOAuthGrant })}#workspace-oauth-connections`
    : `${workspaceSettingsPath(workspaceSlug, { category: "personal", afterOAuthGrant })}#connected-clients`;

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        actions={factorySelector}
        actionsRightOnDesktop
        eyebrow={
          source.data ? (
            <Link className="hover:text-foreground" href={overviewHref}>
              ← Governance
            </Link>
          ) : undefined
        }
        eyebrowAsPlain
        description={
          source.data
            ? `Factory: ${factory.name}`
            : `The factory selector scopes principals, execution grants, credentials, subscriptions, and audit to ${factory.name}.`
        }
        title="Governance"
      />
      <div className="space-y-8">
        <GovernanceResources
          data={data}
          filters={parsed.data}
          scope={scope}
          source={source.data}
          subscriptions={subscriptions}
        />
        {!source.data && (
          <GovernanceEventSubscriptions
            key={factory.id}
            data={subscriptions}
            endpoint={`/api/workspaces/${scope.workspaceId}/factories/${factory.id}/event-subscriptions`}
          />
        )}
        <GovernanceAudit cursor={beforeAudit} data={data} scope={scope} source={source.data} />
        {!source.data && (
          <nav aria-label="OAuth settings" className="flex flex-wrap gap-2">
            {scope.isOperator ? (
              <Link
                className="ui-button min-h-9 scroll-mt-4"
                href={oauthClientsHref}
                id="oauth-clients"
              >
                Manage workspace OAuth clients
              </Link>
            ) : null}
            <Link
              className="ui-button min-h-9 scroll-mt-4"
              href={oauthConnectionsHref}
              id="connected-clients"
            >
              {scope.isOperator
                ? "Manage workspace OAuth connections"
                : "Manage your connected clients"}
            </Link>
          </nav>
        )}
      </div>
    </PageContainer>
  );
}

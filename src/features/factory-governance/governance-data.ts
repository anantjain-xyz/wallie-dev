import "server-only";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { resolveGovernanceFactorySelection } from "@/features/factories/factory-selection";
import {
  isWorkspaceOperator,
  loadAuthenticatedWorkspaceContext,
} from "@/features/workspaces/authenticated-context";
import { readFactoryAuditPage, type FactoryAuditSource } from "@/lib/factories/audit";
import { loadFactoryDefinitionRepositories } from "@/lib/factory-definitions/authority";
import {
  selectCurrentFactoryActivation,
  selectStoredFactoryDefinition,
} from "@/lib/factory-definitions/storage";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import { mcpOperationScopeId } from "@/lib/factory-mcp/manifest";

const pageSize = 20;
const principalColumns = "id, name, slug, created_by_member_id, created_at";
const grantColumns =
  "id, service_principal_id, github_repository_id, read_context_repository_ids, tool_ids, command_scopes, execution_policy_revision_id, budget_payer_member_id, expires_at, version, approved_by_member_id, approved_at, revoked_at, revoked_by_member_id, revocation_reason";

export async function loadGovernanceScope(workspaceSlug: string, factoryQuery?: string | string[]) {
  const [{ currentMember, supabase, user, workspace }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const selection = resolveGovernanceFactorySelection(factories, factoryQuery);
  if (selection.kind !== "factory") return null;
  return {
    factory: selection.factory,
    supabase,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    actorUserId: user.id,
    isOperator: isWorkspaceOperator(currentMember),
  };
}

type Scope = NonNullable<Awaited<ReturnType<typeof loadGovernanceScope>>>;

async function loadCurrentAuthority(scope: Scope) {
  const { factory, supabase, workspaceId } = scope;
  const { data: activation, error: activationError } = await selectCurrentFactoryActivation(
    supabase,
    workspaceId,
    factory.id,
  );
  if (activationError) throw activationError;
  if (!activation) return null;
  const { data: stored, error } = await selectStoredFactoryDefinition(
    supabase,
    workspaceId,
    factory.id,
    { kind: "revision", id: activation.revision_id },
  );
  if (error) throw error;
  if (!stored) return null;
  const definition = readVerifiedFactoryDefinition(stored.definition_json, stored.canonical_digest);
  if (!definition) return null;
  return {
    definitionRevisionId: stored.id,
    grantId: definition.executionGrant?.id ?? null,
    grantVersion: definition.executionGrant?.version ?? null,
    bindingId: definition.credentialBindingId ?? null,
  };
}

function resourcePage<T extends { id: string }>(rows: T[], selected: T | null) {
  const entries = rows.slice(0, pageSize);
  const next = rows.length > pageSize ? (entries.at(-1)?.id ?? null) : null;
  return {
    entries:
      selected && !entries.some(({ id }) => id === selected.id) ? [selected, ...entries] : entries,
    next,
    selected,
  };
}

export async function loadGovernance(
  scope: Scope,
  {
    afterGrant,
    afterPrincipal,
    afterBinding,
    afterToken,
    auditCursor,
    source,
  }: {
    afterGrant?: string;
    afterPrincipal?: string;
    afterBinding?: string;
    afterToken?: string;
    auditCursor?: string;
    source?: FactoryAuditSource;
  },
) {
  const { factory, supabase, workspaceId } = scope;
  const principalsQuery = () =>
    supabase
      .from("service_principals")
      .select(principalColumns)
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factory.id);
  const grantsQuery = () =>
    supabase
      .from("factory_execution_grants")
      .select(grantColumns)
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factory.id);
  const principalPage = principalsQuery()
    .order("id")
    .limit(pageSize + 1);
  const grantPage = grantsQuery()
    .order("id")
    .limit(pageSize + 1);
  const tokenPage =
    source?.kind === "grant"
      ? supabase
          .from("factory_machine_tokens")
          .select(
            "id, name, scopes, created_at, expires_at, revoked_at, last_used_at, last_used_scope, execution_grant_version",
          )
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .eq("execution_grant_id", source.id)
          .order("id")
          .limit(pageSize + 1)
      : null;
  const canApprove = factory.status === "active";
  const currentAuthority = loadCurrentAuthority(scope);
  const selectedBindingId = source?.kind === "binding" ? source.id : null;
  const credentialScope = { p_workspace_id: workspaceId, p_factory_id: factory.id };
  const readCredential = (id: string) =>
    supabase.rpc("read_factory_credential_ownership", { ...credentialScope, p_binding_id: id });
  const [
    principals,
    grants,
    selectedPrincipal,
    selectedGrant,
    tokens,
    credentialPage,
    selectedCredential,
    publishedCredential,
    members,
    repositories,
    policies,
    tools,
    authority,
    audit,
  ] = await Promise.all([
    afterPrincipal ? principalPage.gt("id", afterPrincipal) : principalPage,
    afterGrant ? grantPage.gt("id", afterGrant) : grantPage,
    source?.kind === "principal" ? principalsQuery().eq("id", source.id).maybeSingle() : null,
    source?.kind === "grant" ? grantsQuery().eq("id", source.id).maybeSingle() : null,
    tokenPage && (afterToken ? tokenPage.gt("id", afterToken) : tokenPage),
    !source
      ? supabase.rpc("read_factory_credential_ownership", {
          ...credentialScope,
          ...(afterBinding ? { p_after_id: afterBinding } : {}),
          p_limit: pageSize + 1,
        })
      : null,
    selectedBindingId ? readCredential(selectedBindingId) : null,
    !source
      ? currentAuthority.then((authority) =>
          authority?.bindingId ? readCredential(authority.bindingId) : null,
        )
      : null,
    supabase
      .from("workspace_members")
      .select("id, full_name, email, is_active")
      .eq("workspace_id", workspaceId)
      .eq("kind", "human")
      .order("full_name")
      .order("id"),
    loadFactoryDefinitionRepositories(supabase, workspaceId, factory.id),
    canApprove
      ? supabase
          .from("execution_policy_revisions")
          .select("id, revision")
          .eq("workspace_id", workspaceId)
          .order("revision", { ascending: false })
          .limit(100)
      : null,
    canApprove
      ? supabase
          .from("factory_mcp_server_revisions")
          .select("id, revision_number, operation_names, factory_mcp_servers!inner(name)")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .is("revoked_at", null)
          .order("created_at", { ascending: false })
          .order("id")
          .limit(100)
      : null,
    currentAuthority,
    readFactoryAuditPage(supabase, workspaceId, factory.id, {
      cursor: auditCursor,
      facet: "governance",
      source,
      limit: pageSize,
    }),
  ]);
  for (const response of [
    principals,
    grants,
    selectedPrincipal,
    selectedGrant,
    tokens,
    credentialPage,
    selectedCredential,
    publishedCredential,
    members,
    policies,
    tools,
  ]) {
    if (response?.error) throw response.error;
  }

  const selected = selectedCredential?.data?.[0] ?? null;
  const published = publishedCredential?.data?.[0] ?? null;
  const { entries: credentialRows, next: nextBinding } = resourcePage(
    credentialPage?.data ?? [],
    selected,
  );
  if (published && !credentialRows.some(({ id }) => id === published.id)) {
    credentialRows.unshift(published);
  }
  const bindings = credentialRows.map((row) => ({
    id: row.id,
    principalId: row.service_principal_id,
    grantId: row.execution_grant_id,
    agentId: row.factory_agent_id,
    provider: row.agent_provider,
    openCodeProviderId: row.open_code_provider_id,
    status: row.status,
    version: row.version,
    materialRevision: row.material_revision,
    rotatedAt: row.rotated_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  }));

  const principalList = resourcePage(principals.data ?? [], selectedPrincipal?.data ?? null);
  const grantList = resourcePage(grants.data ?? [], selectedGrant?.data ?? null);
  return {
    audit,
    asOf: Date.now(),
    authority,
    bindings,
    nextBinding,
    selectedBindingId: selected?.id ?? null,
    canApprove,
    grantList,
    tokenList: resourcePage(tokens?.data ?? [], null),
    principalList,
    memberOptions: (members.data ?? []).map((row) => ({
      id: row.id,
      label: row.full_name?.trim() || row.email || row.id,
      active: row.is_active,
    })),
    repositoryOptions: repositories.map(({ id, full_name }) => ({ id, label: full_name })),
    policyOptions: (policies?.data ?? []).map(({ id, revision }) => ({
      id,
      label: `Revision ${revision}`,
    })),
    toolOptions: (tools?.data ?? []).flatMap((row) =>
      row.operation_names.map((operation) => ({
        id: mcpOperationScopeId(row.id, operation),
        label: `${row.factory_mcp_servers.name} · v${row.revision_number} · ${operation}`,
      })),
    ),
  };
}

export type GovernanceData = Awaited<ReturnType<typeof loadGovernance>>;
export type GovernanceScope = Scope;

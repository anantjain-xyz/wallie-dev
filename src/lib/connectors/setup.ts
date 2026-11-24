import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { configureConnectorInstallation } from "@/lib/connectors/installations";
import type {
  ConnectorCatalogResponse,
  ConnectorSetupCommand,
  ConnectorSetupResponse,
  connectorCatalogQuerySchema,
} from "@/lib/connectors/setup-contracts";
import {
  ConnectorProviderUnavailable,
  connectorCatalogPageSize,
  connectorProviderTimeoutMs,
  linearCatalogProvider,
  verifyGitHubCatalogRepository,
  verifyGitHubCatalogTenant,
} from "@/lib/connectors/setup-providers";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

type Admin = SupabaseClient<Database>;
type Scope = {
  p_workspace_id: string;
  p_factory_id: string;
  p_actor_user_id: string;
};

class ConnectorSetupFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function resolveConnectorSetupContext(params: Promise<unknown>) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context;
  const { role } = context.access.currentMember;
  if (role !== "owner" && role !== "admin") {
    return {
      ok: false as const,
      response: Response.json(
        { error: "Workspace admin access is required." },
        { status: 403, headers },
      ),
    };
  }
  return {
    ok: true as const,
    admin: createSupabaseAdminClient(),
    scope: {
      p_workspace_id: context.workspaceId,
      p_factory_id: context.factoryId,
      p_actor_user_id: context.access.user.id,
    },
  };
}

export function connectorSetupErrorResponse(error: unknown) {
  if (error instanceof ConnectorSetupFailure || error instanceof ConnectorProviderUnavailable) {
    const status = error instanceof ConnectorSetupFailure ? error.status : 502;
    return Response.json({ error: error.message }, { status, headers });
  }
  const result = z.object({ code: z.string() }).safeParse(error);
  const status = factoryErrorStatus(result.success ? result.data.code : undefined);
  const message =
    status === 409
      ? "Connector setup changed. Reload the configuration before saving."
      : status === 422
        ? "The selected resource could not be configured with the active factory definition."
        : "Connector setup is unavailable.";
  return Response.json({ error: message }, { status, headers });
}

async function linearCredential(admin: Admin, scope: Scope) {
  const { data, error } = await admin
    .from("workspace_secrets")
    .select("id, material_revision, encrypted_value")
    .eq("workspace_id", scope.p_workspace_id)
    .eq("key", "LINEAR_API_KEY")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ConnectorSetupFailure(404, "Set a Linear API key in workspace settings.");
  return data;
}

async function nativeGitHubInstallation(admin: Admin, scope: Scope) {
  const { data, error } = await admin
    .from("github_installations")
    .select("id, installation_id, app_id, target_name")
    .eq("workspace_id", scope.p_workspace_id)
    .eq("suspended", false)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new ConnectorSetupFailure(404, "Connect an active GitHub App in workspace settings.");
  return data;
}

async function mappedResource(admin: Admin, scope: Scope, resourceId: string) {
  const { data, error } = await admin
    .from("factory_connector_resources")
    .select(
      "id, installation_id, provider, external_tenant_id, resource_kind, external_resource_id",
    )
    .eq("workspace_id", scope.p_workspace_id)
    .eq("factory_id", scope.p_factory_id)
    .eq("id", resourceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ConnectorSetupFailure(404, "Connector resource is unavailable.");
  return data;
}

async function connectorInstallation(admin: Admin, scope: Scope, installationId: string) {
  const { data, error } = await admin.rpc("read_connector_installation_state", {
    ...scope,
    p_installation_id: installationId,
  });
  if (error) throw error;
  const installation = data?.[0];
  if (!installation || installation.status !== "connected") {
    throw new ConnectorSetupFailure(
      409,
      "Verify the connector installation before configuring resources.",
    );
  }
  return installation;
}

function githubRepositoryQuery(admin: Admin, scope: Scope, installationId: string) {
  return admin
    .from("github_repositories")
    .select("id, repo_id, full_name")
    .eq("workspace_id", scope.p_workspace_id)
    .eq("factory_id", scope.p_factory_id)
    .eq("github_installation_id", installationId)
    .eq("is_archived", false);
}

async function readGitHubRepository(
  admin: Admin,
  scope: Scope,
  installationId: string,
  choice: { localId: string } | { externalId: string },
) {
  const query = githubRepositoryQuery(admin, scope, installationId);
  const lookup =
    "localId" in choice
      ? query.eq("id", choice.localId)
      : query.eq("repo_id", z.coerce.number().int().positive().safe().parse(choice.externalId));
  const { data, error } = await lookup.maybeSingle();
  if (error) throw error;
  if (!data)
    throw new ConnectorSetupFailure(404, "GitHub repository is unavailable in this factory.");
  return data;
}

async function githubLabels(admin: Admin, scope: Scope, resourceId: string, signal: AbortSignal) {
  const resource = await mappedResource(admin, scope, resourceId);
  if (resource.provider !== "github") {
    throw new ConnectorSetupFailure(404, "GitHub repository is unavailable in this factory.");
  }
  const native = await nativeGitHubInstallation(admin, scope);
  const repository = await readGitHubRepository(admin, scope, native.id, {
    externalId: resource.external_resource_id,
  });
  const verified = await verifyGitHubCatalogTenant(native, signal);
  const installation = await connectorInstallation(admin, scope, resource.installation_id);
  if (
    installation.external_installation_id !== String(verified.installationId) ||
    verified.id !== resource.external_tenant_id
  ) {
    throw new ConnectorSetupFailure(409, "GitHub connector ownership changed.");
  }
  const labels = await verifyGitHubCatalogRepository(verified, repository, signal, {
    readLabels: true,
  });
  return { tenant: { id: verified.id, label: verified.label }, labels };
}

export async function readConnectorCatalog(
  admin: Admin,
  scope: Scope,
  query: z.output<typeof connectorCatalogQuerySchema>,
): Promise<ConnectorCatalogResponse> {
  const signal = AbortSignal.timeout(connectorProviderTimeoutMs);
  if (query.provider === "linear") {
    const secret = await linearCredential(admin, scope);
    const catalog = await linearCatalogProvider(secret.encrypted_value, signal).catalog(
      query.kind,
      query.cursor ?? null,
    );
    return { provider: "linear", kind: query.kind, ...catalog };
  }
  if (query.kind === "label") {
    const { tenant, labels } = await githubLabels(admin, scope, query.resourceId, signal);
    const page = await labels.listLabels(query.cursor ?? 1);
    return { provider: "github", kind: "label", tenant, ...page };
  }

  const native = await nativeGitHubInstallation(admin, scope);
  const candidates = githubRepositoryQuery(admin, scope, native.id)
    .order("id")
    .limit(connectorCatalogPageSize + 1);
  const [{ data, error }, verified] = await Promise.all([
    query.cursor ? candidates.gt("id", query.cursor) : candidates,
    verifyGitHubCatalogTenant(native, signal),
  ]);
  if (error) throw error;
  const repositories = data.slice(0, connectorCatalogPageSize);
  return {
    provider: "github",
    kind: "repository",
    tenant: { id: verified.id, label: verified.label },
    resources: repositories.map(({ id, full_name, repo_id }) => ({
      id,
      label: full_name,
      externalId: String(repo_id),
    })),
    nextCursor: data.length > connectorCatalogPageSize ? (repositories.at(-1)?.id ?? null) : null,
  };
}

async function publishMapping(
  admin: Admin,
  scope: Scope,
  input: {
    installationId: string;
    expectedGeneration: number;
    expectedMappingRevision: number;
    kind: "repository" | "team" | "project";
    externalId: string;
    enabled: boolean;
  },
) {
  const { data, error } = await admin.rpc("publish_connector_resource_mapping", {
    ...scope,
    p_installation_id: input.installationId,
    p_expected_installation_generation: input.expectedGeneration,
    p_expected_revision: input.expectedMappingRevision,
    p_resource_kind: input.kind,
    p_external_resource_id: input.externalId,
    p_enabled: input.enabled,
  });
  if (error) throw error;
  const [receipt] = z
    .tuple([z.object({ resource_id: z.uuid(), revision: z.number().int().positive() })])
    .parse(data);
  return { resourceId: receipt.resource_id, mappingRevision: receipt.revision };
}

async function publishedGitHubGrant(admin: Admin, scope: Scope) {
  const { data: activation, error: activationError } = await admin
    .from("factory_definition_activations")
    .select("revision_id")
    .eq("workspace_id", scope.p_workspace_id)
    .eq("factory_id", scope.p_factory_id)
    .order("activation_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activationError) throw activationError;
  const unavailable = () =>
    new ConnectorSetupFailure(
      422,
      "Publish a service-backed factory definition before configuring GitHub requests.",
    );
  if (!activation) throw unavailable();
  const { data: revision, error: revisionError } = await admin
    .from("factory_definition_revisions")
    .select("definition_json, canonical_digest")
    .eq("workspace_id", scope.p_workspace_id)
    .eq("factory_id", scope.p_factory_id)
    .eq("id", activation.revision_id)
    .maybeSingle();
  if (revisionError) throw revisionError;
  const definition =
    revision && readVerifiedFactoryDefinition(revision.definition_json, revision.canonical_digest);
  if (!definition || !definition.executionGrant || !definition.implementationAgent)
    throw unavailable();
  return definition.executionGrant;
}

export async function applyConnectorSetup(
  admin: Admin,
  scope: Scope,
  command: ConnectorSetupCommand,
): Promise<ConnectorSetupResponse> {
  if (command.action === "disconnect") {
    const { error } = await admin.rpc("disconnect_connector_installation", {
      ...scope,
      p_installation_id: command.installationId,
      p_expected_generation: command.expectedGeneration,
    });
    if (error) throw error;
    return { disconnected: true };
  }
  if (command.action === "disable") {
    const resource = await mappedResource(admin, scope, command.resourceId);
    return publishMapping(admin, scope, {
      ...command,
      installationId: resource.installation_id,
      kind: resource.resource_kind,
      externalId: resource.external_resource_id,
      enabled: false,
    });
  }

  const signal = AbortSignal.timeout(connectorProviderTimeoutMs);
  if (command.action === "github_request") {
    const grant = await publishedGitHubGrant(admin, scope);
    const { labels } = await githubLabels(admin, scope, command.resourceId, signal);
    const label = await labels.readLabel(command.labelName);
    if (label.id !== command.labelId) throw new ConnectorSetupFailure(409, "GitHub label changed.");
    const { data, error } = await admin.rpc("configure_github_connector_request", {
      ...scope,
      p_resource_id: command.resourceId,
      p_source_kind: command.sourceKind,
      p_expected_revision: command.expectedRevision,
      p_enabled: true,
      p_label_id: label.id,
      p_execution_grant_id: grant.id,
      p_execution_grant_version: grant.version,
    });
    if (error) throw error;
    return { revision: z.number().int().positive().parse(data) };
  }
  if (command.action === "connect") {
    const expected = {
      workspaceId: scope.p_workspace_id,
      factoryId: scope.p_factory_id,
      actorUserId: scope.p_actor_user_id,
      expectedGeneration: command.expectedGeneration,
    };
    if (command.provider === "github") {
      const native = await nativeGitHubInstallation(admin, scope);
      const tenant = await verifyGitHubCatalogTenant(native, signal);
      if (tenant.id !== command.expectedTenantId) {
        throw new ConnectorSetupFailure(409, "GitHub organization or account changed.");
      }
      return configureConnectorInstallation(admin, {
        ...expected,
        installation: {
          provider: "github",
          externalTenantId: tenant.id,
          externalInstallationId: String(tenant.installationId),
        },
      });
    }

    const secret = await linearCredential(admin, scope);
    const tenant = await linearCatalogProvider(secret.encrypted_value, signal).tenant();
    if (tenant.id !== command.expectedTenantId) {
      throw new ConnectorSetupFailure(409, "Linear organization changed.");
    }
    return configureConnectorInstallation(admin, {
      ...expected,
      installation: {
        provider: "linear",
        externalTenantId: tenant.id,
        externalInstallationId: tenant.id,
        secretId: secret.id,
        materialRevision: secret.material_revision,
      },
    });
  }

  const installation = await connectorInstallation(admin, scope, command.installationId);
  if (installation.generation !== command.expectedGeneration) {
    throw new ConnectorSetupFailure(
      409,
      "Connector setup changed. Reload the configuration before saving.",
    );
  }
  const { kind, id } = command.resource;
  const mapping = { ...command, kind, enabled: true };
  if (kind === "repository" && installation.provider === "github") {
    const native = await nativeGitHubInstallation(admin, scope);
    const repository = await readGitHubRepository(admin, scope, native.id, { localId: id });
    const tenant = await verifyGitHubCatalogTenant(native, signal);
    if (
      installation.external_installation_id !== String(tenant.installationId) ||
      installation.external_tenant_id !== tenant.id
    ) {
      throw new ConnectorSetupFailure(409, "GitHub connector ownership changed.");
    }
    await verifyGitHubCatalogRepository(tenant, repository, signal);
    return publishMapping(admin, scope, { ...mapping, externalId: String(repository.repo_id) });
  }
  if (kind !== "repository" && installation.provider === "linear") {
    const secret = await linearCredential(admin, scope);
    const verified = await linearCatalogProvider(secret.encrypted_value, signal).resource(kind, id);
    if (verified.tenantId !== installation.external_tenant_id || verified.resourceId !== id) {
      throw new ConnectorSetupFailure(409, "Linear organization or resource changed.");
    }
    return publishMapping(admin, scope, { ...mapping, externalId: id });
  }
  throw new ConnectorSetupFailure(422, "The resource type does not match this connector.");
}

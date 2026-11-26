import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { deliveryRequirementsSchema } from "@/lib/delivery-policy/contracts";
import { executionRequirementsSchema } from "@/lib/execution-policy/contracts";
import { modelRoutingConfigurationSchema } from "@/lib/model-routing/contracts";
import type { Database } from "@/lib/supabase/database.types";

import {
  grantReferenceKey,
  referenceKind,
  routingConfigurationKey,
  type NamedReference,
  type NamedReferencesRequest,
  type ReferenceKind,
} from "./named-reference-contracts";
import { readVerifiedFactoryDefinition } from "./stored-definition";

type Query<T> = PromiseLike<{ data: T[] | null; error: unknown }> & {
  in(column: string, values: readonly string[]): Query<T>;
  order(column: string, options?: { ascending?: boolean }): Query<T>;
  range(from: number, to: number): Query<T>;
};
type Group = { options: NamedReference[]; next?: number };
type Client = SupabaseClient<Database>;
const pageSize = 40;
const joinedPageSize = 250;
const maxJoinedRows = 10_000;

async function rows<T>(query: PromiseLike<{ data: T[] | null; error: unknown }>) {
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

async function byIds<T>(query: () => Query<T>, ids: readonly string[], joinedRowKey?: string) {
  const unique = [...new Set(ids)];
  const results: T[] = [];
  for (let i = 0; i < unique.length; i += pageSize) {
    const batch = unique.slice(i, i + pageSize);
    if (!joinedRowKey) {
      results.push(...(await rows(query().in("id", batch))));
      continue;
    }
    for (let offset = 0; ; offset += joinedPageSize) {
      const page = await rows(
        query()
          .in("experiment_id", batch)
          .order("experiment_id")
          .order(joinedRowKey)
          .range(offset, offset + joinedPageSize - 1),
      );
      if (offset + page.length > maxJoinedRows)
        throw new Error("The benchmark reference lookup exceeded its row limit.");
      results.push(...page);
      if (page.length < joinedPageSize) break;
    }
  }
  return results;
}

const day = (iso: string) => iso.slice(0, 10);

export async function loadNamedFactoryReferences(
  client: Client,
  workspaceId: string,
  factoryId: string,
  request: NamedReferencesRequest,
) {
  const scope = { workspace_id: workspaceId, factory_id: factoryId };
  const repositories = (ids: string[]) =>
    byIds(() => client.from("github_repositories").select("id, full_name").match(scope), ids);

  async function group(kind: ReferenceKind): Promise<Group> {
    let next: number | undefined;
    async function read<T>(query: () => Query<T>, recent = false) {
      if (request.mode === "pins") return byIds(query, request.ids[kind] ?? []);
      const offset = request.mode === "more" ? request.offset : 0;
      const ordered = recent ? query().order("created_at", { ascending: false }) : query();
      const data = await rows(ordered.order("id").range(offset, offset + pageSize));
      if (data.length > pageSize) next = offset + pageSize;
      return data.slice(0, pageSize);
    }
    const finish = (options: NamedReference[]) => ({ options, next });
    const picking = request.mode !== "pins";

    switch (kind) {
      case "pipeline": {
        const data = await read(() =>
          client
            .from("pipelines")
            .select("id, name, is_default, pipeline_stages(count)")
            .match(scope)
            .is("pipeline_stages.archived_at", null),
        );
        return finish(
          data.map(({ id, name, is_default, pipeline_stages }) => ({
            id,
            aliases: [name],
            label: `${name} · ${pipeline_stages[0]?.count ?? 0} stages${is_default ? " · Default" : ""}`,
          })),
        );
      }
      case "executionPolicy": {
        const data = await read(
          () =>
            client
              .from("execution_policy_revisions")
              .select("id, revision, created_at, requirements")
              .eq("workspace_id", workspaceId),
          true,
        );
        return finish(
          data.map(({ id, revision, created_at, requirements }) => {
            const limits = executionRequirementsSchema.safeParse(requirements);
            return {
              id,
              label: `Execution policy · v${revision} · ${day(created_at)}${limits.success ? ` · ${limits.data.maxRepairAttempts} repairs · ${limits.data.maxExecutionMs / 1000}s limit` : ""}`,
            };
          }),
        );
      }
      case "deliveryPolicy": {
        const data = await read(
          () =>
            client
              .from("delivery_policy_revisions")
              .select(
                "id, revision, created_at, requirements, pipeline_id, pipelines!inner(name, factory_id)",
              )
              .eq("workspace_id", workspaceId)
              .eq("pipelines.factory_id", factoryId),
          true,
        );
        return finish(
          data.map(({ id, revision, created_at, requirements, pipeline_id, pipelines }) => {
            const policy = deliveryRequirementsSchema.safeParse(requirements);
            return {
              id,
              pipelineId: pipeline_id,
              label: `${pipelines.name} · Delivery policy v${revision} · ${day(created_at)}${policy.success ? ` · ${policy.data.deliveryMode} · ${policy.data.requiredChecks.length} checks · ${policy.data.minimumApprovals} approvals` : ""}`,
            };
          }),
        );
      }
      case "implementationAgent": {
        const data = await read(
          () =>
            client
              .from("factory_agent_prompt_revisions")
              .select(
                "id, agent_id, revision_number, created_at, factory_agents!inner(name, slug, is_default)",
              )
              .match(scope),
          true,
        );
        return finish(
          data.map(({ id, revision_number, created_at, agent_id, factory_agents }) => ({
            id,
            agentId: agent_id,
            label: `${factory_agents.name} · Revision ${revision_number} · ${day(created_at)}${factory_agents.is_default ? " · Default agent" : ""} · ${factory_agents.slug}`,
          })),
        );
      }
      case "approvers": {
        const data = await read(() => {
          const query = client
            .from("workspace_members")
            .select("id, full_name, email, role, is_active")
            .eq("workspace_id", workspaceId)
            .eq("kind", "human");
          return picking ? query.eq("is_active", true) : query;
        });
        return finish(
          data.map(({ id, full_name, email, role, is_active }) => ({
            id,
            label: [full_name || email || "Workspace member", full_name && email, role]
              .filter(Boolean)
              .join(" · "),
            unavailable: !is_active,
          })),
        );
      }
      case "skills": {
        const data = await read(() => {
          const query = client
            .from("factory_skill_revisions")
            .select("id, revision_number, revoked_at, factory_skills!inner(name)")
            .match(scope);
          return picking ? query.is("revoked_at", null) : query;
        }, true);
        return finish(
          data.map(({ id, revision_number, revoked_at, factory_skills }) => ({
            id,
            label: `${factory_skills.name} · Revision ${revision_number}`,
            unavailable: Boolean(revoked_at),
          })),
        );
      }
      case "scorers": {
        const data = await read(
          () =>
            client
              .from("factory_scorer_revisions")
              .select("id, revision_number, factory_scorers!inner(name)")
              .match(scope),
          true,
        );
        return finish(
          data.map(({ id, revision_number, factory_scorers }) => ({
            id,
            label: `${factory_scorers.name} · Revision ${revision_number}`,
          })),
        );
      }
      case "tools": {
        const data = await read(() => {
          const query = client
            .from("factory_mcp_server_revisions")
            .select(
              "id, revision_number, endpoint, auth_kind, operation_names, revoked_at, factory_mcp_servers!inner(name)",
            )
            .match(scope);
          return picking ? query.is("revoked_at", null) : query;
        }, true);
        return finish(
          data.flatMap(
            ({
              id,
              revision_number,
              endpoint,
              auth_kind,
              operation_names,
              revoked_at,
              factory_mcp_servers,
            }) => {
              if (auth_kind !== "none" && auth_kind !== "bearer") return [];
              return [
                {
                  id,
                  label: `${factory_mcp_servers.name} · Revision ${revision_number} · ${URL.parse(endpoint)?.host ?? "Host unavailable"}`,
                  operations: operation_names,
                  authKind: auth_kind,
                  unavailable: Boolean(revoked_at),
                },
              ];
            },
          ),
        );
      }
      case "bindings": {
        const data = await read(() => {
          const query = client
            .from("factory_mcp_secret_bindings")
            .select(
              "id, execution_grant_id, service_principal_id, factory_agent_id, tool_revision_id, created_at, revoked_at",
            )
            .match(scope);
          return picking ? query.is("revoked_at", null) : query;
        }, true);
        const principals = await byIds(
          () => client.from("service_principals").select("id, name").match(scope),
          data.map(({ service_principal_id }) => service_principal_id),
        );
        const names = new Map(principals.map(({ id, name }) => [id, name]));
        return finish(
          data.map((row) => ({
            id: row.id,
            toolId: row.tool_revision_id,
            grantId: row.execution_grant_id,
            agentId: row.factory_agent_id,
            principalId: row.service_principal_id,
            unavailable: Boolean(row.revoked_at),
            label: `${names.get(row.service_principal_id) ?? "Service principal"} · Saved bearer binding · ${day(row.created_at)}`,
          })),
        );
      }
      case "grants": {
        const now = new Date().toISOString();
        const data = await read(() => {
          const query = client
            .from("factory_execution_grants")
            .select(
              "id, version, revoked_at, expires_at, service_principal_id, github_repository_id, execution_policy_revision_id, tool_ids",
            )
            .match(scope);
          return picking ? query.is("revoked_at", null).gt("expires_at", now) : query;
        });
        const [principals, repos, policies] = await Promise.all([
          byIds(
            () => client.from("service_principals").select("id, name").match(scope),
            data.map(({ service_principal_id }) => service_principal_id),
          ),
          repositories(data.map(({ github_repository_id }) => github_repository_id)),
          byIds(
            () =>
              client
                .from("execution_policy_revisions")
                .select("id, revision")
                .eq("workspace_id", workspaceId),
            data.map(({ execution_policy_revision_id }) => execution_policy_revision_id),
          ),
        ]);
        return finish(
          data.map((grant) => {
            const principal = principals.find(({ id }) => id === grant.service_principal_id);
            const repo = repos.find(({ id }) => id === grant.github_repository_id);
            const policy = policies.find(({ id }) => id === grant.execution_policy_revision_id);
            const status = grant.revoked_at
              ? "Revoked"
              : Date.parse(grant.expires_at) <= Date.parse(now)
                ? "Expired"
                : !principal || !repo
                  ? "Unavailable"
                  : null;
            return {
              id: grantReferenceKey(grant.id, grant.version),
              grantId: grant.id,
              version: grant.version,
              principalId: grant.service_principal_id,
              toolIds: grant.tool_ids,
              unavailable: Boolean(status),
              label: `${principal?.name ?? "Principal unavailable"} · ${repo?.full_name ?? "Repository unavailable"} · Grant v${grant.version}${policy ? ` · Policy v${policy.revision}` : ""} · ${status ?? `Expires ${day(grant.expires_at)}`}`,
            };
          }),
        );
      }
      case "context": {
        const data = await read(() => {
          const query = client
            .from("factory_context_source_revisions")
            .select(
              "id, source_id, created_at, upstream_revision, content_purged_at, source:factory_context_sources!factory_context_source_revisi_workspace_id_factory_id_sour_fkey!inner(repository_id, grant_id, grant_version, file_path, current_revision_id)",
            )
            .match(scope);
          return picking ? query.is("content_purged_at", null) : query;
        }, true);
        if (!data.length) return finish([]);
        const sourceIds = [...new Set(data.map(({ source_id }) => source_id))];
        const [repos, access] = await Promise.all([
          repositories(data.map(({ source }) => source.repository_id)),
          Promise.all(
            Array.from({ length: Math.ceil(sourceIds.length / 100) }, (_, i) =>
              rows(
                client.rpc("list_factory_context_source_access", {
                  target_workspace_id: workspaceId,
                  target_factory_id: factoryId,
                  target_source_ids: sourceIds.slice(i * 100, (i + 1) * 100),
                }),
              ),
            ),
          ),
        ]);
        const statuses = new Map(access.flat().map(({ source_id, status }) => [source_id, status]));
        return finish(
          data.map((revision) => {
            const source = revision.source;
            const repo = repos.find(({ id }) => id === source.repository_id);
            return {
              id: revision.id,
              sourceId: revision.source_id,
              grantId: source.grant_id,
              version: source.grant_version,
              unavailable:
                statuses.get(revision.source_id) !== "available" ||
                Boolean(revision.content_purged_at),
              label: `${repo?.full_name ?? "Repository unavailable"} · ${source.file_path} · ${source.current_revision_id === revision.id ? "Current" : "Historical"} · ${day(revision.created_at)} · ${revision.upstream_revision.slice(0, 8)}`,
            };
          }),
        );
      }
      case "routing": {
        const experiments = await read(
          () =>
            client
              .from("factory_benchmark_experiments")
              .select(
                "id, created_at, suite_revision_id, eligible_trial_count, materialized_trial_count",
              )
              .match(scope),
          true,
        );
        const experimentIds = experiments.map(({ id }) => id);
        const [candidates, suites, dimensions] = await Promise.all([
          byIds(
            () =>
              client
                .from("factory_benchmark_experiment_candidates")
                .select(
                  "experiment_id, candidate_key, definition_revision_id, definition_digest, qualification_id, canonical_model_key, harness, worker_runtime",
                )
                .match(scope)
                .not("qualification_id", "is", null),
            experimentIds,
            "candidate_key",
          ),
          byIds(
            () =>
              client
                .from("factory_benchmark_suite_revisions")
                .select("id, name, revision_number")
                .match(scope),
            experiments.map(({ suite_revision_id }) => suite_revision_id),
          ),
          byIds(
            () =>
              client
                .from("factory_benchmark_evaluation_dimensions")
                .select(
                  "experiment_id, scorer_revision_id, factory_scorer_revisions!inner(revision_number, factory_scorers!inner(name))",
                )
                .match(scope),
            experimentIds,
            "scorer_revision_id",
          ),
        ]);
        const revisions = await byIds(
          () =>
            client
              .from("factory_definition_revisions")
              .select("id, canonical_digest, definition_json")
              .match(scope),
          candidates.map(({ definition_revision_id }) => definition_revision_id),
        );
        const definitions = new Map(
          revisions.map(({ id, canonical_digest, definition_json }) => [
            id,
            {
              digest: canonical_digest,
              agentId: readVerifiedFactoryDefinition(definition_json, canonical_digest)
                ?.implementationAgent?.agentId,
            },
          ]),
        );
        const agents = await byIds(
          () => client.from("factory_agents").select("id, name").match(scope),
          [...definitions.values()].flatMap(({ agentId }) => (agentId ? [agentId] : [])),
        );
        const choices = new Map<string, NamedReference>();
        for (const candidate of candidates) {
          const comparison = experiments.find(({ id }) => id === candidate.experiment_id);
          const definition = definitions.get(candidate.definition_revision_id);
          if (!comparison || !definition || definition.digest !== candidate.definition_digest)
            continue;
          const suite = suites.find(({ id }) => id === comparison.suite_revision_id);
          const agent = agents.find(({ id }) => id === definition.agentId);
          const scorers = dimensions.filter(({ experiment_id }) => experiment_id === comparison.id);
          for (const scorer of [...scorers, ...(scorers.length === 1 ? [undefined] : [])]) {
            const result = modelRoutingConfigurationSchema.safeParse({
              agentId: definition.agentId,
              definitionRevisionId: candidate.definition_revision_id,
              experimentId: comparison.id,
              qualificationId: candidate.qualification_id,
              scorerRevisionId: scorer?.scorer_revision_id,
              modelKey: candidate.canonical_model_key,
              harness: candidate.harness,
              workerRuntime: candidate.worker_runtime,
            });
            if (!result.success) continue;
            const configuration = result.data;
            const id = routingConfigurationKey(configuration);
            const duplicate = choices.get(id);
            if (duplicate) {
              choices.set(id, { ...duplicate, unavailable: true });
              continue;
            }
            const frozen = (scorer ?? scorers[0])?.factory_scorer_revisions;
            if (!scorer && picking) continue;
            choices.set(id, {
              id,
              configuration,
              labelOnly: !scorer,
              label: `${agent?.name ?? "Agent unavailable"} · ${configuration.modelKey} · ${suite?.name ?? "Suite unavailable"}${suite ? ` v${suite.revision_number}` : ""} · ${day(comparison.created_at)} · ${frozen ? `${frozen.factory_scorers.name} v${frozen.revision_number}` : "Scorer unavailable"}${!scorer ? " (implicit)" : ""} · ${configuration.harness} / ${configuration.workerRuntime} · ${candidate.candidate_key} · ${comparison.eligible_trial_count}/${comparison.materialized_trial_count} eligible trials`,
              unavailable: !agent || !suite || !frozen || comparison.eligible_trial_count === 0,
            });
          }
        }
        return finish([...choices.values()]);
      }
    }
  }

  const kinds =
    request.mode === "initial"
      ? referenceKind.options
      : request.mode === "more"
        ? [request.kind]
        : referenceKind.options.filter((kind) => request.ids[kind]?.length);
  return {
    groups: Object.fromEntries(
      await Promise.all(kinds.map(async (kind) => [kind, await group(kind)] as const)),
    ),
  };
}

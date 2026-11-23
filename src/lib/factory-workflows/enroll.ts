import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { withCatalogSignal } from "@/lib/factory-definitions/catalog-query";
import type { FactoryDefinitionSource } from "@/lib/factory-definitions/compiler";
import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import { compileWorkflowGraph } from "@/lib/factory-definitions/workflow-compiler";
import {
  workflowGraphSchema,
  type WorkflowGraphDefinition,
} from "@/lib/factory-definitions/workflow-schema";
import type { Database, Tables } from "@/lib/supabase/database.types";

import { executeFactoryWorkflowOccurrence, resumeEnrolledFactoryWorkflowGraph } from "./execute";
import { loadWorkflowGraphReferences } from "./reference-catalog";

type WorkflowScope = {
  rootSessionId: string;
  workspaceId: string;
  factoryId: string;
};

type AdmissionPin = Pick<
  Tables<"session_factory_admission_inputs">,
  | "definition_revision_id"
  | "definition_digest"
  | "execution_grant_id"
  | "execution_grant_version"
  | "github_repository_id"
  | "execution_policy_revision_id"
  | "credential_owner_service_principal_id"
  | "budget_payer_member_id"
>;

async function loadApprovedWorkflowGrants({
  admin,
  workspaceId,
  factoryId,
  graph,
  pin,
  signal,
}: Pick<WorkflowScope, "workspaceId" | "factoryId"> & {
  admin: SupabaseClient<Database>;
  graph: WorkflowGraphDefinition;
  pin: AdmissionPin;
  signal?: AbortSignal;
}) {
  const {
    execution_grant_id: id,
    execution_grant_version: version,
    github_repository_id: repositoryId,
    execution_policy_revision_id: policyId,
    credential_owner_service_principal_id: principalId,
    budget_payer_member_id: payerId,
  } = pin;
  if (
    !id ||
    version === null ||
    !repositoryId ||
    !policyId ||
    !principalId ||
    !payerId ||
    !graph.grants.some((grant) => grant.id === id && grant.version === version)
  )
    return [];

  const revision = await withCatalogSignal(
    admin
      .from("factory_definition_revisions")
      .select("definition_json")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .eq("id", pin.definition_revision_id)
      .eq("canonical_digest", pin.definition_digest),
    signal,
  ).maybeSingle();
  if (revision.error) throw revision.error;
  if (!revision.data) return [];
  const definition = readVerifiedFactoryDefinition(
    revision.data.definition_json,
    pin.definition_digest,
  );
  if (
    definition?.executionGrant?.id !== id ||
    definition.executionGrant.version !== version ||
    definition.repositoryId !== repositoryId ||
    definition.executionPolicyRevisionId !== policyId
  )
    return [];

  const grant = await withCatalogSignal(
    admin
      .from("factory_execution_grants")
      .select("id, version, workspace_id, expires_at")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .eq("id", id)
      .eq("version", version)
      .eq("github_repository_id", repositoryId)
      .eq("execution_policy_revision_id", policyId)
      .eq("service_principal_id", principalId)
      .eq("budget_payer_member_id", payerId)
      .contains("read_context_repository_ids", definition.readContextRepositoryIds ?? [])
      .contains("tool_ids", definition.toolIds)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString()),
    signal,
  ).maybeSingle();
  if (grant.error) throw grant.error;
  if (!grant.data || !(Date.parse(grant.data.expires_at) > Date.now())) return [];
  return [{ id: grant.data.id, version: grant.data.version, workspaceId: grant.data.workspace_id }];
}

export async function enrollFactoryWorkflowGraph(
  admin: SupabaseClient<Database>,
  {
    source,
    rootSessionId,
    workspaceId,
    factoryId,
    inputRunId,
    resumeFromGeneration,
  }: WorkflowScope &
    (
      | { source: FactoryDefinitionSource; inputRunId?: string; resumeFromGeneration?: undefined }
      | { source?: FactoryDefinitionSource; inputRunId?: string; resumeFromGeneration: number }
    ),
  signal?: AbortSignal,
) {
  if (resumeFromGeneration !== undefined) {
    const { entry, ownership, progress } = await resumeEnrolledFactoryWorkflowGraph(
      admin,
      {
        p_root_session_id: rootSessionId,
        p_workspace_id: workspaceId,
        p_factory_id: factoryId,
      },
      resumeFromGeneration,
    );
    if (!entry)
      return {
        ok: false as const,
        diagnostics: [
          {
            code: "missing_reference" as const,
            path: [],
            message: "The enrolled workflow is unavailable.",
          },
        ],
      };
    return {
      ok: true as const,
      execution: {
        execution_generation: entry.p_expected_generation,
        entry_occurrence_id: entry.occurrenceId,
        created: false,
        ownership_token: ownership?.ownership_token ?? null,
      },
      entry,
      progress,
    };
  }

  const input =
    source.kind === "json"
      ? parseFactoryDefinitionJson(source.text)
      : { ok: true as const, value: source.value };
  const graph = workflowGraphSchema.safeParse(input.ok ? input.value : null);
  if (!graph.success) {
    return compileWorkflowGraph(source, { workspaceId, agentPromptRevisions: [], approvers: [] });
  }

  if (!graph.data.routePolicy && graph.data.nodes.some(({ kind }) => kind === "route"))
    return {
      ok: false as const,
      diagnostics: [
        {
          path: ["routePolicy"],
          code: "invalid_route_policy" as const,
          message: "Route nodes require a pinned workflow route policy before execution.",
        },
      ],
    };

  const { data: pin, error: pinError } = await withCatalogSignal(
    admin
      .from("session_factory_admission_inputs")
      .select(
        "definition_revision_id, definition_digest, execution_grant_id, execution_grant_version, github_repository_id, execution_policy_revision_id, credential_owner_service_principal_id, budget_payer_member_id",
      )
      .eq("session_id", rootSessionId)
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId),
    signal,
  ).maybeSingle();
  if (pinError) throw pinError;
  if (!pin) throw new Error("The workflow root has no scoped session definition.");

  const [references, approvedGrants] = await Promise.all([
    loadWorkflowGraphReferences(admin, { workspaceId, factoryId, graph: graph.data, signal }),
    loadApprovedWorkflowGrants({ admin, workspaceId, factoryId, graph: graph.data, pin, signal }),
  ]);
  const compiled = compileWorkflowGraph(
    { kind: "structured", value: graph.data },
    { workspaceId, ...references, approvedGrants },
  );
  if (!compiled.ok) return compiled;

  const { data: registered, error: registrationError } = await admin
    .rpc("register_factory_workflow_graph_revision", {
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_definition_revision_id: pin.definition_revision_id,
      p_definition_digest: pin.definition_digest,
      p_workflow_json: compiled.definitionJson,
      p_workflow_digest: compiled.canonicalDigest,
    })
    .single();
  if (registrationError) throw registrationError;

  const { data: execution, error: enrollmentError } = await admin
    .rpc("start_factory_workflow_graph_execution", {
      p_root_session_id: rootSessionId,
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_graph_revision_id: registered.graph_revision_id,
      ...(inputRunId ? { p_input_run_id: inputRunId } : {}),
    })
    .single();
  if (enrollmentError) throw enrollmentError;

  const entry = {
    p_root_session_id: rootSessionId,
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_expected_generation: execution.execution_generation,
    occurrenceId: execution.entry_occurrence_id,
    nodeId: compiled.bundle.entryNodeId,
    workflowDigest: compiled.canonicalDigest,
  };
  if (execution.created && execution.ownership_token) {
    const progress = await executeFactoryWorkflowOccurrence(admin, {
      ...entry,
      p_ownership_token: execution.ownership_token,
    });
    return { ok: true as const, execution, entry, progress };
  }
  return {
    ok: true as const,
    execution,
    entry,
    progress: null,
  };
}

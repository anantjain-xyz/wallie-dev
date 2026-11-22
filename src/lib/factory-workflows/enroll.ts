import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadFactoryDefinitionCatalog } from "@/lib/factory-definitions/authority";
import type { FactoryDefinitionSource } from "@/lib/factory-definitions/compiler";
import { compileWorkflowGraph } from "@/lib/factory-definitions/workflow-compiler";
import type { Database } from "@/lib/supabase/database.types";

import { executeFactoryWorkflowOccurrence, resumeFactoryWorkflowOccurrence } from "./execute";

type WorkflowScope = {
  rootSessionId: string;
  workspaceId: string;
  factoryId: string;
};

export async function enrollFactoryWorkflowGraph(
  admin: SupabaseClient<Database>,
  {
    source,
    rootSessionId,
    workspaceId,
    factoryId,
    inputRunId,
    resumeFromGeneration,
  }: WorkflowScope & {
    source: FactoryDefinitionSource;
    inputRunId?: string;
    resumeFromGeneration?: number;
  },
  signal?: AbortSignal,
) {
  const { data: pin, error: pinError } = await admin
    .from("session_factory_admission_inputs")
    .select("definition_revision_id, definition_digest")
    .eq("session_id", rootSessionId)
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .maybeSingle();
  if (pinError) throw pinError;
  if (!pin) throw new Error("The workflow root has no scoped session definition.");

  const catalog = await loadFactoryDefinitionCatalog(admin, { workspaceId, factoryId }, signal);
  const compiled = compileWorkflowGraph(source, {
    workspaceId,
    agentPromptRevisions: catalog.agentPromptRevisions ?? [],
    approvers: catalog.approvers,
  });
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
  if (resumeFromGeneration !== undefined) {
    const { ownership, progress } = await resumeFactoryWorkflowOccurrence(admin, {
      ...entry,
      p_expected_generation: resumeFromGeneration,
    });
    return {
      ok: true as const,
      execution: { ...execution, ...ownership },
      entry: {
        ...entry,
        p_expected_generation: ownership?.execution_generation ?? entry.p_expected_generation,
      },
      progress,
    };
  }
  return {
    ok: true as const,
    execution,
    entry,
    progress: null,
  };
}

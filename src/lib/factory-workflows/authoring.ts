import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import { compileWorkflowGraph } from "@/lib/factory-definitions/workflow-compiler";
import { workflowGraphSchema } from "@/lib/factory-definitions/workflow-schema";
import type { Database } from "@/lib/supabase/database.types";

import {
  createWorkflowAuthoringSchema,
  workflowAuthoringListSchema,
  workflowAuthoringSnapshotSchema,
  workflowPublishReceiptSchema,
  workflowSaveReceiptSchema,
  type WorkflowAuthoringCommand,
  type WorkflowBaseDefinition,
} from "./authoring-contracts";
import { loadWorkflowGraphReferences } from "./reference-catalog";

type Client = SupabaseClient<Database>;
type FactoryScope = { workspaceId: string; factoryId: string };
type WorkflowScope = FactoryScope & { workflowId: string };
type Author = WorkflowScope & { actorUserId: string };

export async function listWorkflowAuthoring(client: Client, scope: FactoryScope, afterId?: string) {
  const { data, error } = await client.rpc("list_factory_workflow_authoring", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    ...(afterId ? { p_after_id: afterId } : {}),
  });
  if (error) throw error;
  if (!data) return null;
  const { workflows } = workflowAuthoringListSchema.parse(data);
  return {
    workflows: workflows.slice(0, 50),
    nextAfterId: workflows.length > 50 ? workflows[49]?.workflowId : undefined,
  };
}

export async function createWorkflowAuthoring(admin: Client, scope: Author, displayName: string) {
  const { data, error } = await admin.rpc("create_factory_workflow_authoring", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_actor_user_id: scope.actorUserId,
    p_workflow_id: scope.workflowId,
    p_display_name: displayName,
  });
  if (error) throw error;
  return createWorkflowAuthoringSchema.parse({ workflowId: data, displayName });
}

export async function readWorkflowAuthoring(
  client: Client,
  scope: WorkflowScope,
  draftId?: string,
) {
  const { data, error } = await client.rpc("read_factory_workflow_authoring", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_workflow_id: scope.workflowId,
    ...(draftId ? { p_selected_draft_id: draftId } : {}),
  });
  if (error) throw error;
  return data ? workflowAuthoringSnapshotSchema.parse(data) : null;
}

async function compileScopedWorkflow(
  admin: Client,
  scope: WorkflowScope,
  base: WorkflowBaseDefinition,
  input: unknown,
) {
  const { workspaceId, factoryId } = scope;
  const source = { kind: "structured", value: input } as const;
  const parsed = workflowGraphSchema.safeParse(input);
  if (!parsed.success) {
    return compileWorkflowGraph(source, { workspaceId, agentPromptRevisions: [], approvers: [] });
  }
  const graph = parsed.data;
  const { data: revision, error } = await admin
    .from("factory_definition_revisions")
    .select("definition_json")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .eq("id", base.revisionId)
    .eq("canonical_digest", base.digest)
    .maybeSingle();
  if (error) throw error;
  const definition =
    revision && readVerifiedFactoryDefinition(revision.definition_json, base.digest);
  if (!definition) return null;

  const { executionGrant, repositoryId, executionPolicyRevisionId } = definition;
  const [references, grantResult] = await Promise.all([
    loadWorkflowGraphReferences(admin, { workspaceId, factoryId, graph }),
    executionGrant && repositoryId && executionPolicyRevisionId && graph.grants.length
      ? admin
          .from("factory_execution_grants")
          .select("id, version, workspace_id")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .eq("id", executionGrant.id)
          .eq("version", executionGrant.version)
          .eq("github_repository_id", repositoryId)
          .eq("execution_policy_revision_id", executionPolicyRevisionId)
          .is("revoked_at", null)
          .gt("expires_at", new Date().toISOString())
          .contains("read_context_repository_ids", definition.readContextRepositoryIds ?? [])
          .contains("tool_ids", definition.toolIds)
          .maybeSingle()
      : { data: null, error: null },
  ]);
  if (grantResult.error) throw grantResult.error;
  const grant = grantResult.data;
  return compileWorkflowGraph(source, {
    workspaceId,
    ...references,
    approvedGrants: grant
      ? [{ id: grant.id, version: grant.version, workspaceId: grant.workspace_id }]
      : [],
  });
}

function sameBase(left: WorkflowBaseDefinition | null, right: WorkflowBaseDefinition) {
  return (
    left?.activationId === right.activationId &&
    left.revisionId === right.revisionId &&
    left.digest === right.digest
  );
}

function workflowAuthoringFingerprint(command: WorkflowAuthoringCommand) {
  if (command.action === "publish") return serializeFactoryDefinition(command).canonicalDigest;
  const graph = workflowGraphSchema.safeParse(command.graph);
  return graph.success
    ? serializeFactoryDefinition({ ...command, graph: graph.data }).canonicalDigest
    : null;
}

export async function mutateWorkflowAuthoring(
  reader: Client,
  createAdmin: () => Client,
  scope: Author,
  command: WorkflowAuthoringCommand,
) {
  // The same signed-in, scoped read covers exact historical selection and current manager authority.
  const snapshot = await readWorkflowAuthoring(
    reader,
    scope,
    command.action === "publish" ? command.expected.draftId : undefined,
  );
  if (!snapshot) return { ok: false, status: 404, error: "Workflow draft not found." } as const;
  const { baseDefinition: base } = command.expected;
  const admin = createAdmin();
  const requestFingerprint = workflowAuthoringFingerprint(command);
  if (requestFingerprint) {
    const { data, error } = await admin.rpc("find_factory_workflow_authoring_receipt", {
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_workflow_id: scope.workflowId,
      p_actor_user_id: scope.actorUserId,
      p_request_id: command.requestId,
      p_action: command.action,
      p_request_fingerprint: requestFingerprint,
    });
    if (error) throw error;
    if (data) {
      return command.action === "save"
        ? ({ ok: true, action: "save", receipt: workflowSaveReceiptSchema.parse(data) } as const)
        : ({
            ok: true,
            action: "publish",
            receipt: workflowPublishReceiptSchema.parse(data),
          } as const);
    }
  }
  if (command.action === "publish" && !sameBase(snapshot.selectedDraftBaseDefinition, base)) {
    return {
      ok: false,
      status: 409,
      error: "Rebase the workflow draft before publication.",
    } as const;
  }
  const graph = command.action === "save" ? command.graph : snapshot.selectedDraftGraph;
  const compiled = await compileScopedWorkflow(admin, scope, base, graph);
  if (!compiled)
    return {
      ok: false,
      status: 409,
      error: "The workflow base definition is unavailable.",
    } as const;
  if (!compiled.ok) {
    return {
      ok: false,
      status: 422,
      error: "Resolve the workflow diagnostics.",
      diagnostics: compiled.diagnostics,
    } as const;
  }
  if (!requestFingerprint) throw new Error("The compiled workflow command has no fingerprint.");
  const expected = {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_workflow_id: scope.workflowId,
    p_actor_user_id: scope.actorUserId,
    p_request_id: command.requestId,
    p_request_fingerprint: requestFingerprint,
    p_expected_base_activation_id: base.activationId,
    p_expected_base_revision_id: base.revisionId,
    p_expected_base_digest: base.digest,
    ...(command.expected.activationId
      ? { p_expected_activation_id: command.expected.activationId }
      : {}),
  };
  if (command.action === "save") {
    const { data, error } = await admin.rpc("save_factory_workflow_authoring_draft", {
      ...expected,
      ...(command.expected.draftId ? { p_expected_draft_id: command.expected.draftId } : {}),
      p_workflow_json: compiled.definitionJson,
      p_workflow_digest: compiled.canonicalDigest,
      p_rebase: command.rebase,
    });
    if (error) throw error;
    return { ok: true, action: "save", receipt: workflowSaveReceiptSchema.parse(data) } as const;
  }
  if (compiled.canonicalDigest !== snapshot.selectedDraftDigest) {
    return {
      ok: false,
      status: 409,
      error: "The recompiled workflow does not match the saved draft.",
    } as const;
  }
  const { data, error } = await admin.rpc("publish_factory_workflow_authoring_draft", {
    ...expected,
    p_expected_draft_id: command.expected.draftId,
    p_verified_draft_digest: compiled.canonicalDigest,
  });
  if (error) throw error;
  return {
    ok: true,
    action: "publish",
    receipt: workflowPublishReceiptSchema.parse(data),
  } as const;
}

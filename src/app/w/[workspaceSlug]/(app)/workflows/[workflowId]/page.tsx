import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import {
  loadWorkflowAuthoringPageScope,
  loadWorkflowEditorChoices,
} from "@/features/factory-workflows/authoring-page-data";
import { WorkflowEditor } from "@/features/factory-workflows/workflow-editor";
import { readWorkflowAuthoring } from "@/lib/factory-workflows/authoring";
import { workflowAuthoringApiPath, workspaceWorkflowDetailPath } from "@/lib/routes";

const id = z.string().uuid().toLowerCase();

export default async function WorkflowEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string; workflowId: string }>;
  searchParams: Promise<{ factory?: string | string[]; draft?: string | string[] }>;
}) {
  const [{ workspaceSlug, workflowId }, query] = await Promise.all([params, searchParams]);
  const workflow = id.safeParse(workflowId);
  const draft = id.optional().safeParse(query.draft);
  if (!workflow.success || !draft.success) notFound();
  const pageScope = await loadWorkflowAuthoringPageScope(workspaceSlug, query.factory);
  const { factoryId, workspaceId, supabase } = pageScope;
  if (query.factory === undefined) {
    redirect(
      workspaceWorkflowDetailPath(workspaceSlug, workflow.data, {
        factory: factoryId,
        draft: draft.data,
      }),
    );
  }
  const snapshot = await readWorkflowAuthoring(
    supabase,
    { factoryId, workspaceId, workflowId: workflow.data },
    draft.data,
  );
  if (!snapshot) notFound();
  const choices = await loadWorkflowEditorChoices(
    pageScope,
    snapshot.baseDefinition,
    snapshot.template,
    snapshot.selectedDraftGraph ?? snapshot.graph,
  );
  return (
    <WorkflowEditor
      key={`${factoryId}:${workflow.data}:${draft.data ?? "current"}`}
      initial={snapshot}
      choices={choices}
      workspaceSlug={workspaceSlug}
      factoryId={factoryId}
      recoveryOwner={pageScope.user.id}
      endpoint={workflowAuthoringApiPath(workspaceId, factoryId, workflow.data)}
    />
  );
}

import { z } from "zod";

import {
  factoryEditorPost,
  fetchFactoryEditor,
} from "@/features/factory-definition/editor-requests";
import {
  workflowAuthoringEditorSchema,
  workflowAuthoringSnapshotSchema,
  workflowPublishReceiptSchema,
  workflowReferencePageSchema,
  workflowSaveReceiptSchema,
  type WorkflowAuthoringCommand,
  type WorkflowAuthoringSnapshot,
  type WorkflowBaseDefinition,
  type WorkflowReferenceCursor,
  type WorkflowReferenceKind,
} from "@/lib/factory-workflows/authoring-contracts";

const receiptSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), receipt: workflowSaveReceiptSchema }),
  z.object({ action: z.literal("publish"), receipt: workflowPublishReceiptSchema }),
]);

export function loadWorkflowAuthoringSnapshot(endpoint: string, draftId?: string) {
  return fetchFactoryEditor(
    draftId ? `${endpoint}?${new URLSearchParams({ draftId })}` : endpoint,
    workflowAuthoringSnapshotSchema,
  );
}

export function loadCurrentWorkflowEditor(endpoint: string) {
  return fetchFactoryEditor(`${endpoint}?includeChoices=true`, workflowAuthoringEditorSchema);
}

export async function loadMoreWorkflowReferences(
  endpoint: string,
  catalog: WorkflowReferenceKind,
  cursor: WorkflowReferenceCursor,
) {
  const query = new URLSearchParams({ catalog, afterId: cursor.id });
  if ("createdAt" in cursor) query.set("afterCreatedAt", cursor.createdAt);
  const page = await fetchFactoryEditor(`${endpoint}?${query}`, workflowReferencePageSchema);
  if (page.catalog !== catalog) throw new Error("The workflow reference page could not be loaded.");
  return page;
}

export function sameWorkflowEditorBase(
  previous: WorkflowBaseDefinition | null,
  next: WorkflowBaseDefinition | null,
) {
  return (
    previous === next ||
    (previous?.activationId === next?.activationId &&
      previous?.revisionId === next?.revisionId &&
      previous?.digest === next?.digest)
  );
}

export function workflowDraftNeedsRebase(snapshot: WorkflowAuthoringSnapshot) {
  return Boolean(
    snapshot.draftId &&
    snapshot.draftBaseDefinition?.activationId !== snapshot.baseDefinition?.activationId,
  );
}

/** Retain the same command (including request ID) until its receipt is observed. */
export async function submitWorkflowAuthoringCommand(
  endpoint: string,
  workflowId: string,
  command: WorkflowAuthoringCommand,
) {
  const result = await fetchFactoryEditor(endpoint, receiptSchema, factoryEditorPost(command));
  const snapshot = await loadWorkflowAuthoringSnapshot(endpoint, result.receipt.draftId);
  if (
    result.action !== command.action ||
    snapshot.workflowId !== workflowId ||
    snapshot.selectedDraftId !== result.receipt.draftId ||
    snapshot.selectedDraftDigest !== result.receipt.digest
  ) {
    throw new Error("Could not reconcile the exact workflow revision with its receipt.");
  }
  const expectedActivationId =
    result.action === "publish" ? result.receipt.activationId : command.expected.activationId;
  const moved =
    snapshot.draftId !== result.receipt.draftId ||
    !sameWorkflowEditorBase(snapshot.baseDefinition, command.expected.baseDefinition) ||
    snapshot.activationId !== expectedActivationId;
  return { result, snapshot, moved };
}

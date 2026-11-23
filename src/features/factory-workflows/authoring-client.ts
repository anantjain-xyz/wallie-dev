import { z } from "zod";

import {
  factoryEditorPost,
  fetchFactoryEditor,
} from "@/features/factory-definition/editor-requests";
import {
  workflowAuthoringSnapshotSchema,
  workflowPublishReceiptSchema,
  workflowSaveReceiptSchema,
  type WorkflowAuthoringCommand,
  type WorkflowAuthoringSnapshot,
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
  const moved =
    snapshot.draftId !== result.receipt.draftId ||
    (result.action === "publish" && snapshot.activationId !== result.receipt.activationId);
  return { result, snapshot, moved };
}

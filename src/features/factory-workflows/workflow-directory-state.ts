import {
  workflowTemplates,
  type WorkflowTemplateRevision,
} from "@/lib/factory-workflows/workflow-templates";
import type { loadWorkflowTemplatePrerequisites } from "@/lib/factory-workflows/reference-catalog";

export type WorkflowTemplatePrerequisites = Awaited<
  ReturnType<typeof loadWorkflowTemplatePrerequisites>
>;

export function workflowTemplateBlocker(
  prerequisites: WorkflowTemplatePrerequisites,
  templateId?: WorkflowTemplateRevision["id"],
) {
  if (prerequisites.state === "no-definition") {
    return templateId
      ? "Activate a factory definition before configuring or publishing."
      : "Activate a factory definition before editing or publishing.";
  }
  if (!templateId) return null;
  if (prerequisites.state === "missing-references") {
    return "The active definition needs a named implementation agent, primary repository, credential, execution grant, and at least one stage.";
  }
  if (templateId === "product-delivery" && !prerequisites.canDraftProductScope) {
    return "Product delivery needs one specification stage and a compatible delivery policy.";
  }
  if (templateId !== "incident-analysis" && !prerequisites.hasRequiredEvidence) {
    return "Pin a delivery policy that requires validation evidence before configuring this template.";
  }
  return null;
}

export function workflowTemplateLabel(template: WorkflowTemplateRevision | null) {
  if (!template) return "Blank workflow";
  return `${workflowTemplates.find(({ id }) => id === template.id)?.label} · v${template.version}`;
}

export function workflowDirectoryAvailability(
  intake: "eligible" | "definition_changed" | "unavailable" | undefined,
  { isDefault, setupRequired }: { isDefault: boolean; setupRequired: boolean },
) {
  if (!intake) return { canLaunch: false, message: "Publish a draft to start new sessions." };
  if (intake === "definition_changed") {
    return { canLaunch: false, message: "Factory definition changed. Rebase and publish a draft." };
  }
  if (intake === "unavailable") {
    return {
      canLaunch: false,
      message: "Unavailable under the current factory intake configuration.",
    };
  }
  if (!isDefault) {
    return {
      canLaunch: false,
      message: "The session launcher only supports the workspace’s default factory.",
    };
  }
  if (setupRequired) {
    return { canLaunch: false, message: "Finish workspace setup before starting sessions." };
  }
  return { canLaunch: true, message: "Available in New session." };
}

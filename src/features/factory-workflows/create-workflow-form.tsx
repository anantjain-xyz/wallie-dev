"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { z } from "zod";

import { SelectField } from "@/components/ui/select";
import {
  factoryEditorPost,
  fetchFactoryEditor,
} from "@/features/factory-definition/editor-requests";
import { createWorkflowAuthoringSchema } from "@/lib/factory-workflows/authoring-contracts";
import { workflowTemplates } from "@/lib/factory-workflows/workflow-templates";
import { workspaceWorkflowDetailPath } from "@/lib/routes";

import {
  workflowTemplateBlocker,
  type WorkflowTemplatePrerequisites,
} from "./workflow-directory-state";

const receipt = z.object({ workflow: createWorkflowAuthoringSchema });
const templateDescriptions = {
  "product-delivery": "Approve a specification, route the work, then deliver and review it.",
  "scoped-fix": "Start with an agreed scope and run implementation, support, and review.",
  "incident-analysis": "Route an existing analysis for human review.",
};

export function CreateWorkflowForm({
  endpoint,
  factoryId,
  workspaceSlug,
  prerequisites,
  setupHref,
}: {
  endpoint: string;
  factoryId: string;
  workspaceSlug: string;
  prerequisites: WorkflowTemplatePrerequisites;
  setupHref?: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<z.input<typeof createWorkflowAuthoringSchema> | null>(null);
  const template = workflowTemplates.find(({ id }) => id === templateId);
  const prerequisite = workflowTemplateBlocker(prerequisites, template?.id);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !name.trim()) return;
    const displayName = name.trim();
    const command =
      attempt.current?.displayName === displayName && attempt.current.template?.id === template?.id
        ? attempt.current
        : {
            displayName,
            workflowId: crypto.randomUUID(),
            ...(template ? { template: { id: template.id, version: template.version } } : {}),
          };
    attempt.current = command;
    setPending(true);
    setError("");
    try {
      const { workflow } = await fetchFactoryEditor(endpoint, receipt, factoryEditorPost(command));
      router.push(
        workspaceWorkflowDetailPath(workspaceSlug, workflow.workflowId, { factory: factoryId }),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The workflow could not be created.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={create} className="grid max-w-xl gap-3">
      <SelectField
        aria-describedby="workflow-template-help"
        label="Start from"
        options={workflowTemplates.map(({ id, label, version }) => ({
          label: `${label} · v${version}`,
          value: id,
        }))}
        emptyOption={{ label: "Blank workflow", value: "" }}
        value={templateId}
        onValueChange={setTemplateId}
        disabled={pending}
        wrap
      />
      <div
        id="workflow-template-help"
        className="type-secondary space-y-1 text-muted"
        aria-live="polite"
      >
        <p>{template ? templateDescriptions[template.id] : "Build the workflow from scratch."}</p>
        {prerequisite ? (
          <>
            <p className="text-warning">{prerequisite}</p>
            <p>
              Creating now saves a placeholder.{" "}
              {setupHref ? (
                <Link className="underline underline-offset-4" href={setupHref}>
                  Open Factory Definition
                </Link>
              ) : (
                "Ask a workspace owner or admin to update this factory’s definition."
              )}
            </p>
          </>
        ) : template ? (
          <p>Choose compatible roles and save a draft in the editor before publishing.</p>
        ) : null}
      </div>
      <label htmlFor="workflow-name" className="type-label">
        Workflow name
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="workflow-name"
          className="ui-input min-w-0 flex-1"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          maxLength={120}
          required
          disabled={pending}
        />
        <button type="submit" className="ui-button-primary" disabled={pending || !name.trim()}>
          {pending ? "Creating…" : "Create workflow"}
        </button>
      </div>
      <p className="sr-only" role="status">
        {pending ? "Creating workflow…" : ""}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}

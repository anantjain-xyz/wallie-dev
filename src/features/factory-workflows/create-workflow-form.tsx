"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { z } from "zod";

import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
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

export function CreateWorkflowDialog({
  endpoint,
  factoryId,
  factoryName,
  workspaceSlug,
  prerequisites,
  setupHref,
}: {
  endpoint: string;
  factoryId: string;
  factoryName: string;
  workspaceSlug: string;
  prerequisites: WorkflowTemplatePrerequisites;
  setupHref?: string;
}) {
  const router = useRouter();
  const helpId = useId();
  const nameId = `${helpId}-name`;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [invalidName, setInvalidName] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [createdHref, setCreatedHref] = useState<string | null>(null);
  const attempt = useRef<z.input<typeof createWorkflowAuthoringSchema> | null>(null);
  const template = workflowTemplates.find(({ id }) => id === templateId);
  const prerequisite = workflowTemplateBlocker(prerequisites, template?.id);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const displayName = name.trim();
    if (!displayName) {
      setInvalidName(true);
      event.currentTarget.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
      return;
    }
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
      const href = workspaceWorkflowDetailPath(workspaceSlug, workflow.workflowId, {
        factory: factoryId,
      });
      setCreatedHref(href);
      setName("");
      setTemplateId("");
      attempt.current = null;
      router.push(href);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The workflow could not be created.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) setCreatedHref(null);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <button className="ui-button ui-button-primary" type="button">
          New workflow
        </button>
      </DialogTrigger>
      <DialogContent
        description={
          <>
            {createdHref ? "Saved in " : "Create an unpublished graph workflow in "}
            <strong className="wrap-anywhere">{factoryName}</strong>.
          </>
        }
        dismissible={!pending}
        title={createdHref ? "Workflow created" : "New workflow"}
      >
        {createdHref ? (
          <div className="space-y-4">
            <p className="type-secondary text-muted" role="status">
              This workflow isn’t published.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <DialogClose className="ui-button">Close</DialogClose>
              <Link className="ui-button ui-button-primary" href={createdHref}>
                Open editor
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={create} className="grid gap-4">
            <div className="space-y-1.5">
              <label className="block type-label" htmlFor={nameId}>
                Workflow name
              </label>
              <input
                aria-describedby={invalidName ? `${nameId}-error` : undefined}
                aria-invalid={invalidName || undefined}
                autoComplete="off"
                className="ui-input"
                id={nameId}
                name="name"
                value={name}
                onChange={(event) => {
                  setName(event.currentTarget.value);
                  setInvalidName(false);
                }}
                maxLength={120}
                required
                disabled={pending}
              />
              {invalidName ? (
                <p className="type-annotation text-danger" id={`${nameId}-error`} role="alert">
                  Enter a workflow name.
                </p>
              ) : null}
            </div>
            <SelectField
              aria-describedby={helpId}
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
            <div id={helpId} className="type-secondary space-y-1 text-muted" aria-live="polite">
              {template ? <p>{templateDescriptions[template.id]}</p> : null}
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
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <DialogClose asChild>
                <button className="ui-button" disabled={pending} type="button">
                  Close
                </button>
              </DialogClose>
              <button type="submit" className="ui-button ui-button-primary" disabled={pending}>
                {pending ? "Creating…" : "Create workflow"}
              </button>
            </div>
            <p className="sr-only" role="status">
              {pending ? "Creating workflow…" : ""}
            </p>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

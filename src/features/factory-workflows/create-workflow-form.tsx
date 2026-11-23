"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { z } from "zod";

import {
  factoryEditorPost,
  fetchFactoryEditor,
} from "@/features/factory-definition/editor-requests";
import { createWorkflowAuthoringSchema } from "@/lib/factory-workflows/authoring-contracts";
import { workspaceWorkflowDetailPath } from "@/lib/routes";

const receipt = z.object({ workflow: createWorkflowAuthoringSchema });

export function CreateWorkflowForm({
  endpoint,
  factoryId,
  workspaceSlug,
}: {
  endpoint: string;
  factoryId: string;
  workspaceSlug: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<{ workflowId: string; displayName: string } | null>(null);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !name.trim()) return;
    const displayName = name.trim();
    const command =
      attempt.current?.displayName === displayName
        ? attempt.current
        : { displayName, workflowId: crypto.randomUUID() };
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
    <form onSubmit={create} className="grid max-w-lg gap-2">
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
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}

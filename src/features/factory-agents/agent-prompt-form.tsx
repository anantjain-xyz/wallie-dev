"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { z } from "zod";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  createFactoryAgentSchema,
  saveFactoryAgentPromptSchema,
} from "@/lib/factory-agents/contracts";
import { workspaceAgentDetailPath } from "@/lib/routes";

const responseSchema = z.object({
  revision: z.object({ id: z.string().uuid(), agent_id: z.string().uuid() }),
});
type PromptForm =
  | { kind: "create" }
  | { kind: "revise"; agentId: string; prompt: string; revision: number };
type PromptCommand =
  | z.output<typeof createFactoryAgentSchema>
  | z.output<typeof saveFactoryAgentPromptSchema>;

export function AgentPromptForm({
  workspaceId,
  workspaceSlug,
  factoryId,
  form,
}: {
  workspaceId: string;
  workspaceSlug: string;
  factoryId: string;
  form: PromptForm;
}) {
  const router = useRouter();
  const identifierId = useId();
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const agents = `/api/workspaces/${workspaceId}/factories/${factoryId}/agents`;
  const create = form.kind === "create";
  const endpoint = create ? agents : `${agents}/${form.agentId}/prompt-revisions`;
  const action = useApiAction<unknown, [PromptCommand]>({
    call: async (command) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      if (response.status === 409) {
        return Response.json(
          {
            error: create
              ? "Choose a unique agent identifier."
              : "The prompt changed. Reload its latest revision before saving.",
          },
          { status: 409 },
        );
      }
      return response;
    },
    errorText: create ? "Could not create the agent." : "Could not save the prompt revision.",
    setFlashMessage: setMessage,
    onSuccess(payload) {
      const result = responseSchema.safeParse(payload);
      if (!result.success) throw new Error("Could not read the saved prompt revision.");
      const { revision } = result.data;
      router.push(
        workspaceAgentDetailPath(workspaceSlug, revision.agent_id, {
          factory: factoryId,
          revision: revision.id,
        }),
      );
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const promptMd = fields.get("prompt");
    const result =
      form.kind === "create"
        ? createFactoryAgentSchema.safeParse({
            name: fields.get("name"),
            slug: fields.get("slug"),
            promptMd,
          })
        : saveFactoryAgentPromptSchema.safeParse({
            expectedRevisionNumber: form.revision,
            promptMd,
          });
    if (!result.success) {
      const problem = result.error.issues[0];
      const text =
        problem.path[0] === "name"
          ? "Provide an agent name."
          : problem.path[0] === "slug"
            ? "Use a lowercase identifier with letters, numbers, and hyphens."
            : problem.message;
      setMessage({ kind: "error", text });
      return;
    }
    setMessage(null);
    void action.run(result.data);
  }

  return (
    <form className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5" onSubmit={submit}>
      <InlineActionMessage message={message} />
      <fieldset aria-busy={action.isBusy} className="min-w-0 space-y-4" disabled={action.isBusy}>
        <legend className="sr-only">{create ? "Agent details" : "Prompt details"}</legend>
        {create && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block min-w-0 space-y-1.5">
              <span className="type-label text-foreground">Agent name</span>
              <input className="ui-input" name="name" maxLength={120} required />
            </label>
            <div className="min-w-0 space-y-1.5">
              <label className="block type-label text-foreground" htmlFor={identifierId}>
                Identifier
              </label>
              <input
                aria-describedby={`${identifierId}-help`}
                className="ui-input"
                id={identifierId}
                name="slug"
                maxLength={60}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                required
              />
              <p className="type-annotation text-muted" id={`${identifierId}-help`}>
                Use lowercase letters, numbers, and hyphens.
              </p>
            </div>
          </div>
        )}
        <label className="block min-w-0 space-y-1.5">
          <span className="type-label text-foreground">Implementation prompt</span>
          <textarea
            className="ui-textarea font-mono"
            defaultValue={create ? "" : form.prompt}
            name="prompt"
            rows={6}
          />
        </label>
        <button className="ui-button ui-button-primary" type="submit">
          <ActionButtonLabel
            idle={create ? "Create agent" : "Save prompt revision"}
            pending={action.isBusy}
            pendingLabel={create ? "Creating…" : "Saving…"}
          />
        </button>
      </fieldset>
    </form>
  );
}

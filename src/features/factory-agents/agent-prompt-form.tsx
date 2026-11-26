"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent } from "react";
import { z } from "zod";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { useToast } from "@/components/ui/toast";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  createFactoryAgentSchema,
  saveFactoryAgentPromptSchema,
} from "@/lib/factory-agents/contracts";

import { useDirectoryDraftStatus } from "./agent-directory-draft";
import { agentPromptPath } from "./agent-navigation";

const revisionSchema = z.object({
  id: z.string().uuid(),
  agent_id: z.string().uuid(),
  revision_number: z.number().int().positive(),
});
const responseSchema = z.object({ revision: revisionSchema });
const latestSchema = z.object({
  revisions: z.array(revisionSchema.extend({ prompt_md: z.string() })).min(1),
});
type PromptForm =
  | { kind: "create" }
  | { kind: "revise"; agentId: string; prompt: string; revision: number };
type PromptCommand =
  | z.output<typeof createFactoryAgentSchema>
  | z.output<typeof saveFactoryAgentPromptSchema>;

function suggestAgentIdentifier(name: string) {
  if (!name.trim()) return "";
  return (
    name
      .normalize("NFKD")
      .replace(/\p{Mark}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-/, "")
      .slice(0, 60)
      .replace(/-$/, "") || "agent"
  );
}

export function AgentPromptForm({
  workspaceId,
  workspaceSlug,
  factoryId,
  form,
  listQuery,
}: {
  workspaceId: string;
  workspaceSlug: string;
  factoryId: string;
  form: PromptForm;
  listQuery?: { q?: string; after?: string };
}) {
  const router = useRouter();
  const { pushToast } = useToast();
  const identifierId = useId();
  const baseHelpId = useId();
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [name, setName] = useState("");
  const [editedIdentifier, setEditedIdentifier] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ prompt: string; basedOn: number } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [loadedLatest, setLoadedLatest] = useState<{ prompt: string; revision: number } | null>(
    null,
  );
  const agents = `/api/workspaces/${workspaceId}/factories/${factoryId}/agents`;
  const create = form.kind === "create";
  const endpoint = create ? agents : `${agents}/${form.agentId}/prompt-revisions`;
  const latest = create
    ? null
    : loadedLatest && loadedLatest.revision > form.revision
      ? loadedLatest
      : form;
  const basedOn = draft?.basedOn ?? latest?.revision ?? 0;
  const prompt = draft?.prompt ?? latest?.prompt ?? "";
  const slug = editedIdentifier ?? suggestAgentIdentifier(name);
  const needsReview = Boolean(latest && latest.revision > basedOn);
  const dirty = Boolean(draft || name || editedIdentifier !== null);
  useDirectoryDraftStatus(dirty);

  useEffect(() => {
    if (!dirty) return;
    function warnOnUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "Unsaved agent draft";
    }
    function guardLink(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        !(event.target instanceof Element)
      )
        return;
      const link = event.target.closest("a[href]");
      if (
        !(link instanceof HTMLAnchorElement) ||
        link.hasAttribute("download") ||
        (link.target && link.target !== "_self")
      )
        return;
      const destination = new URL(link.href);
      if (destination.origin !== window.location.origin) return;
      if (
        destination.pathname === window.location.pathname &&
        (destination.searchParams.get("factory") ?? factoryId) === factoryId
      )
        return;
      if (window.confirm("Leave without saving your agent draft?")) return;
      event.preventDefault();
      event.stopPropagation();
    }
    window.addEventListener("beforeunload", warnOnUnload);
    document.addEventListener("click", guardLink, true);
    return () => {
      window.removeEventListener("beforeunload", warnOnUnload);
      document.removeEventListener("click", guardLink, true);
    };
  }, [dirty, factoryId]);

  const review = useApiAction<unknown>({
    call: () => fetch(`${endpoint}?limit=1`, { cache: "no-store" }),
    errorText: "Could not load the latest revision. Your draft is still here; try again.",
    setFlashMessage: setMessage,
    onSuccess(payload) {
      const result = latestSchema.safeParse(payload);
      const latestRow = result.data?.revisions[0];
      if (
        form.kind !== "revise" ||
        latestRow?.agent_id !== form.agentId ||
        latestRow.revision_number <= basedOn
      )
        throw new Error("Could not find a newer revision. Your draft is still here; try again.");
      setLoadedLatest({ prompt: latestRow.prompt_md, revision: latestRow.revision_number });
      setMessage(null);
    },
  });

  const action = useApiAction<unknown, [PromptCommand]>({
    call: async (command) => {
      const post = (body: PromptCommand) =>
        fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      let response = await post(command);
      if (response.status === 409 && "slug" in command && editedIdentifier === null) {
        const suffix = crypto.randomUUID().slice(0, 8);
        response = await post({
          ...command,
          slug: `${command.slug.slice(0, 51).replace(/-$/, "")}-${suffix}`,
        });
      }
      if (response.status === 409) {
        if ("expectedRevisionNumber" in command) {
          setDraft({ prompt: command.promptMd, basedOn: command.expectedRevisionNumber });
          setConflict(true);
        }
        return Response.json(
          {
            error: create
              ? "Choose a unique agent identifier."
              : "A newer revision was saved. Your draft is unchanged. Review the latest revision before trying again.",
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
      setDraft(null);
      setName("");
      setEditedIdentifier(null);
      pushToast({
        title: `Revision ${revision.revision_number} saved. Not published.`,
        tone: "success",
      });
      router.push(
        agentPromptPath(workspaceSlug, revision.agent_id, {
          factory: factoryId,
          ...listQuery,
          revision: revision.id,
        }),
      );
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (conflict || needsReview) return;
    const result =
      form.kind === "create"
        ? createFactoryAgentSchema.safeParse({ name, slug, promptMd: prompt })
        : saveFactoryAgentPromptSchema.safeParse({
            expectedRevisionNumber: basedOn,
            promptMd: prompt,
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
      <fieldset
        aria-busy={action.isBusy || review.isBusy}
        className="min-w-0 space-y-4"
        disabled={action.isBusy || review.isBusy}
      >
        <legend className="sr-only">{create ? "Agent details" : "Prompt details"}</legend>
        {!create && (
          <p className="type-secondary text-muted" id={baseHelpId}>
            <span className="font-semibold text-foreground">
              Create a revision from Revision {basedOn}.
            </span>{" "}
            Saving doesn’t publish. A workspace operator publishes from Factory Definition.
          </p>
        )}
        {(conflict || needsReview) && (
          <div className="space-y-3 border-b border-border pb-4">
            {needsReview && latest ? (
              <>
                <p className="font-semibold text-foreground">
                  Latest saved prompt · Revision {latest.revision}
                </p>
                {latest.prompt ? (
                  <pre
                    className="max-h-56 overflow-auto whitespace-pre-wrap text-sm [overflow-wrap:anywhere]"
                    tabIndex={0}
                  >
                    {latest.prompt}
                  </pre>
                ) : (
                  <p className="type-secondary text-muted">Empty prompt.</p>
                )}
                <p className="type-secondary text-muted">
                  Compare it with your draft below. Your text won’t change when you update the base.
                </p>
                <button
                  className="ui-button"
                  onClick={() => {
                    setDraft({ prompt, basedOn: latest.revision });
                    setConflict(false);
                    setMessage({
                      kind: "success",
                      text: `Draft kept. Review it, then save from Revision ${latest.revision}.`,
                    });
                  }}
                  type="button"
                >
                  Keep draft and use Revision {latest.revision}
                </button>
              </>
            ) : (
              <button className="ui-button" onClick={() => void review.run()} type="button">
                <ActionButtonLabel
                  idle="Load latest revision"
                  pending={review.isBusy}
                  pendingLabel="Loading latest revision…"
                />
              </button>
            )}
          </div>
        )}
        {create && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block min-w-0 space-y-1.5">
              <span className="type-label text-foreground">Agent name</span>
              <input
                autoComplete="off"
                className="ui-input"
                name="name"
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                required
                value={name}
              />
            </label>
            <div className="min-w-0 space-y-1.5">
              <label className="block type-label text-foreground" htmlFor={identifierId}>
                Identifier
              </label>
              <input
                aria-describedby={`${identifierId}-help`}
                autoComplete="off"
                className="ui-input"
                id={identifierId}
                name="slug"
                maxLength={60}
                onChange={(event) => setEditedIdentifier(event.target.value || null)}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                required
                spellCheck={false}
                value={slug}
              />
              <p className="type-annotation text-muted" id={`${identifierId}-help`}>
                Generated from the name. Edit this stable identifier before creating the agent if
                you want a different URL name.
              </p>
            </div>
          </div>
        )}
        <label className="block min-w-0 space-y-1.5">
          <span className="type-label text-foreground">Implementation prompt</span>
          <textarea
            aria-describedby={create ? undefined : baseHelpId}
            className="ui-textarea font-mono"
            name="prompt"
            onChange={(event) => {
              const text = event.target.value;
              setDraft(
                text === (latest?.prompt ?? "") && !conflict && !needsReview
                  ? null
                  : { prompt: text, basedOn },
              );
            }}
            rows={6}
            value={prompt}
          />
        </label>
        <button
          className="ui-button ui-button-primary"
          disabled={conflict || needsReview}
          type="submit"
        >
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

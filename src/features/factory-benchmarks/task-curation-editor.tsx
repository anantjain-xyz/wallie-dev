"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  benchmarkTaskMutationResultSchema,
  saveBenchmarkTaskSchema,
  type SaveBenchmarkTask,
} from "@/lib/factory-benchmarks/curation-contracts";

import { readBenchmarkTags } from "./curation-labels";
import type { BenchmarkTaskRevision } from "./suites-data";

export function TaskCurationEditor({
  workspaceId,
  factoryId,
  revision,
}: {
  workspaceId: string;
  factoryId: string;
  revision: BenchmarkTaskRevision;
}) {
  const router = useRouter();
  const tagInputId = useId();
  const [draftBase, setDraftBase] = useState<BenchmarkTaskRevision | null>(null);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [conflict, setConflict] = useState(false);
  const action = useApiAction<unknown, [SaveBenchmarkTask]>({
    async call(command) {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/factories/${factoryId}/benchmarks/tasks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        },
      );
      if (response.status === 409) setConflict(true);
      return response;
    },
    errorText: "Could not save the benchmark task revision.",
    setFlashMessage: setMessage,
    onSuccess(payload) {
      const result = benchmarkTaskMutationResultSchema.parse(payload);
      setMessage({ kind: "success", text: `Task revision ${result.revisionNumber} saved.` });
      setDraftBase(null);
      router.refresh();
    },
  });

  function closeDraft() {
    setDraftBase(null);
    setMessage(null);
    setConflict(false);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draftBase || conflict) return;
    const fields = new FormData(event.currentTarget);
    const parsed = saveBenchmarkTaskSchema.safeParse({
      taskId: draftBase.task_id,
      expectedRevisionId: draftBase.id,
      name: fields.get("name"),
      acceptanceCriteria: fields.get("acceptanceCriteria"),
      tags: readBenchmarkTags(fields.get("tags")),
    });
    if (!parsed.success) {
      setMessage({ kind: "error", text: "Enter a task name and acceptance criteria." });
      return;
    }
    setMessage(null);
    void action.run(parsed.data);
  }

  return (
    <div className="space-y-3">
      <InlineActionMessage message={message} />
      {draftBase ? (
        <form
          aria-label="Task criteria"
          className="space-y-4 rounded-md border border-border p-3 sm:p-4"
          onSubmit={submit}
        >
          <fieldset
            aria-busy={action.isBusy}
            className="min-w-0 space-y-4"
            disabled={action.isBusy}
          >
            <legend className="type-label text-foreground">Task criteria</legend>
            <p className="type-secondary text-muted">
              Editing task revision {draftBase.revision_number}. The suite keeps its saved revision
              until you change its membership.
            </p>
            <label className="block space-y-1.5">
              <span className="type-label">Task name</span>
              <input
                className="ui-input"
                name="name"
                defaultValue={draftBase.name}
                maxLength={120}
                required
              />
            </label>
            <label className="block space-y-1.5">
              <span className="type-label">Acceptance criteria</span>
              <textarea
                className="ui-textarea"
                name="acceptanceCriteria"
                defaultValue={draftBase.acceptance_criteria}
                maxLength={20_000}
                rows={5}
                required
              />
            </label>
            <div className="space-y-1.5">
              <label className="type-label block" htmlFor={tagInputId}>
                Task tags
              </label>
              <input
                aria-describedby={`${tagInputId}-help`}
                className="ui-input"
                id={tagInputId}
                name="tags"
                defaultValue={draftBase.tags.join(", ")}
              />
              <span className="type-secondary block text-muted" id={`${tagInputId}-help`}>
                Separate tags with commas.
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="ui-button ui-button-primary" type="submit" disabled={conflict}>
                <ActionButtonLabel
                  idle="Save task revision"
                  pending={action.isBusy}
                  pendingLabel="Saving…"
                />
              </button>
              {conflict ? (
                <button
                  className="ui-button"
                  type="button"
                  onClick={() => {
                    closeDraft();
                    router.refresh();
                  }}
                >
                  Reload latest revision
                </button>
              ) : (
                <button className="ui-button" type="button" onClick={closeDraft}>
                  Cancel
                </button>
              )}
            </div>
          </fieldset>
        </form>
      ) : (
        <button
          className="ui-button"
          type="button"
          onClick={() => {
            setMessage(null);
            setDraftBase(revision);
          }}
        >
          Edit task
        </button>
      )}
    </div>
  );
}

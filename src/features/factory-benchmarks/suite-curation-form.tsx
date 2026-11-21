"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  benchmarkSuiteMutationResultSchema,
  saveBenchmarkSuiteSchema,
  type SaveBenchmarkSuite,
} from "@/lib/factory-benchmarks/curation-contracts";
import { workspaceBenchmarkSuitePath } from "@/lib/routes";

import { benchmarkEligibilityLabel, readBenchmarkTags } from "./curation-labels";
import type { BenchmarkTaskChoice } from "./suites-data";

type SuiteDraft = {
  suiteId: string;
  revisionId: string;
  name: string;
  purpose: string;
  selectionTags: string[] | null;
  members: readonly BenchmarkTaskChoice[];
};

export function SuiteCurationForm({
  workspaceId,
  workspaceSlug,
  factoryId,
  taskChoices,
  draft,
}: {
  workspaceId: string;
  workspaceSlug: string;
  factoryId: string;
  taskChoices: readonly BenchmarkTaskChoice[];
  draft?: SuiteDraft;
}) {
  const router = useRouter();
  const fieldId = useId();
  const [mode, setMode] = useState<"explicit" | "tags">("explicit");
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [conflict, setConflict] = useState(false);
  const [picks, setPicks] = useState(
    () => new Map(draft?.members.map((task) => [task.task_id, task.id])),
  );
  const pinned = new Map(draft?.members.map((task) => [task.task_id, task]));
  const options = new Map(pinned);
  for (const task of taskChoices) options.set(task.task_id, task);

  const action = useApiAction<unknown, [SaveBenchmarkSuite]>({
    async call(command) {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/factories/${factoryId}/benchmarks/suites`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        },
      );
      if (response.status === 409) setConflict(true);
      return response;
    },
    errorText: "Could not save the benchmark suite.",
    setFlashMessage: setMessage,
    onSuccess(payload) {
      const result = benchmarkSuiteMutationResultSchema.parse(payload);
      router.push(
        workspaceBenchmarkSuitePath(workspaceSlug, result.suiteId, {
          factory: factoryId,
          revision: result.revisionId,
        }),
      );
    },
  });

  function pick(taskId: string, revisionId?: string) {
    setPicks((current) => {
      const next = new Map(current);
      if (revisionId) next.set(taskId, revisionId);
      else next.delete(taskId);
      return next;
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (conflict) return;
    const fields = new FormData(event.currentTarget);
    const parsed = saveBenchmarkSuiteSchema.safeParse({
      ...(draft ? { suiteId: draft.suiteId, expectedRevisionId: draft.revisionId } : {}),
      name: fields.get("name"),
      purpose: fields.get("purpose"),
      selection:
        mode === "explicit"
          ? { kind: "explicit", taskRevisionIds: [...picks.values()] }
          : { kind: "tags", tags: readBenchmarkTags(fields.get("tags")) },
    });
    if (!parsed.success) {
      setMessage({
        kind: "error",
        text: "Enter a suite name and at least one tag when matching by tags.",
      });
      return;
    }
    setMessage(null);
    void action.run(parsed.data);
  }

  return (
    <form
      aria-label={draft ? "Edit suite" : "New suite"}
      className="ui-sheet space-y-4 p-4 sm:p-5"
      onSubmit={submit}
    >
      <InlineActionMessage message={message} />
      {conflict && draft ? (
        <a
          className="ui-button"
          href={`${workspaceBenchmarkSuitePath(workspaceSlug, draft.suiteId, { factory: factoryId, edit: "suite" })}#edit-suite`}
        >
          Reload latest revision
        </a>
      ) : null}
      <fieldset aria-busy={action.isBusy} className="min-w-0 space-y-4" disabled={action.isBusy}>
        <legend className="sr-only">Suite details</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block min-w-0 space-y-1.5">
            <span className="type-label">Suite name</span>
            <input
              className="ui-input"
              name="name"
              defaultValue={draft?.name}
              maxLength={120}
              required
            />
          </label>
          <label className="block min-w-0 space-y-1.5">
            <span className="type-label">Suite purpose</span>
            <select
              className="ui-select"
              name="purpose"
              defaultValue={draft?.purpose ?? "regression"}
            >
              <option value="regression">Regression</option>
              <option value="holdout">Holdout</option>
            </select>
          </label>
        </div>
        <fieldset className="min-w-0 space-y-3">
          <legend className="type-label text-foreground">Task selection</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                className="accent-accent"
                name="selectionMode"
                type="radio"
                checked={mode === "explicit"}
                onChange={() => setMode("explicit")}
              />
              Choose tasks
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                className="accent-accent"
                name="selectionMode"
                type="radio"
                checked={mode === "tags"}
                onChange={() => setMode("tags")}
              />
              Match tags
            </label>
          </div>
          {mode === "tags" ? (
            <div className="space-y-1.5">
              <label className="type-label block" htmlFor={`${fieldId}-tags`}>
                Selection tags
              </label>
              <input
                aria-describedby={`${fieldId}-tag-help`}
                className="ui-input"
                id={`${fieldId}-tags`}
                name="tags"
                defaultValue={draft?.selectionTags?.join(", ")}
                required
              />
              <span id={`${fieldId}-tag-help`} className="type-secondary block text-muted">
                Separate tags with commas. Saving freezes the latest task revisions that match every
                tag.
              </span>
            </div>
          ) : options.size ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {[...options.values()].map((latest) => {
                const original = pinned.get(latest.task_id);
                const selected = picks.get(latest.task_id);
                const shown = selected === latest.id ? latest : (original ?? latest);
                const alternate = selected === latest.id ? original : latest;
                return (
                  <li className="min-w-0 px-3 py-2.5" key={latest.task_id}>
                    <label className="flex min-w-0 items-start gap-2.5">
                      <input
                        aria-label={`Include ${shown.name}`}
                        className="mt-1 shrink-0 accent-accent"
                        type="checkbox"
                        checked={!!selected}
                        onChange={(event) =>
                          pick(latest.task_id, event.target.checked ? shown.id : undefined)
                        }
                      />
                      <span className="min-w-0 space-y-1">
                        <span className="type-label block break-words text-foreground">
                          {shown.name}
                        </span>
                        <span className="type-annotation block break-words text-muted">
                          Revision {shown.revision_number} ·{" "}
                          {benchmarkEligibilityLabel(shown.replay_eligibility)}
                          {shown.tags.length ? ` · ${shown.tags.join(", ")}` : ""}
                        </span>
                      </span>
                    </label>
                    {selected && alternate && alternate.id !== shown.id ? (
                      <button
                        className="ui-button ml-6 mt-2"
                        onClick={() => pick(latest.task_id, alternate.id)}
                        type="button"
                      >
                        {`Use revision ${alternate.revision_number} for ${alternate.name}`}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="type-secondary text-muted">
              No benchmark tasks in this factory yet. Add a historical run to capture a task.
            </p>
          )}
        </fieldset>
        <button className="ui-button ui-button-primary" type="submit" disabled={conflict}>
          <ActionButtonLabel idle="Save suite" pending={action.isBusy} pendingLabel="Saving…" />
        </button>
      </fieldset>
    </form>
  );
}

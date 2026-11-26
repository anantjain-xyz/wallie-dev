"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { SelectField } from "@/components/ui/select";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  benchmarkSuiteMutationResultSchema,
  saveBenchmarkSuiteSchema,
  type SaveBenchmarkSuite,
} from "@/lib/factory-benchmarks/curation-contracts";
import {
  workspaceBenchmarksPath,
  workspaceBenchmarkSuitePath,
  workspaceRunsPath,
} from "@/lib/routes";

import { BenchmarkTaskSource } from "./benchmark-task-source";
import { benchmarkEligibilityLabel, readBenchmarkTags } from "./curation-labels";
import type { BenchmarkTaskChoice } from "./suites-data";

const purposes = [
  { label: "Regression", value: "regression" },
  { label: "Holdout", value: "holdout" },
];
type Mode = "explicit" | "tags" | "preserve";
type SuiteDraft = {
  suiteId: string;
  revisionId: string;
  name: string;
  purpose: string;
  selectionTags: string[] | null;
  members: readonly BenchmarkTaskChoice[];
};

function summarize(task: BenchmarkTaskChoice) {
  return `Revision ${task.revision_number} · ${benchmarkEligibilityLabel(task.replay_eligibility)}${task.tags.length ? ` · ${task.tags.join(", ")}` : ""}`;
}

export function SuiteCurationForm({
  workspaceId,
  workspaceSlug,
  factoryId,
  taskChoices: initialTaskChoices,
  draft,
  cancelHref,
  onDraftStatusChange,
}: {
  workspaceId: string;
  workspaceSlug: string;
  factoryId: string;
  taskChoices: readonly BenchmarkTaskChoice[];
  draft?: SuiteDraft;
  cancelHref?: string;
  onDraftStatusChange?: (status: "clean" | "dirty" | "saving") => void;
}) {
  const router = useRouter();
  const fieldId = useId();
  const nameField = useRef<HTMLInputElement>(null);
  const tagsField = useRef<HTMLInputElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const saved = useRef(false);
  const initialMode = draft?.selectionTags ? "preserve" : "explicit";
  const [mode, setMode] = useState<Mode>(initialMode);
  const [name, setName] = useState(draft?.name ?? "");
  const [purpose, setPurpose] = useState(draft?.purpose ?? "regression");
  const [tagsText, setTagsText] = useState("");
  const [chosenTags, setChosenTags] = useState(() => draft?.selectionTags ?? []);
  const [allowEmpty, setAllowEmpty] = useState(false);
  const [invalid, setInvalid] = useState<"name" | "tags" | null>(null);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [conflict, setConflict] = useState(false);
  const [previewStale, setPreviewStale] = useState(false);
  const [refreshedChoices, setRefreshedChoices] = useState<BenchmarkTaskChoice[] | null>(null);
  const taskChoices = refreshedChoices ?? initialTaskChoices;
  const [picks, setPicks] = useState(
    () => new Map(draft?.members.map((task) => [task.task_id, task])),
  );
  const pinned = new Map(draft?.members.map((task) => [task.task_id, task]));
  const options = new Map([...pinned, ...picks]);
  for (const task of taskChoices) options.set(task.task_id, task);
  const knownTags = [
    ...new Set([...chosenTags, ...taskChoices.flatMap(({ tags }) => tags)]),
  ].sort();
  const tags = [
    ...new Set([
      ...chosenTags,
      ...readBenchmarkTags(tagsText).map((tag) =>
        tag.replace(/[A-Z]/g, (letter) => letter.toLowerCase()),
      ),
    ]),
  ];
  const matches = tags.length
    ? taskChoices.filter((task) => tags.every((tag) => task.tags.includes(tag)))
    : [];
  const matchingTasks = new Set(matches.map(({ task_id }) => task_id));
  const removed = draft?.members.filter(({ task_id }) => !matchingTasks.has(task_id)) ?? [];
  const displayed = mode === "preserve" ? (draft?.members ?? []) : matches;
  const empty =
    mode === "explicit"
      ? picks.size === 0
      : mode === "tags" && tags.length > 0 && matches.length === 0;
  const dirty =
    name !== (draft?.name ?? "") ||
    purpose !== (draft?.purpose ?? "regression") ||
    mode !== initialMode ||
    tagsText !== "" ||
    chosenTags.join("\0") !== (draft?.selectionTags ?? []).join("\0") ||
    allowEmpty ||
    picks.size !== pinned.size ||
    [...picks].some(([id, task]) => pinned.get(id)?.id !== task.id);
  const selectionWord = mode === "tags" ? "matching" : mode === "preserve" ? "frozen" : "selected";
  const count = mode === "explicit" ? picks.size : displayed.length;
  const modeOptions: readonly [Mode, string][] = draft?.selectionTags
    ? [
        ["preserve", "Keep frozen selection"],
        ["tags", "Refresh tag matches"],
        ["explicit", "Switch to manually chosen tasks"],
      ]
    : [
        ["explicit", "Choose tasks"],
        ["tags", "Match tags"],
      ];
  const factory = { factory: factoryId };
  const catalog = workspaceBenchmarksPath(workspaceSlug, factory);
  const returnHref =
    cancelHref ??
    (draft
      ? workspaceBenchmarkSuitePath(workspaceSlug, draft.suiteId, {
          ...factory,
          revision: draft.revisionId,
        })
      : catalog);
  const reloadHref = draft
    ? `${workspaceBenchmarkSuitePath(workspaceSlug, draft.suiteId, { ...factory, edit: "suite" })}#edit-suite`
    : `${workspaceBenchmarksPath(workspaceSlug, { ...factory, newSuite: "1" })}#new-suite`;
  const suitesUrl = `/api/workspaces/${workspaceId}/factories/${factoryId}/benchmarks/suites`;

  const action = useApiAction<unknown, [SaveBenchmarkSuite]>({
    async call(command) {
      const response = await fetch(suitesUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      if (response.status === 409) setConflict(true);
      if (response.status === 412 || response.status === 428) setPreviewStale(true);
      return response;
    },
    errorText: "Could not save the benchmark suite.",
    setFlashMessage: setMessage,
    onError() {
      feedback.current?.focus();
    },
    onSuccess(payload) {
      const result = benchmarkSuiteMutationResultSchema.parse(payload);
      saved.current = true;
      router.replace(
        `${workspaceBenchmarkSuitePath(workspaceSlug, result.suiteId, { ...factory, revision: result.revisionId })}#suite-membership`,
      );
    },
  });

  const preview = useApiAction<{ taskChoices: BenchmarkTaskChoice[] }>({
    async call() {
      const url = draft
        ? `${suitesUrl}?${new URLSearchParams({ suiteId: draft.suiteId, expectedRevisionId: draft.revisionId })}`
        : suitesUrl;
      const response = await fetch(url);
      if (response.status === 409) setConflict(true);
      return response;
    },
    errorText: "Could not refresh the benchmark task preview.",
    setFlashMessage: setMessage,
    onError() {
      feedback.current?.focus();
    },
    onSuccess({ taskChoices }) {
      setRefreshedChoices(taskChoices);
      setAllowEmpty(false);
      setPreviewStale(false);
      setMessage(null);
    },
  });

  useEffect(() => {
    nameField.current?.focus();
  }, []);

  useEffect(() => {
    onDraftStatusChange?.(action.isBusy ? "saving" : dirty && !saved.current ? "dirty" : "clean");
  }, [action.isBusy, dirty, onDraftStatusChange]);

  useEffect(() => {
    if (!dirty && !action.isBusy) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (!saved.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [action.isBusy, dirty]);

  function pick(taskId: string, revision?: BenchmarkTaskChoice) {
    setAllowEmpty(false);
    setPicks((current) => {
      const next = new Map(current);
      if (revision) next.set(taskId, revision);
      else next.delete(taskId);
      return next;
    });
  }

  function changeMode(next: Mode) {
    setMode(next);
    setAllowEmpty(false);
    setInvalid(null);
    if (!conflict && !previewStale) setMessage(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (conflict || previewStale || preview.isBusy || saved.current || (empty && !allowEmpty))
      return;
    if (!name.trim()) {
      setInvalid("name");
      nameField.current?.focus();
      return;
    }
    if (mode === "tags" && !tags.length) {
      setInvalid("tags");
      tagsField.current?.focus();
      return;
    }
    const parsed = saveBenchmarkSuiteSchema.safeParse({
      ...(draft ? { suiteId: draft.suiteId, expectedRevisionId: draft.revisionId } : {}),
      ...(empty && allowEmpty ? { allowEmpty: true } : {}),
      name,
      purpose,
      selection:
        mode === "explicit"
          ? { kind: "explicit", taskRevisionIds: [...picks.values()].map(({ id }) => id) }
          : mode === "tags"
            ? { kind: "tags", tags, previewTaskRevisionIds: matches.map(({ id }) => id) }
            : { kind: "preserve" },
    });
    if (!parsed.success) {
      setMessage({
        kind: "error",
        text: "Review the suite details and task selection before saving.",
      });
      feedback.current?.focus();
      return;
    }
    setMessage(null);
    void action.run(parsed.data);
  }

  function canDiscard() {
    return (
      !action.isBusy &&
      (!dirty || saved.current || window.confirm("Discard your unsaved suite changes?"))
    );
  }

  return (
    <form
      aria-label={draft ? "Edit suite" : "New suite"}
      className="ui-sheet p-4 sm:p-5"
      onSubmit={submit}
      noValidate
    >
      <fieldset
        aria-busy={action.isBusy || preview.isBusy}
        className="min-w-0 space-y-5"
        disabled={action.isBusy || preview.isBusy}
      >
        <legend className="sr-only">Suite details</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block min-w-0 space-y-1.5">
            <span className="type-label">Suite name</span>
            <input
              aria-describedby={invalid === "name" ? `${fieldId}-name-error` : undefined}
              aria-invalid={invalid === "name" || undefined}
              className="ui-input scroll-mt-24"
              name="name"
              onChange={(event) => {
                setName(event.target.value);
                if (invalid === "name") setInvalid(null);
              }}
              ref={nameField}
              value={name}
              maxLength={120}
              required
            />
            {invalid === "name" ? (
              <span
                id={`${fieldId}-name-error`}
                role="alert"
                className="type-secondary block text-danger"
              >
                Enter a suite name.
              </span>
            ) : null}
          </label>
          <div className="min-w-0 space-y-1.5">
            <SelectField
              aria-describedby={`${fieldId}-purpose-help`}
              label="Suite purpose"
              labelClassName="type-label"
              name="purpose"
              onValueChange={setPurpose}
              options={purposes}
              value={purpose}
            />
            <p id={`${fieldId}-purpose-help`} className="type-secondary text-muted">
              Regression checks known failures. Holdout checks performance on separate tasks.
            </p>
          </div>
        </div>
        <fieldset className="min-w-0 space-y-3">
          <legend className="type-label text-foreground">Task selection</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {modeOptions.map(([value, label]) => (
              <label className="flex min-h-8 items-center gap-2 text-sm" key={value}>
                <input
                  className="accent-accent"
                  name="selectionMode"
                  type="radio"
                  checked={mode === value}
                  onChange={() => changeMode(value)}
                />
                {label}
              </label>
            ))}
          </div>
          {mode === "preserve" ? (
            <div className="type-secondary space-y-1 text-muted">
              <p className="[overflow-wrap:anywhere]">
                Selection tags: {draft?.selectionTags?.join(", ")}
              </p>
              <p>
                Saving the name or purpose keeps this tag rule and the same frozen task revisions.
              </p>
            </div>
          ) : null}
          {mode === "tags" ? (
            <div className="space-y-2">
              <label className="type-label block" htmlFor={`${fieldId}-tags`}>
                Selection tags
              </label>
              <input
                aria-describedby={`${fieldId}-tag-help${invalid === "tags" ? ` ${fieldId}-tag-error` : ""}`}
                aria-invalid={invalid === "tags" || undefined}
                className="ui-input scroll-mt-24"
                id={`${fieldId}-tags`}
                name="tags"
                onChange={(event) => {
                  setTagsText(event.target.value);
                  setAllowEmpty(false);
                  if (invalid === "tags") setInvalid(null);
                }}
                ref={tagsField}
                value={tagsText}
              />
              <p id={`${fieldId}-tag-help`} className="type-secondary text-muted">
                Choose factory tags or type comma-separated tags. Saving freezes the latest task
                revisions that match every tag.
              </p>
              {invalid === "tags" ? (
                <p id={`${fieldId}-tag-error`} role="alert" className="type-secondary text-danger">
                  Choose or enter at least one tag.
                </p>
              ) : null}
              {knownTags.length ? (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Factory tags">
                  {knownTags.map((tag) => {
                    const chosen = chosenTags.includes(tag);
                    return (
                      <button
                        aria-pressed={chosen}
                        className={`ui-button max-w-full whitespace-normal [overflow-wrap:anywhere]${chosen ? " ui-button-primary" : ""}`}
                        key={tag}
                        onClick={() => {
                          setChosenTags((current) =>
                            chosen ? current.filter((entry) => entry !== tag) : [...current, tag],
                          );
                          setAllowEmpty(false);
                          if (invalid === "tags") setInvalid(null);
                        }}
                        type="button"
                      >
                        {tag}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="type-secondary text-muted">
                  No tags are available in this factory yet.
                </p>
              )}
            </div>
          ) : null}
          <p className="type-label text-foreground" role="status">
            {count} {selectionWord} {count === 1 ? "task" : "tasks"}
            {mode === "tags" && draft && tags.length ? ` · ${pinned.size} previously frozen` : ""}
          </p>
          {mode === "tags" && empty ? (
            <p className="type-secondary text-muted">
              No tasks match all of these tags. Try removing a tag or choosing tasks manually.
            </p>
          ) : null}
          {mode === "tags" && tags.length > 0 && removed.length > 0 ? (
            <p className="type-secondary text-muted [overflow-wrap:anywhere]">
              Would remove: {removed.map(({ name }) => name).join(", ")}.
            </p>
          ) : null}
          {(mode === "explicit" ? options.size : displayed.length) ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {(mode === "explicit" ? [...options.values()] : displayed).map((latest) => {
                const original = pinned.get(latest.task_id);
                const selected = picks.get(latest.task_id);
                const shown = mode === "explicit" ? (selected ?? original ?? latest) : latest;
                const alternate = selected?.id === latest.id ? original : latest;
                const taskName = shown.name;
                const description = (
                  <span className="min-w-0 space-y-1">
                    <span className="type-label block break-words text-foreground">{taskName}</span>
                    <span className="type-secondary block break-words text-muted">
                      {summarize(shown)}
                      {mode === "tags" && draft && (!original || original.id !== shown.id)
                        ? original
                          ? ` · Was revision ${original.revision_number}`
                          : " · New match"
                        : ""}
                    </span>
                  </span>
                );
                return (
                  <li className="min-w-0 px-3 py-2.5" key={latest.task_id}>
                    {mode === "explicit" ? (
                      <label className="flex min-w-0 items-start gap-2.5">
                        <input
                          aria-label={`Include ${taskName}`}
                          className="mt-1 shrink-0 accent-accent"
                          type="checkbox"
                          checked={!!selected}
                          onChange={(event) =>
                            pick(latest.task_id, event.target.checked ? shown : undefined)
                          }
                        />
                        {description}
                      </label>
                    ) : (
                      description
                    )}
                    <details className={`mt-2 break-words${mode === "explicit" ? " ml-6" : ""}`}>
                      <summary className="type-secondary cursor-pointer text-muted">
                        Review {taskName}
                      </summary>
                      <div className="space-y-2 py-2">
                        {shown.eligibility_reason ? (
                          <p className="type-secondary whitespace-pre-wrap [overflow-wrap:anywhere] text-muted">
                            {shown.eligibility_reason}
                          </p>
                        ) : null}
                        <p className="type-label text-foreground">Acceptance criteria</p>
                        <p className="type-secondary whitespace-pre-wrap [overflow-wrap:anywhere]">
                          {shown.acceptance_criteria}
                        </p>
                        <BenchmarkTaskSource
                          canNavigate={canDiscard}
                          source={shown.source}
                          workspaceSlug={workspaceSlug}
                        />
                      </div>
                    </details>
                    {mode === "explicit" && selected && alternate && alternate.id !== shown.id ? (
                      <button
                        className="ui-button ml-6 mt-2"
                        onClick={() => pick(latest.task_id, alternate)}
                        type="button"
                      >
                        {`Use revision ${alternate.revision_number} for ${alternate.name}`}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {!options.size ? (
            <div className="type-secondary space-y-1 text-muted">
              <p>
                No benchmark tasks in this factory yet. Open a finished run and choose “Add to
                benchmark.”
              </p>
              <Link
                className="ui-button"
                href={workspaceRunsPath(workspaceSlug, factory)}
                onNavigate={(event) => {
                  if (!canDiscard()) event.preventDefault();
                }}
              >
                Browse runs
              </Link>
            </div>
          ) : null}
        </fieldset>
        {empty ? (
          <label className="type-secondary flex min-h-8 items-center gap-2 text-foreground">
            <input
              className="accent-accent"
              type="checkbox"
              checked={allowEmpty}
              onChange={(event) => setAllowEmpty(event.target.checked)}
            />
            Save this suite without tasks. It can’t be used in a comparison until you add tasks in a
            new revision.
          </label>
        ) : null}
        <div className="space-y-2 scroll-mt-24" ref={feedback} tabIndex={-1}>
          <InlineActionMessage message={message} />
          {conflict ? (
            <p className="type-secondary text-muted">
              Your draft is still here. Reloading will discard these edits.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="ui-button ui-button-primary"
            type="submit"
            disabled={conflict || previewStale || (empty && !allowEmpty)}
          >
            <ActionButtonLabel
              idle={empty ? "Save empty suite" : "Save suite"}
              pending={action.isBusy}
              pendingLabel="Saving…"
            />
          </button>
          {previewStale && !conflict ? (
            <button className="ui-button" type="button" onClick={() => void preview.run()}>
              <ActionButtonLabel
                idle="Refresh preview"
                pending={preview.isBusy}
                pendingLabel="Refreshing…"
              />
            </button>
          ) : null}
          {conflict ? (
            <Link
              className="ui-button"
              href={reloadHref}
              onNavigate={(event) => {
                event.preventDefault();
                if (canDiscard()) {
                  saved.current = true;
                  window.location.assign(reloadHref);
                }
              }}
            >
              {draft ? "Reload latest revision" : "Reload benchmark suites"}
            </Link>
          ) : null}
          <Link
            className="ui-button"
            href={returnHref}
            onNavigate={(event) => {
              if (!canDiscard()) event.preventDefault();
            }}
          >
            Cancel
          </Link>
        </div>
      </fieldset>
    </form>
  );
}

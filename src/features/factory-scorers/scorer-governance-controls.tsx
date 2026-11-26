"use client";

import Link from "next/link";
import { useId, useRef, useState, type FormEvent } from "react";
import type { z } from "zod";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import type { FlashMessage } from "@/features/settings/settings-types";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  CALIBRATION_NAME_MAX_CODE_POINTS,
  calibrationCandidatePageSchema,
  type CalibrationCandidatePage,
  type CalibrationRevision,
  type ScorerGovernanceCommand,
  type ScorerPause,
  scorerGovernanceCommandSchema,
  scorerGovernanceResponseSchema,
} from "@/lib/factory-evaluations/scorer-governance-contracts";

import {
  calibrationCaseHref,
  calibrationCaseName,
  calibrationCaseVerdict,
} from "./scorer-calibration-case";
import { scoreReasonDetail } from "./score-outcome";
import { useGovernanceAction } from "./use-governance-action";

export function GovernanceFeedback({
  action,
}: {
  action: {
    message: FlashMessage | null;
    conflict: boolean;
    busy: boolean;
    reload: () => void;
  };
}) {
  return (
    <>
      <InlineActionMessage message={action.message} />
      {action.conflict ? (
        <button className="ui-button" disabled={action.busy} onClick={action.reload} type="button">
          Reload controls
        </button>
      ) : null}
    </>
  );
}

type ScorerResponse = z.output<typeof scorerGovernanceResponseSchema>;

export function ScorerPauseControl({ endpoint, pause }: { endpoint: string; pause: ScorerPause }) {
  const action = useGovernanceAction<ScorerGovernanceCommand, ScorerResponse>({
    endpoint,
    response: scorerGovernanceResponseSchema,
    successText: "Scorer admission updated.",
  });
  const toggle = () =>
    void action.run({ action: "pause", expectedRevision: pause.revision, paused: !pause.paused });
  return (
    <div className="space-y-3">
      {pause.paused ? (
        <button
          className="ui-button"
          disabled={action.busy || action.conflict}
          onClick={toggle}
          type="button"
        >
          <ActionButtonLabel idle="Resume scorer" pending={action.busy} pendingLabel="Saving…" />
        </button>
      ) : (
        <AlertDialog>
          <AlertDialogTrigger
            className="ui-button"
            disabled={action.busy || action.conflict}
            type="button"
          >
            <ActionButtonLabel idle="Pause scorer" pending={action.busy} pendingLabel="Saving…" />
          </AlertDialogTrigger>
          <AlertDialogContent
            title="Pause this scorer across all rubric revisions?"
            description="In this factory, new sampled evaluations for this scorer will be skipped, and queued work and retries will wait. Active attempts can finish. Production runs continue."
          >
            <div className="flex flex-wrap justify-end gap-2">
              <AlertDialogCancel className="ui-button">Cancel</AlertDialogCancel>
              <AlertDialogAction className="ui-button ui-button-danger" onClick={toggle}>
                Pause all revisions
              </AlertDialogAction>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      )}
      <GovernanceFeedback action={action} />
    </div>
  );
}

export function CalibrationForm({
  endpoint,
  current,
  candidatePage,
  scorerRevisionId,
  workspaceSlug,
}: {
  endpoint: string;
  current?: CalibrationRevision;
  candidatePage: CalibrationCandidatePage;
  scorerRevisionId: string;
  workspaceSlug: string;
}) {
  const newSet = useRef<string | null>(null);
  const descriptionId = useId();
  const [calibrationName, setCalibrationName] = useState(current?.name ?? "");
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const [older, setOlder] = useState<CalibrationCandidatePage | null>(null);
  const [pageMessage, setPageMessage] = useState<FlashMessage | null>(null);
  const nameLength = Array.from(calibrationName.trim()).length;
  const nameTooLong = nameLength > CALIBRATION_NAME_MAX_CODE_POINTS;
  const latestIds = new Set(candidatePage.candidates.map(({ id }) => id));
  const candidates = [
    ...candidatePage.candidates,
    ...(older?.candidates.filter(({ id }) => !latestIds.has(id)) ?? []),
  ];
  const next = older ?? candidatePage;
  const pages = useApiAction<unknown, [string, string]>({
    call(beforeCandidateAt, beforeCandidateId) {
      return fetch(`${endpoint}?${new URLSearchParams({ beforeCandidateAt, beforeCandidateId })}`, {
        cache: "no-store",
      });
    },
    onSuccess(payload, [previousAt, previousId]) {
      const page = calibrationCandidatePageSchema.parse(payload);
      if (
        page.next_before_candidate_at === previousAt &&
        page.next_before_candidate_id === previousId
      ) {
        throw new Error("Could not advance calibration cases.");
      }
      setPageMessage(null);
      setOlder((previous) => ({
        ...page,
        candidates: [
          ...new Map(
            [...(previous?.candidates ?? []), ...page.candidates].map((candidate) => [
              candidate.id,
              candidate,
            ]),
          ).values(),
        ],
      }));
    },
    errorText: "Could not load older calibration cases.",
    setFlashMessage: setPageMessage,
  });
  const action = useGovernanceAction<ScorerGovernanceCommand, ScorerResponse>({
    endpoint,
    response: scorerGovernanceResponseSchema,
    successText: "Calibration version published.",
  });
  const selected = new Set(current?.adjudication_ids);
  const savedRefs = new Map(
    current?.case_refs.map((reference) => [reference.adjudication_id, reference]),
  );
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const orderedIds = [...new Set([...(current?.adjudication_ids ?? []), ...candidateById.keys()])];
  const isChecked = (id: string) => choices[id] ?? selected.has(id);
  const select = (id: string, checked: boolean) =>
    setChoices((previous) => ({ ...previous, [id]: checked }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const setId = current?.set_id ?? (newSet.current ??= crypto.randomUUID());
    const command = scorerGovernanceCommandSchema.safeParse({
      action: "calibration",
      setId,
      expectedRevision: current?.revision ?? 0,
      scorerRevisionId: current?.scorer_revision_id ?? scorerRevisionId,
      name: calibrationName,
      adjudicationIds: orderedIds.filter(isChecked),
    });
    if (!command.success) {
      action.setMessage({
        kind: "error",
        text: "Enter a calibration set name and select 1–40 adjudicated cases.",
      });
      return;
    }
    void action.run(command.data).then((result) => {
      if (result?.action === "calibration" && !current) {
        newSet.current = null;
        setCalibrationName("");
        setChoices({});
        setSearch("");
      }
    });
  }

  const visibleCases = orderedIds.flatMap((id, index) => {
    const candidate = candidateById.get(id);
    const saved = savedRefs.get(id);
    const item = candidate?.session_title ? candidate : (saved ?? candidate);
    const fallback = selected.has(id)
      ? `Saved case ${index + 1} · Details unavailable`
      : "Evaluation · Session unavailable";
    const name = item ? calibrationCaseName(item, fallback) : fallback;
    const verdict = item ? calibrationCaseVerdict(item) : "";
    const reason = candidate ? scoreReasonDetail(candidate.reason) : null;
    if (!`${name} ${verdict}`.toLowerCase().includes(search.trim().toLowerCase())) return [];
    const runId = candidate?.run_id ?? saved?.run_id;
    const attemptId = candidate?.attempt_id ?? saved?.attempt_id;
    return [
      {
        id,
        name,
        verdict,
        reason,
        note: candidate ? (candidate.note ?? "Adjudication note withheld") : null,
        href: runId && attemptId ? calibrationCaseHref(workspaceSlug, id, runId, attemptId) : null,
      },
    ];
  });

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="space-y-1.5">
        <label className="type-label flex min-w-0 flex-col gap-1.5">
          Calibration set name
          <input
            aria-describedby={`${descriptionId}-name`}
            aria-invalid={nameTooLong || undefined}
            className="ui-input"
            name="name"
            onChange={(event) => setCalibrationName(event.currentTarget.value)}
            required
            value={calibrationName}
          />
        </label>
        <p
          className={`type-annotation ${nameTooLong ? "text-danger" : "text-muted"}`}
          id={`${descriptionId}-name`}
        >
          {nameLength} / {CALIBRATION_NAME_MAX_CODE_POINTS} characters.
          {nameTooLong ? " Shorten the name to publish." : ""}
        </p>
      </div>
      <fieldset className="min-w-0 space-y-3">
        <legend className="type-label">Calibration cases</legend>
        {orderedIds.length ? (
          <>
            <label className="type-label block max-w-md space-y-1.5">
              <span>Filter saved and loaded cases</span>
              <input
                className="ui-input"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
            </label>
            <p className="type-annotation text-muted" role="status">
              {orderedIds.filter(isChecked).length} selected
              {search.trim() ? ` · ${visibleCases.length} matching loaded or saved cases` : ""}
            </p>
            {visibleCases.length ? (
              <ul className="max-h-72 divide-y divide-border overflow-auto rounded-md border border-border">
                {visibleCases.map(({ id, name, verdict, reason, note, href }) => (
                  <li className="min-w-0 space-y-1 px-3 py-2.5" key={id}>
                    <label className="flex items-start gap-3">
                      <input
                        className="mt-0.5 accent-accent"
                        aria-label={name}
                        aria-describedby={verdict || note ? `${descriptionId}-${id}` : undefined}
                        checked={isChecked(id)}
                        onChange={(event) => select(id, event.currentTarget.checked)}
                        type="checkbox"
                      />
                      <span className="min-w-0 break-words">
                        <span className="type-label block text-foreground">{name}</span>
                        <span
                          id={verdict || note ? `${descriptionId}-${id}` : undefined}
                          className="type-secondary block text-muted"
                        >
                          {verdict ? (
                            <span className="block">
                              {verdict}
                              {reason ? ` · ${reason}` : ""}
                            </span>
                          ) : null}
                          {note ? <span className="block">{note}</span> : null}
                        </span>
                      </span>
                    </label>
                    {href ? (
                      <Link
                        className="type-secondary ml-6 text-accent underline underline-offset-4"
                        href={href}
                        aria-label={`Inspect adjudication: ${name}`}
                        prefetch={false}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Inspect adjudication (new tab)
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="type-secondary text-muted">
                No saved or loaded cases match. Try a different filter or load older cases when
                available.
              </p>
            )}
          </>
        ) : (
          <p className="type-secondary text-muted">
            Adjudicate an evaluation before creating calibration cases.
          </p>
        )}
        {next.next_before_candidate_at && next.next_before_candidate_id ? (
          <button
            className="ui-button"
            disabled={pages.isBusy}
            type="button"
            onClick={() => {
              if (next.next_before_candidate_at && next.next_before_candidate_id) {
                void pages.run(next.next_before_candidate_at, next.next_before_candidate_id);
              }
            }}
          >
            <ActionButtonLabel
              idle="Load older calibration cases"
              pending={pages.isBusy}
              pendingLabel="Loading cases"
            />
          </button>
        ) : null}
        <InlineActionMessage message={pageMessage} />
      </fieldset>
      <button
        className="ui-button-primary px-3 py-2"
        disabled={action.busy || action.conflict || nameTooLong || !orderedIds.length}
        type="submit"
      >
        <ActionButtonLabel
          idle={current ? "Publish next version" : "Publish calibration set"}
          pending={action.busy}
          pendingLabel="Publishing"
        />
      </button>
      <GovernanceFeedback action={action} />
    </form>
  );
}

"use client";

import { useRef, useState, type FormEvent } from "react";
import type { z } from "zod";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import type { FlashMessage } from "@/features/settings/settings-types";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  calibrationCandidatePageSchema,
  type CalibrationCandidatePage,
  type CalibrationRevision,
  type ScorerGovernanceCommand,
  type ScorerPause,
  scorerGovernanceCommandSchema,
  scorerGovernanceResponseSchema,
} from "@/lib/factory-evaluations/scorer-governance-contracts";

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
  return (
    <div className="space-y-3">
      <button
        className="ui-button"
        disabled={action.busy || action.conflict}
        onClick={() =>
          void action.run({
            action: "pause",
            expectedRevision: pause.revision,
            paused: !pause.paused,
          })
        }
        type="button"
      >
        <ActionButtonLabel
          idle={pause.paused ? "Resume scorer" : "Pause scorer"}
          pending={action.busy}
          pendingLabel="Saving"
        />
      </button>
      <GovernanceFeedback action={action} />
    </div>
  );
}

function caseLabel(candidate: CalibrationCandidatePage["candidates"][number]) {
  const disposition = candidate.disposition === "disputed" ? "Disputed" : "Confirmed";
  const reason = scoreReasonDetail(candidate.reason);
  return `${disposition} · ${candidate.status}${candidate.expected_status ? ` → ${candidate.expected_status}` : ""}${reason ? ` · ${reason}` : ""}`;
}

export function CalibrationForm({
  endpoint,
  current,
  candidatePage,
  scorerRevisionId,
}: {
  endpoint: string;
  current?: CalibrationRevision;
  candidatePage: CalibrationCandidatePage;
  scorerRevisionId: string;
}) {
  const newSet = useRef<string | null>(null);
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [older, setOlder] = useState<CalibrationCandidatePage | null>(null);
  const [pageMessage, setPageMessage] = useState<FlashMessage | null>(null);
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
  const recent = new Set(candidates.map(({ id }) => id));
  const historical = [...selected].filter((id) => !recent.has(id));
  const isChecked = (id: string) => choices[id] ?? selected.has(id);
  const select = (id: string, checked: boolean) =>
    setChoices((previous) => ({ ...previous, [id]: checked }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const setId = current?.set_id ?? (newSet.current ??= crypto.randomUUID());
    const checked = form.getAll("case");
    const adjudicationIds = [
      ...(current?.adjudication_ids ?? []).filter((id) => checked.includes(id)),
      ...checked.filter((id) => typeof id !== "string" || !selected.has(id)),
    ];
    const command = scorerGovernanceCommandSchema.safeParse({
      action: "calibration",
      setId,
      expectedRevision: current?.revision ?? 0,
      scorerRevisionId: current?.scorer_revision_id ?? scorerRevisionId,
      name: form.get("name"),
      adjudicationIds,
    });
    if (!command.success) {
      action.setMessage({
        kind: "error",
        text: "Enter a calibration set name and select 1–40 adjudicated cases.",
      });
      return;
    }
    const target = event.currentTarget;
    void action.run(command.data).then((result) => {
      if (result?.action === "calibration" && !current) {
        newSet.current = null;
        setChoices({});
        target.reset();
      }
    });
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <label className="type-label flex min-w-0 flex-col gap-1.5">
        Calibration set name
        <input
          className="ui-input"
          defaultValue={current?.name ?? ""}
          maxLength={240}
          name="name"
          required
        />
      </label>
      <fieldset className="min-w-0 space-y-3">
        <legend className="type-label">Calibration cases</legend>
        {candidates.length || historical.length ? (
          <div className="max-h-72 divide-y divide-border overflow-auto rounded-md border border-border">
            {candidates.map((candidate) => (
              <label className="flex items-start gap-3 px-3 py-2.5" key={candidate.id}>
                <input
                  className="mt-0.5"
                  checked={isChecked(candidate.id)}
                  name="case"
                  onChange={(event) => select(candidate.id, event.currentTarget.checked)}
                  type="checkbox"
                  value={candidate.id}
                />
                <span className="min-w-0">
                  <span className="type-label block text-foreground">{caseLabel(candidate)}</span>
                  <span className="type-secondary block break-words text-muted">
                    {candidate.note ?? "Adjudication note withheld"}
                  </span>
                </span>
              </label>
            ))}
            {historical.map((id) => (
              <label className="flex items-start gap-3 px-3 py-2.5" key={id}>
                <input
                  className="mt-0.5"
                  checked={isChecked(id)}
                  name="case"
                  onChange={(event) => select(id, event.currentTarget.checked)}
                  type="checkbox"
                  value={id}
                />
                <span className="type-secondary min-w-0 break-words text-muted">
                  Earlier case {id.slice(0, 8)}
                </span>
              </label>
            ))}
          </div>
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
        disabled={action.busy || action.conflict || (!candidates.length && !historical.length)}
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

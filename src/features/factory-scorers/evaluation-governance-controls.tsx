"use client";

import { useRef, useState, type FormEvent } from "react";
import type { z } from "zod";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { SelectField } from "@/components/ui/select";
import {
  type EvaluationGovernanceCommand,
  evaluationGovernanceCommandSchema,
  evaluationGovernanceResponseSchema,
} from "@/lib/factory-evaluations/scorer-governance-contracts";

import { GovernanceFeedback } from "./scorer-governance-controls";
import { useGovernanceAction } from "./use-governance-action";

type EvaluationResponse = z.output<typeof evaluationGovernanceResponseSchema>;

export function AdjudicationForm({ endpoint }: { endpoint: string }) {
  const [disputed, setDisputed] = useState(false);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const action = useGovernanceAction<EvaluationGovernanceCommand, EvaluationResponse>({
    endpoint,
    response: evaluationGovernanceResponseSchema,
    successText: "Adjudication saved.",
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    const input = {
      action: "adjudicate",
      disposition: form.get("disposition"),
      expectedStatus: form.get("expectedStatus") || undefined,
      note: form.get("note"),
    };
    const fingerprint = JSON.stringify(input);
    if (request.current?.fingerprint !== fingerprint)
      request.current = { fingerprint, id: crypto.randomUUID() };
    const command = evaluationGovernanceCommandSchema.safeParse({
      ...input,
      adjudicationId: request.current.id,
    });
    if (!command.success) {
      action.setMessage({ kind: "error", text: "Add an adjudication note of 1–640 characters." });
      return;
    }
    void action.run(command.data).then((saved) => {
      if (saved?.action !== "adjudicate") return;
      request.current = null;
      target.reset();
      setDisputed(false);
    });
  }

  return (
    <form className="space-y-3" onSubmit={submit}>
      <div className="flex flex-wrap items-end gap-3">
        <SelectField
          className="min-w-44"
          label="Adjudication outcome"
          labelClassName="type-label"
          name="disposition"
          onValueChange={(value) => setDisputed(value === "disputed")}
          options={[
            { label: "Confirm verdict", value: "confirmed" },
            { label: "Dispute verdict", value: "disputed" },
          ]}
          value={disputed ? "disputed" : "confirmed"}
        />
        {disputed ? (
          <SelectField
            className="min-w-48"
            defaultValue=""
            label="Expected outcome"
            labelClassName="type-label"
            name="expectedStatus"
            options={[
              { label: "No suggested outcome", value: "" },
              { label: "Pass", value: "pass" },
              { label: "Fail", value: "fail" },
              { label: "Inconclusive", value: "inconclusive" },
            ]}
          />
        ) : null}
      </div>
      <label className="type-label flex flex-col gap-1.5">
        Adjudication note
        <textarea
          className="ui-input min-h-20 py-2"
          maxLength={1280}
          name="note"
          required
          rows={3}
        />
      </label>
      <button
        className="ui-button-primary px-3 py-2"
        disabled={action.busy || action.conflict}
        type="submit"
      >
        <ActionButtonLabel idle="Save adjudication" pending={action.busy} pendingLabel="Saving" />
      </button>
      <GovernanceFeedback action={action} />
    </form>
  );
}

export function ReevaluationForm({
  endpoint,
  revisions,
}: {
  endpoint: string;
  revisions: readonly { id: string; revision_number: number }[];
}) {
  const action = useGovernanceAction<EvaluationGovernanceCommand, EvaluationResponse>({
    endpoint,
    response: evaluationGovernanceResponseSchema,
    successText: "Re-evaluation queued.",
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const command = evaluationGovernanceCommandSchema.safeParse({
      action: "reevaluate",
      targetRevisionId: form.get("targetRevisionId"),
    });
    if (!command.success) {
      action.setMessage({ kind: "error", text: "Choose a newer rubric revision." });
      return;
    }
    void action.run(command.data);
  }
  return (
    <form className="space-y-3" onSubmit={submit}>
      <div className="flex flex-wrap items-end gap-3">
        <SelectField
          className="min-w-52"
          defaultValue=""
          emptyOption={{ disabled: true, label: "Choose a newer revision", value: "" }}
          label="Target rubric revision"
          labelClassName="type-label"
          name="targetRevisionId"
          options={revisions.map(({ id, revision_number }) => ({
            label: `Revision ${revision_number}`,
            value: id,
          }))}
          required
        />
        <button
          className="ui-button-primary px-3 py-2"
          disabled={action.busy || action.conflict}
          type="submit"
        >
          <ActionButtonLabel
            idle="Queue re-evaluation"
            pending={action.busy}
            pendingLabel="Queueing"
          />
        </button>
      </div>
      <GovernanceFeedback action={action} />
    </form>
  );
}

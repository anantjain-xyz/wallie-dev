"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import type { z } from "zod";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { scorerEvidenceLabels } from "@/features/factory-scorers/scorer-evidence-labels";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  createFactoryScorerSchema,
  saveFactoryScorerRevisionSchema,
  scorerRevisionMutationResponseSchema,
} from "@/lib/factory-scorers/authoring-contracts";
import {
  factoryScorerEvidenceKindSchema,
  type FactoryScorerDefinition,
} from "@/lib/factory-scorers/contracts";
import type { FactoryScorerPreset } from "@/lib/factory-scorers/presets";
import { workspaceScorerDetailPath } from "@/lib/routes";

type ScorerDraft =
  | { kind: "create"; preset?: FactoryScorerPreset }
  | {
      kind: "revise";
      scorerId: string;
      expectedRevisionNumber: number;
      definition: FactoryScorerDefinition;
    };

type ScorerCommand =
  | z.output<typeof createFactoryScorerSchema>
  | z.output<typeof saveFactoryScorerRevisionSchema>;

type ScoringRule = FactoryScorerDefinition["scoring"];
const numericFields = [
  { name: "min", label: "Minimum score" },
  { name: "max", label: "Maximum score" },
  { name: "passThreshold", label: "Pass threshold" },
  { name: "failThreshold", label: "Fail threshold" },
] as const;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0 space-y-1.5">
      <span className="type-label text-foreground">{label}</span>
      {children}
    </label>
  );
}

function readNumber(fields: FormData, key: string) {
  const value = fields.get(key);
  return typeof value === "string" && value.trim() ? Number(value) : undefined;
}

function readDefinition(fields: FormData) {
  const kind = fields.get("scale");
  const passValue = fields.get("passValue");
  return {
    schemaVersion: 1,
    rubric: fields.get("rubric"),
    requiredEvidence: fields.getAll("requiredEvidence"),
    scoring:
      kind === "numeric"
        ? {
            kind,
            min: readNumber(fields, "min"),
            max: readNumber(fields, "max"),
            direction: fields.get("direction"),
            passThreshold: readNumber(fields, "passThreshold"),
            failThreshold: readNumber(fields, "failThreshold"),
          }
        : {
            kind,
            passValue: passValue === "true" ? true : passValue === "false" ? false : undefined,
          },
  };
}

export function ScorerForm({
  draft,
  factoryId,
  workspaceId,
  workspaceSlug,
}: {
  draft: ScorerDraft;
  factoryId: string;
  workspaceId: string;
  workspaceSlug: string;
}) {
  const router = useRouter();
  const create = draft.kind === "create";
  const preset = create ? draft.preset : undefined;
  const initial = create ? preset?.definition : draft.definition;
  const [scale, setScale] = useState<ScoringRule["kind"]>(initial?.scoring.kind ?? "boolean");
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [conflict, setConflict] = useState(false);
  const scorers = `/api/workspaces/${workspaceId}/factories/${factoryId}/scorers`;
  const endpoint = create ? scorers : `${scorers}/${draft.scorerId}/revisions`;
  const action = useApiAction<unknown, [ScorerCommand]>({
    async call(command) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!create && response.status === 409) setConflict(true);
      return response;
    },
    errorText: create ? "Could not publish the scorer." : "Could not publish the rubric revision.",
    setFlashMessage: setMessage,
    onSuccess(payload) {
      const saved = scorerRevisionMutationResponseSchema.safeParse(payload);
      if (!saved.success) throw new Error("Could not read the published rubric revision.");
      const { revision } = saved.data;
      router.push(
        workspaceScorerDetailPath(workspaceSlug, revision.scorer_id, {
          factory: factoryId,
          revision: revision.id,
        }),
      );
    },
  });

  function parseDraft(form: HTMLFormElement): ScorerCommand | null {
    const fields = new FormData(form);
    const definition = readDefinition(fields);
    const result = create
      ? createFactoryScorerSchema.safeParse({
          name: fields.get("name"),
          slug: fields.get("slug"),
          definition,
        })
      : saveFactoryScorerRevisionSchema.safeParse({
          expectedRevisionNumber: draft.expectedRevisionNumber,
          definition,
        });
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    setMessage({ kind: "error", text: issue?.message ?? "Review the draft rubric." });
    return null;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (conflict) return;
    const command = parseDraft(event.currentTarget);
    if (!command) return;
    setMessage(null);
    void action.run(command);
  }

  const booleanRule = initial?.scoring.kind === "boolean" ? initial.scoring : undefined;
  const numericRule = initial?.scoring.kind === "numeric" ? initial.scoring : undefined;

  return (
    <form
      className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5"
      noValidate
      onChange={() => {
        if (!conflict) setMessage(null);
      }}
      onReset={() => {
        setScale(initial?.scoring.kind ?? "boolean");
        setMessage(null);
      }}
      onSubmit={submit}
    >
      <InlineActionMessage message={message} />
      {conflict && !create ? (
        <a
          className="ui-button"
          href={workspaceScorerDetailPath(workspaceSlug, draft.scorerId, { factory: factoryId })}
        >
          Reload latest revision
        </a>
      ) : null}
      <fieldset aria-busy={action.isBusy} className="min-w-0 space-y-4" disabled={action.isBusy}>
        <legend className="sr-only">Draft rubric</legend>
        {create ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Scorer name">
              <input
                className="ui-input"
                defaultValue={preset?.name}
                maxLength={120}
                name="name"
                required
              />
            </Field>
            <Field label="Identifier">
              <input
                className="ui-input"
                defaultValue={preset?.slug}
                maxLength={60}
                name="slug"
                required
              />
            </Field>
          </div>
        ) : null}
        <Field label="Rubric">
          <textarea
            className="ui-textarea"
            defaultValue={initial?.rubric}
            name="rubric"
            required
            rows={6}
          />
        </Field>
        <fieldset className="min-w-0 space-y-2">
          <legend className="type-label text-foreground">Required evidence</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {factoryScorerEvidenceKindSchema.options.map((kind) => (
              <label className="flex min-w-0 items-center gap-2 text-sm text-foreground" key={kind}>
                <input
                  className="accent-accent"
                  defaultChecked={initial?.requiredEvidence.includes(kind)}
                  name="requiredEvidence"
                  type="checkbox"
                  value={kind}
                />
                {scorerEvidenceLabels[kind]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Score scale">
            <select
              className="ui-select"
              name="scale"
              onChange={(event) =>
                setScale(event.target.value === "numeric" ? "numeric" : "boolean")
              }
              value={scale}
            >
              <option value="boolean">Boolean</option>
              <option value="numeric">Numeric</option>
            </select>
          </Field>
          {scale === "boolean" ? (
            <Field label="Passing value">
              <select
                className="ui-select"
                defaultValue={String(booleanRule?.passValue ?? true)}
                name="passValue"
              >
                <option value="true">True</option>
                <option value="false">False</option>
              </select>
            </Field>
          ) : (
            <Field label="Better score">
              <select
                className="ui-select"
                defaultValue={numericRule?.direction ?? "higher_is_better"}
                name="direction"
              >
                <option value="higher_is_better">Higher</option>
                <option value="lower_is_better">Lower</option>
              </select>
            </Field>
          )}
        </div>
        {scale === "numeric" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {numericFields.map(({ label, name }) => (
              <Field key={name} label={label}>
                <input
                  className="ui-input"
                  defaultValue={numericRule?.[name]}
                  name={name}
                  required
                  step="any"
                  type="number"
                />
              </Field>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {preset ? (
            <button className="ui-button" type="reset">
              Restore preset
            </button>
          ) : null}
          <button
            className="ui-button"
            disabled={conflict}
            onClick={(event) => {
              if (event.currentTarget.form && parseDraft(event.currentTarget.form)) {
                setMessage({ kind: "success", text: "Rubric is valid." });
              }
            }}
            type="button"
          >
            Validate rubric
          </button>
          <button className="ui-button ui-button-primary" disabled={conflict} type="submit">
            <ActionButtonLabel
              idle={create ? "Publish scorer" : "Publish revision"}
              pending={action.isBusy}
              pendingLabel="Publishing…"
            />
          </button>
        </div>
      </fieldset>
    </form>
  );
}

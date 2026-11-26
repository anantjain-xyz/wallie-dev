"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { z } from "zod";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { PageSection } from "@/components/ui/page-shell";
import { SelectField } from "@/components/ui/select";
import { Status } from "@/components/ui/status";
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
  type FactoryScorerEvidenceKind,
} from "@/lib/factory-scorers/contracts";
import type { FactoryScorerPreset } from "@/lib/factory-scorers/presets";
import { workspaceScorerDetailPath } from "@/lib/routes";

import { useScorerDraftGuard } from "./scorer-draft-guard";
import { scorerEvidenceLabels } from "./scorer-evidence-labels";

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

const numericFields = [
  { name: "min", label: "Minimum score" },
  { name: "max", label: "Maximum score" },
  { name: "passThreshold", label: "Pass threshold" },
  { name: "failThreshold", label: "Fail threshold" },
] as const;
type NumericField = (typeof numericFields)[number]["name"];
type Scoring = FactoryScorerDefinition["scoring"];
type DraftValues = {
  name: string;
  slug: string;
  rubric: string;
  requiredEvidence: readonly FactoryScorerEvidenceKind[];
  scale: Scoring["kind"];
  passValue: string;
  direction: string;
} & Record<NumericField, string>;
type Errors = Partial<Record<keyof DraftValues, string>>;

function initialValues(draft: ScorerDraft): DraftValues {
  const preset = draft.kind === "create" ? draft.preset : undefined;
  const initial = draft.kind === "revise" ? draft.definition : preset?.definition;
  const scoring = initial?.scoring;
  const numeric = scoring?.kind === "numeric" ? scoring : undefined;
  return {
    name: preset?.name ?? "",
    slug: "",
    rubric: initial?.rubric ?? "",
    requiredEvidence: initial?.requiredEvidence ?? [],
    scale: scoring?.kind ?? "boolean",
    passValue: String(scoring?.kind === "boolean" ? scoring.passValue : true),
    direction: numeric?.direction ?? "higher_is_better",
    min: String(numeric?.min ?? ""),
    max: String(numeric?.max ?? ""),
    passThreshold: String(numeric?.passThreshold ?? ""),
    failThreshold: String(numeric?.failThreshold ?? ""),
  };
}

function Field({
  id,
  label,
  children,
  error,
}: {
  id: string;
  label: string;
  children: ReactNode;
  error?: string;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label className="type-label block text-foreground" htmlFor={id}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="type-annotation text-danger" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ScorerForm({
  draft,
  factoryId,
  factoryLabel,
  historical = false,
  workspaceId,
  workspaceSlug,
}: {
  draft: ScorerDraft;
  factoryId: string;
  factoryLabel: string;
  historical?: boolean;
  workspaceId: string;
  workspaceSlug: string;
}) {
  const router = useRouter();
  const guard = useScorerDraftGuard();
  const dirty = guard?.dirty;
  const id = useId();
  const create = draft.kind === "create";
  const [initial] = useState(() => initialValues(draft));
  const [{ values, changed }, setDraftValues] = useState({ values: initial, changed: false });
  const [errors, setErrors] = useState<Errors>({});
  const focusField = useRef<keyof DraftValues | null>(null);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [conflict, setConflict] = useState(false);
  const requiresReload = historical || conflict;
  const scorers = `/api/workspaces/${workspaceId}/factories/${factoryId}/scorers`;
  const endpoint = create ? scorers : `${scorers}/${draft.scorerId}/revisions`;
  const action = useApiAction<unknown, [ScorerCommand]>({
    async call(command) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      if (response.status === 409) {
        const failure = await response
          .clone()
          .json()
          .catch(() => null);
        if (!create && failure?.code === "stale_revision") setConflict(true);
        else if (
          create &&
          failure?.code === "identifier_in_use" &&
          "slug" in command &&
          command.slug
        ) {
          focusField.current = "slug";
          setErrors({
            slug: "That identifier is already in use. Enter a different one or clear this field to generate one.",
          });
        }
      }
      return response;
    },
    errorText: create ? "Could not publish the scorer." : "Could not publish the rubric revision.",
    setFlashMessage: setMessage,
    onSuccess(payload) {
      const saved = scorerRevisionMutationResponseSchema.safeParse(payload);
      if (!saved.success) throw new Error("Could not read the published rubric revision.");
      const { revision } = saved.data;
      if (dirty) dirty.current = false;
      router.push(
        workspaceScorerDetailPath(workspaceSlug, revision.scorer_id, {
          factory: factoryId,
          revision: revision.id,
          published: revision.id,
        }),
      );
    },
  });

  useEffect(
    () => () => {
      if (dirty) dirty.current = false;
    },
    [dirty],
  );

  useEffect(() => {
    if (action.isBusy || !focusField.current) return;
    const input = document.getElementById(`${id}-${focusField.current}`);
    focusField.current = null;
    const disclosure = input?.closest("details");
    if (disclosure) disclosure.open = true;
    input?.focus();
  }, [action.isBusy, errors, id]);

  function update(next: DraftValues) {
    const hasEdits =
      next.requiredEvidence.join() !== initial.requiredEvidence.join() ||
      Object.keys(initial).some((key) => {
        const field = key as keyof DraftValues;
        return field !== "requiredEvidence" && next[field] !== initial[field];
      });
    setDraftValues({ values: next, changed: hasEdits });
    if (dirty) dirty.current = hasEdits;
    setErrors({});
    if (!conflict) setMessage(null);
  }

  function parseDraft(): ScorerCommand | null {
    const definition = {
      schemaVersion: 1,
      rubric: values.rubric,
      requiredEvidence: values.requiredEvidence,
      scoring:
        values.scale === "boolean"
          ? { kind: "boolean", passValue: values.passValue === "true" }
          : {
              kind: "numeric",
              direction: values.direction,
              ...Object.fromEntries(
                numericFields.map(({ name }) => [
                  name,
                  values[name] === "" ? undefined : Number(values[name]),
                ]),
              ),
            },
    };
    const result = create
      ? createFactoryScorerSchema.safeParse({
          name: values.name,
          slug: values.slug.trim() || undefined,
          definition,
        })
      : saveFactoryScorerRevisionSchema.safeParse({
          expectedRevisionNumber: draft.expectedRevisionNumber,
          definition,
        });
    if (result.success) return result.data;

    const nextErrors: Errors = {};
    for (const issue of result.error.issues.flatMap((issue) =>
      issue.code === "invalid_union" && issue.path.at(-1) === "scoring"
        ? (issue.unionErrors[values.scale === "boolean" ? 0 : 1]?.issues ?? [issue])
        : [issue],
    )) {
      const key =
        issue.path[0] === "definition"
          ? issue.path[1] === "scoring"
            ? issue.path[2]
            : issue.path[1]
          : issue.path[0];
      if (typeof key !== "string" || !Object.hasOwn(values, key)) continue;
      const field = key as keyof DraftValues;
      nextErrors[field] ??=
        field === "requiredEvidence" && !values.requiredEvidence.length
          ? "Choose at least one kind of evidence."
          : field === "failThreshold" && issue.message.includes("disjoint")
            ? `Set the fail threshold ${values.direction === "higher_is_better" ? "below" : "above"} the pass threshold. The inclusive pass and fail intervals must not overlap.`
            : issue.code === "invalid_type" && numericFields.some(({ name }) => name === field)
              ? "Enter a score."
              : issue.message;
    }
    const order = [
      "name",
      "rubric",
      "requiredEvidence",
      "scale",
      ...numericFields.map(({ name }) => name),
      "slug",
    ] as const;
    const first = order.find((field) => nextErrors[field] !== undefined);
    focusField.current = first ?? null;
    setErrors(nextErrors);
    setMessage({
      kind: "error",
      text: first
        ? `Review the highlighted fields. ${nextErrors[first]}`
        : (result.error.issues[0]?.message ?? "Review the draft rubric."),
    });
    return null;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requiresReload) return;
    const command = parseDraft();
    if (!command) return;
    setMessage(null);
    void action.run(command);
  }

  function inputProps(field: keyof DraftValues, hint?: string) {
    return {
      id: `${id}-${field}`,
      name: field,
      "aria-invalid": errors[field] ? true : undefined,
      "aria-describedby":
        [hint, errors[field] ? `${id}-${field}-error` : null].filter(Boolean).join(" ") ||
        undefined,
    };
  }

  const reloadHref = !create
    ? workspaceScorerDetailPath(workspaceSlug, draft.scorerId, { factory: factoryId })
    : "";

  if (historical && !changed) return null;

  const form = (
    <form
      autoComplete="off"
      className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5"
      noValidate
      onSubmit={submit}
    >
      {requiresReload ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="type-secondary">
            Another revision was published. Copy your draft before reloading, then review it against
            the latest rubric. Reloading won’t publish your edits.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className="ui-button"
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(JSON.stringify(values, null, 2));
                  setMessage({
                    kind: "success",
                    text: "Draft copied, including both score scales.",
                  });
                } catch {
                  setMessage({
                    kind: "error",
                    text: "Could not copy your draft. Keep editing or copy the fields manually before reloading.",
                  });
                }
              }}
            >
              Copy draft
            </button>
            <a
              className="ui-button"
              href={reloadHref}
              onClick={(event) => {
                if (
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey ||
                  !guard?.dirty.current
                )
                  return;
                event.preventDefault();
                guard.guard(() => {
                  guard.dirty.current = false;
                  window.location.assign(reloadHref);
                }, event.currentTarget);
              }}
            >
              Reload latest revision
            </a>
          </div>
        </div>
      ) : null}
      <fieldset aria-busy={action.isBusy} className="min-w-0 space-y-4" disabled={action.isBusy}>
        <legend className="sr-only">Draft rubric</legend>
        {create ? (
          <Field id={`${id}-name`} label="Scorer name" error={errors.name}>
            <input
              {...inputProps("name")}
              className="ui-input"
              maxLength={120}
              required
              value={values.name}
              onChange={(event) => update({ ...values, name: event.currentTarget.value })}
            />
          </Field>
        ) : null}
        <Field id={`${id}-rubric`} label="Rubric" error={errors.rubric}>
          <textarea
            {...inputProps("rubric")}
            className="ui-textarea"
            required
            rows={6}
            value={values.rubric}
            onChange={(event) => update({ ...values, rubric: event.currentTarget.value })}
          />
        </Field>
        <fieldset aria-describedby={`${id}-evidence-hint`} className="min-w-0 space-y-2">
          <legend className="type-label text-foreground">Required evidence</legend>
          <p className="type-annotation text-muted" id={`${id}-evidence-hint`}>
            Choose at least one. Runs missing or withholding required evidence are excluded.
          </p>
          {errors.requiredEvidence ? (
            <p className="type-annotation text-danger" id={`${id}-requiredEvidence-error`}>
              {errors.requiredEvidence}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {factoryScorerEvidenceKindSchema.options.map((kind, index) => (
              <label className="flex min-w-0 items-center gap-2 text-sm text-foreground" key={kind}>
                <input
                  {...inputProps("requiredEvidence", `${id}-evidence-hint`)}
                  id={index === 0 ? `${id}-requiredEvidence` : undefined}
                  className="accent-accent"
                  checked={values.requiredEvidence.includes(kind)}
                  onChange={(event) => {
                    const selected = event.currentTarget.checked;
                    update({
                      ...values,
                      requiredEvidence: [
                        ...new Set([
                          ...initial.requiredEvidence,
                          ...factoryScorerEvidenceKindSchema.options,
                        ]),
                      ].filter((option) =>
                        option === kind ? selected : values.requiredEvidence.includes(option),
                      ),
                    });
                  }}
                  type="checkbox"
                  value={kind}
                />
                {scorerEvidenceLabels[kind]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Score scale"
            labelClassName="type-label text-foreground"
            name="scale"
            onValueChange={(scale) =>
              update({ ...values, scale: scale === "numeric" ? "numeric" : "boolean" })
            }
            options={[
              { label: "Boolean", value: "boolean" },
              { label: "Numeric", value: "numeric" },
            ]}
            value={values.scale}
          />
          {values.scale === "boolean" ? (
            <SelectField
              key="passValue"
              label="Passing value"
              labelClassName="type-label text-foreground"
              name="passValue"
              onValueChange={(passValue) => update({ ...values, passValue })}
              options={[
                { label: "True", value: "true" },
                { label: "False", value: "false" },
              ]}
              value={values.passValue}
            />
          ) : (
            <SelectField
              key="direction"
              label="Better score"
              labelClassName="type-label text-foreground"
              name="direction"
              onValueChange={(direction) => update({ ...values, direction })}
              options={[
                { label: "Higher", value: "higher_is_better" },
                { label: "Lower", value: "lower_is_better" },
              ]}
              value={values.direction}
            />
          )}
        </div>
        {values.scale === "numeric" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {numericFields.map(({ label, name }) => (
              <Field key={name} id={`${id}-${name}`} label={label} error={errors[name]}>
                <input
                  {...inputProps(name)}
                  className="ui-input"
                  required
                  step="any"
                  type="number"
                  value={values[name]}
                  onChange={(event) => update({ ...values, [name]: event.currentTarget.value })}
                />
              </Field>
            ))}
          </div>
        ) : null}
        {create ? (
          <details className="space-y-2">
            <summary className="type-label cursor-pointer">Advanced</summary>
            <Field id={`${id}-slug`} label="Identifier" error={errors.slug}>
              <p className="type-annotation text-muted" id={`${id}-slug-hint`}>
                Leave blank to generate a unique identifier from the name. Custom identifiers use
                lowercase letters, numbers, and hyphens.
              </p>
              <input
                {...inputProps("slug", `${id}-slug-hint`)}
                className="ui-input"
                maxLength={60}
                spellCheck={false}
                value={values.slug}
                onChange={(event) => update({ ...values, slug: event.currentTarget.value })}
              />
            </Field>
          </details>
        ) : null}
        <p className="type-secondary break-words text-muted">
          Publishing to <strong className="font-medium text-foreground">{factoryLabel}</strong>.
          Publishing doesn’t change active bindings.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {create && draft.preset ? (
            <button
              className="ui-button"
              type="button"
              onClick={(event) => {
                const restore = () => update(initial);
                if (guard) guard.guard(restore, event.currentTarget);
                else restore();
              }}
            >
              Restore preset
            </button>
          ) : null}
          <button
            className="ui-button"
            disabled={requiresReload}
            onClick={() => {
              if (parseDraft())
                setMessage({
                  kind: "success",
                  text: "Rubric settings are valid. No runs were evaluated.",
                });
            }}
            type="button"
          >
            Validate rubric
          </button>
          <button className="ui-button ui-button-primary" disabled={requiresReload} type="submit">
            <ActionButtonLabel
              idle={create ? "Publish scorer" : "Publish revision"}
              pending={action.isBusy}
              pendingLabel="Publishing…"
            />
          </button>
        </div>
      </fieldset>
      <InlineActionMessage message={message} />
    </form>
  );
  return create ? (
    form
  ) : (
    <PageSection
      anchorId="draft-rubric"
      statusBadge={<Status label="Draft" value="not_started" />}
      title="Draft rubric"
    >
      {form}
    </PageSection>
  );
}

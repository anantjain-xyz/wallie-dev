"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  planDraftReview,
  resolveDraftReview,
  type DraftInput,
} from "@/features/factory-definition/draft-review";
import type { SerialFactoryDefinition } from "@/lib/factory-definitions/schema";

type Choices = Record<string, "mine" | "latest">;

const outcomes = {
  conflict: "Changed in both versions. Choose which to keep.",
  mine: "Your edit will be applied.",
  latest: "The latest edit will be kept.",
  same: "Both versions already match.",
};

function showValue(value: unknown) {
  if (value === "" || value === undefined || value === null) return "Not set";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function DraftConflictReview({
  busy,
  input,
  latest,
  onApply,
  onDiscard,
  original,
}: {
  busy: boolean;
  input: DraftInput;
  latest: SerialFactoryDefinition | undefined;
  onApply: (source: SerialFactoryDefinition) => void;
  onDiscard: () => void;
  original: SerialFactoryDefinition;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [review, setReview] = useState<{
    input: DraftInput;
    latest: SerialFactoryDefinition;
    choices: Choices;
  }>();
  const plan = useMemo(
    () => latest && planDraftReview(original, input, latest),
    [original, input, latest],
  );
  const choices = review?.input === input && review.latest === latest ? review.choices : {};
  const ready =
    plan?.ok && plan.changes.every(({ kind, label }) => kind !== "conflict" || choices[label]);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <section
      aria-labelledby={id}
      className="space-y-4 rounded-[6px] border border-warning/20 bg-warning-soft p-4 sm:p-5"
      id="draft-conflict"
    >
      <div className="space-y-1">
        <h2
          className="type-section-title scroll-mt-8 text-foreground"
          id={id}
          ref={heading}
          tabIndex={-1}
        >
          Review draft changes
        </h2>
        <p className="type-secondary text-foreground">
          The saved draft or activation changed. Your unsaved edits are still here. Applying
          reviewed edits updates this editor only. Save separately when you’re ready.
        </p>
      </div>
      {!latest ? (
        <p className="type-secondary text-foreground">
          There’s no editable definition to apply these edits to. Keep your source or discard it to
          load the current state.
        </p>
      ) : plan?.ok ? (
        plan.changes.length ? (
          <ul className="divide-y divide-border rounded-md border border-border bg-sheet">
            {plan.changes.map(({ fields, kind, label }, index) => {
              const comparison = (
                <dl className="mt-2 grid min-w-0 gap-x-4 gap-y-1 sm:grid-cols-2">
                  <dt className="text-xs font-medium text-muted">Latest</dt>
                  <dd className="min-w-0 sm:col-start-1 sm:row-start-2">
                    {fields.map((field) => (
                      <div className="mb-2" key={field.label}>
                        {field.label !== label ? (
                          <p className="text-xs text-muted">{field.label}</p>
                        ) : null}
                        <pre className="whitespace-pre-wrap break-words text-sm">
                          {showValue(field.latest)}
                        </pre>
                      </div>
                    ))}
                  </dd>
                  <dt className="text-xs font-medium text-muted sm:col-start-2 sm:row-start-1">
                    Mine
                  </dt>
                  <dd className="min-w-0 sm:col-start-2 sm:row-start-2">
                    {fields.map((field) => (
                      <div className="mb-2" key={field.label}>
                        {field.label !== label ? (
                          <p className="text-xs text-muted">{field.label}</p>
                        ) : null}
                        <pre className="whitespace-pre-wrap break-words text-sm">
                          {showValue(field.mine)}
                        </pre>
                      </div>
                    ))}
                  </dd>
                </dl>
              );
              return (
                <li className="min-w-0 px-3 py-2" key={label}>
                  {kind === "conflict" ? (
                    <fieldset disabled={busy}>
                      <legend className="text-sm font-semibold">{label}</legend>
                      <p className="type-annotation text-muted">{outcomes[kind]}</p>
                      {comparison}
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {(["latest", "mine"] as const).map((choice) => (
                          <label className="flex min-h-8 items-center gap-2 text-sm" key={choice}>
                            <input
                              checked={choices[label] === choice}
                              name={`${id}-choice-${index}`}
                              onChange={() =>
                                setReview({
                                  input,
                                  latest,
                                  choices: { ...choices, [label]: choice },
                                })
                              }
                              type="radio"
                            />
                            {choice === "latest" ? "Keep latest" : "Keep mine"}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ) : (
                    <details>
                      <summary className="cursor-pointer text-sm font-medium">
                        {label} · {outcomes[kind]}
                      </summary>
                      {comparison}
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="type-secondary text-foreground">
            Your edits already match the latest definition.
          </p>
        )
      ) : (
        <p className="type-secondary text-foreground">
          Correct your source in the editor before reviewing it. {plan?.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className="ui-button-primary"
          disabled={busy || !ready}
          onClick={() => {
            if (!latest || !plan?.ok) return;
            const source = resolveDraftReview(latest, plan, choices);
            if (source) onApply(source);
          }}
          type="button"
        >
          Apply reviewed edits
        </button>
        <button className="ui-button" disabled={busy} onClick={onDiscard} type="button">
          Discard my edits
        </button>
      </div>
    </section>
  );
}

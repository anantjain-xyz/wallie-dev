import Link from "next/link";

import type { ContextDocumentReference } from "@/lib/factory-context/contracts";

import {
  displayedReference,
  ReferenceDetails,
  ReferencePicker,
  type ReferencePickerCatalog,
} from "./named-references";

export function ContextDocumentsEditor({
  catalog,
  contextHref,
  grant,
  value = [],
  proposal,
  onChange,
  disabled,
}: {
  catalog?: ReferencePickerCatalog;
  contextHref?: string;
  grant?: { id: string; version: number };
  value?: ContextDocumentReference[];
  proposal?: ContextDocumentReference;
  onChange: (value: ContextDocumentReference[] | undefined) => void;
  disabled?: boolean;
}) {
  const options = catalog?.options.context ?? [];
  const eligibleOptions = options.filter(
    (option) => option.grantId === grant?.id && option.version === grant?.version,
  );
  const proposed =
    proposal &&
    options.find(
      ({ id, sourceId }) => id === proposal.revisionId && sourceId === proposal.sourceId,
    );
  const alreadyPinned = Boolean(
    proposal &&
    value.some(
      ({ sourceId, revisionId }) =>
        sourceId === proposal.sourceId && revisionId === proposal.revisionId,
    ),
  );
  const canPropose = proposed && !proposed.unavailable && eligibleOptions.includes(proposed);

  function pin(reference: ContextDocumentReference) {
    const exists = value.some(({ sourceId }) => sourceId === reference.sourceId);
    if (exists)
      onChange(value.map((pin) => (pin.sourceId === reference.sourceId ? reference : pin)));
    else if (value.length < 8) onChange([...value, reference]);
  }

  return (
    <section
      aria-labelledby="definition-context-documents"
      className="min-w-0 space-y-3 border-t border-border pt-6"
    >
      <h3
        id="definition-context-documents"
        tabIndex={-1}
        className="type-section-title scroll-mt-8 text-foreground"
      >
        External context documents
      </h3>
      <p className="type-secondary text-muted">
        Pin one exact revision per source. New sessions use the published pins; syncing a source
        does not update them.
        {contextHref ? (
          <>
            {" "}
            <Link
              className="text-accent underline underline-offset-2"
              href={contextHref}
              target="_blank"
              rel="noreferrer"
            >
              Open Context (new tab)
            </Link>
            .
          </>
        ) : null}
      </p>
      {!grant ? (
        <p className="type-secondary text-muted">
          Choose the execution grant used to register the source before adding a document.
        </p>
      ) : null}
      {proposal && !alreadyPinned ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-sm">
            {displayedReference(proposed, "Requested Context revision unavailable")}
          </p>
          {proposed && !canPropose ? (
            <p className="type-annotation text-muted">
              The exact revision must be available under the selected execution grant and version.
            </p>
          ) : null}
          <button
            type="button"
            className="ui-button"
            disabled={
              disabled ||
              !canPropose ||
              (value.length >= 8 && !value.some(({ sourceId }) => sourceId === proposal.sourceId))
            }
            onClick={() => pin(proposal)}
          >
            {value.some(({ sourceId }) => sourceId === proposal.sourceId)
              ? "Replace pin with requested revision"
              : "Add requested revision to draft"}
          </button>
        </div>
      ) : null}
      {value.length ? (
        <ul
          aria-label="Pinned documents"
          className="divide-y divide-border rounded-md border border-border"
        >
          {value.map((pin, index) => {
            const option = options.find(
              ({ id, sourceId }) => id === pin.revisionId && sourceId === pin.sourceId,
            );
            const name = displayedReference(option, "Context revision unavailable");
            const incompatible = option && !eligibleOptions.includes(option);
            return (
              <li key={pin.sourceId} className="space-y-2 px-3 py-2">
                <p className="text-sm [overflow-wrap:anywhere]">
                  {name}
                  {incompatible ? " · Different grant or version" : ""}
                </p>
                <ReferenceDetails value={`${pin.sourceId} · ${pin.revisionId}`} />
                <div className="grid items-end gap-2 sm:grid-cols-[1fr_auto]">
                  <ReferencePicker
                    catalog={catalog}
                    kind="context"
                    label={`Replace document ${index + 1} revision`}
                    options={eligibleOptions.filter(
                      ({ sourceId, id }) => sourceId === pin.sourceId && id !== pin.revisionId,
                    )}
                    disabled={disabled || !grant}
                    value=""
                    empty="Keep this revision"
                    unavailable="Context revision unavailable"
                    onChange={(revisionId) => {
                      if (revisionId) pin({ ...pin, revisionId });
                    }}
                  />
                  <button
                    type="button"
                    className="ui-button"
                    aria-label={`Remove ${name}`}
                    disabled={disabled}
                    onClick={() => {
                      const remaining = value.filter(({ sourceId }) => sourceId !== pin.sourceId);
                      onChange(remaining.length ? remaining : undefined);
                    }}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="type-secondary text-muted">No external context documents pinned.</p>
      )}
      <ReferencePicker
        id="definition-field-contextDocuments"
        kind="context"
        catalog={catalog}
        label="Add a context document"
        disabled={disabled || !grant || value.length >= 8}
        options={eligibleOptions.filter(
          ({ sourceId }) => !value.some((pin) => pin.sourceId === sourceId),
        )}
        value=""
        empty="Choose an exact revision"
        unavailable="Context revision unavailable"
        onChange={(id) => {
          const selected = eligibleOptions.find((option) => option.id === id);
          if (selected?.sourceId) pin({ sourceId: selected.sourceId, revisionId: id });
        }}
      />
    </section>
  );
}

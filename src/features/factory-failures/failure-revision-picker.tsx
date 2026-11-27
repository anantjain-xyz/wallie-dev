"use client";

import { useState } from "react";

import { FILTER_CONTROL_CLASS } from "@/components/ui/filter-controls";
import { SelectField } from "@/components/ui/select";
import {
  failureRevisionPageSchema,
  type FailureRevisionOption,
  type FailureRevisionPage,
} from "@/lib/factory-failures/cohort-contracts";

export function FailureRevisionPicker({
  endpoint,
  initialPage,
  onValueChange,
  selected,
  pinned,
}: {
  endpoint: string;
  initialPage: FailureRevisionPage;
  onValueChange: (value: string) => void;
  selected: string;
  pinned: FailureRevisionOption[];
}) {
  const [olderPage, setOlderPage] = useState<FailureRevisionPage | null>(null);
  const [retained, setRetained] = useState<FailureRevisionOption>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const page = olderPage ?? initialPage;
  const options = Array.from(
    new Map(
      [...(retained ? [retained] : []), ...pinned, ...page.options].map((option) => [
        option.id,
        option,
      ]),
    ).values(),
  );

  async function loadOlder() {
    if (!page.next || pending) return;
    setPending(true);
    setFailed(false);
    try {
      const url = new URL(endpoint, window.location.origin);
      url.searchParams.set("before", page.next);
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error();
      setOlderPage(failureRevisionPageSchema.parse(await response.json()));
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-w-0 space-y-2">
      <SelectField
        name="revision"
        label="Factory definition revision"
        labelClassName="type-label"
        value={selected}
        onValueChange={(id) => {
          setRetained(options.find((option) => option.id === id));
          onValueChange(id);
        }}
        options={[
          { label: "Any revision", value: "" },
          ...options.map(({ id, label, detail }) => ({
            label: detail ? `${label} · ${detail}` : label,
            value: id,
          })),
        ]}
        triggerClassName={FILTER_CONTROL_CLASS}
        wrap
      />
      {olderPage || page.next ? (
        <div className="flex flex-wrap items-center gap-x-3">
          {olderPage ? (
            <button
              className="ui-button"
              type="button"
              onClick={() => {
                setOlderPage(null);
                setFailed(false);
              }}
              disabled={pending}
            >
              Latest revisions
            </button>
          ) : null}
          {page.next ? (
            <button className="ui-button" type="button" onClick={loadOlder} disabled={pending}>
              {pending ? "Loading revisions…" : "Older revisions"}
            </button>
          ) : null}
        </div>
      ) : null}
      <p className={pending || olderPage ? "type-annotation text-muted" : "sr-only"} role="status">
        {pending ? "Loading revisions…" : olderPage ? "Showing older revisions." : ""}
      </p>
      {failed ? (
        <p className="type-secondary text-muted" role="alert">
          Couldn’t load older revisions. Try again.
        </p>
      ) : null}
    </div>
  );
}

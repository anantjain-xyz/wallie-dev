"use client";

import { useState } from "react";

import { SelectField } from "@/components/ui/select";
import {
  failureRevisionPageSchema,
  type FailureRevisionOption,
  type FailureRevisionPage,
} from "@/lib/factory-failures/cohort-contracts";

export function FailureRevisionPicker({
  endpoint,
  initialPage,
  selected,
  pinned,
}: {
  endpoint: string;
  initialPage: FailureRevisionPage;
  selected: string;
  pinned: FailureRevisionOption[];
}) {
  const [page, setPage] = useState(initialPage);
  const [value, setValue] = useState(selected);
  const [retained, setRetained] = useState<FailureRevisionOption>();
  const [older, setOlder] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const options = Array.from(
    new Map(
      [...pinned, ...(retained ? [retained] : []), ...page.options].map((option) => [
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
      setPage(failureRevisionPageSchema.parse(await response.json()));
      setOlder(true);
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
        value={value}
        onValueChange={(id) => {
          setValue(id);
          setRetained(options.find((option) => option.id === id));
        }}
        options={[
          { label: "Any revision", value: "" },
          ...options.map(({ id, label, detail }) => ({
            label: detail ? `${label} · ${detail}` : label,
            value: id,
          })),
        ]}
        wrap
      />
      {older || page.next ? (
        <div className="flex flex-wrap items-center gap-x-3">
          {older ? (
            <button
              className="ui-button"
              type="button"
              onClick={() => {
                setPage(initialPage);
                setOlder(false);
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
      <p className="type-annotation text-muted" role="status">
        {pending ? "Loading revisions…" : older ? "Showing older revisions in the picker." : ""}
      </p>
      {failed ? (
        <p className="type-secondary text-muted" role="alert">
          Couldn’t load older revisions. Try again.
        </p>
      ) : null}
    </div>
  );
}

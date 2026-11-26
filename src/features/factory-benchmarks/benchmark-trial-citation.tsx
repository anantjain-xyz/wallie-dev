"use client";

import { useEffect, useRef, useState } from "react";

export function BenchmarkTrialCitation({ label, href }: { label: string; href: string }) {
  const [state, setState] = useState<
    { status: "loading" | "unavailable" | "retry" } | { status: "ready"; passage: string } | null
  >(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function load() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    setState({ status: "loading" });
    try {
      const response = await fetch(href, { signal, cache: "no-store" });
      if ([401, 403, 404, 410].includes(response.status)) {
        setState({ status: "unavailable" });
        return;
      }
      if (!response.ok) throw new Error();
      const { passage } = await response.json();
      signal.throwIfAborted();
      if (typeof passage !== "string") throw new Error();
      setState({ status: "ready", passage });
    } catch {
      if (!controller.signal.aborted) setState({ status: "retry" });
    } finally {
      request.current = null;
    }
  }

  return (
    <details
      className="rounded-md border border-border px-3 py-2"
      onToggle={(event) => {
        if (event.currentTarget.open && state === null) void load();
      }}
    >
      <summary className="type-label cursor-pointer">{label}</summary>
      {state?.status === "ready" ? (
        <pre
          aria-label={label}
          className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-md border border-border p-3 font-mono text-sm [overflow-wrap:anywhere]"
          role="region"
          tabIndex={0}
        >
          {state.passage}
        </pre>
      ) : (
        <p role="status" className="type-secondary mt-2 text-muted">
          {state?.status === "retry"
            ? "Couldn’t load the cited source."
            : state?.status === "unavailable"
              ? "Cited source isn’t viewable here."
              : "Loading cited source…"}
        </p>
      )}
      {state?.status === "retry" ? (
        <button className="ui-button mt-2" type="button" onClick={() => void load()}>
          Retry citation
        </button>
      ) : null}
    </details>
  );
}

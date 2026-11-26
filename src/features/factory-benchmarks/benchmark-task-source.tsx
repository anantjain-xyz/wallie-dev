import Link from "next/link";

import { workspaceRunDetailPath } from "@/lib/routes";

import type { BenchmarkTaskChoice } from "./suites-data";

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

export function BenchmarkTaskSource({
  canNavigate,
  source,
  workspaceSlug,
}: {
  canNavigate?: () => boolean;
  source: BenchmarkTaskChoice["source"];
  workspaceSlug: string;
}) {
  if (!source) return <span className="text-muted">Source run unavailable</span>;
  return (
    <div className="min-w-0 space-y-1.5 [overflow-wrap:anywhere]">
      <Link
        className="underline underline-offset-4"
        href={workspaceRunDetailPath(workspaceSlug, source.runId, { attempt: source.attempt })}
        onNavigate={
          canNavigate
            ? (event) => {
                if (!canNavigate()) event.preventDefault();
              }
            : undefined
        }
      >
        {[source.title, source.stage, source.attempt && `Attempt ${source.attempt}`]
          .filter(Boolean)
          .join(" · ")}
      </Link>
      <p className="type-secondary text-muted">{dateFormat.format(new Date(source.createdAt))}</p>
      <details className="type-secondary">
        <summary className="cursor-pointer text-muted">Technical details</summary>
        <p className="mt-1">
          Run ID: <code className="type-code select-all">{source.runId}</code>
        </p>
        {source.commit ? (
          <p>
            Input commit: <code className="type-code select-all">{source.commit}</code>
          </p>
        ) : null}
      </details>
    </div>
  );
}

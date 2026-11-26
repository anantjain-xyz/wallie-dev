"use client";

import { useParams, useSearchParams } from "next/navigation";

import { PageFailure } from "@/components/ui/page-failure";
import { workspaceBenchmarksPath } from "@/lib/routes";

export default function BenchmarkError({ reset }: { reset: () => void }) {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  const search = useSearchParams();
  return (
    <PageFailure
      reset={reset}
      returnHref={workspaceBenchmarksPath(workspaceSlug, {
        factory: search.get("factory") ?? undefined,
      })}
      returnLabel="Back to benchmarks"
    />
  );
}

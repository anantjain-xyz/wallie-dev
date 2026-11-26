"use client";

import { useParams } from "next/navigation";

import { PageFailure } from "@/components/ui/page-failure";
import { workspaceBenchmarksPath } from "@/lib/routes";

export default function BenchmarkTrialError({ reset }: { reset: () => void }) {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  return (
    <PageFailure
      reset={reset}
      returnHref={workspaceBenchmarksPath(workspaceSlug)}
      returnLabel="Back to Benchmarks"
    />
  );
}

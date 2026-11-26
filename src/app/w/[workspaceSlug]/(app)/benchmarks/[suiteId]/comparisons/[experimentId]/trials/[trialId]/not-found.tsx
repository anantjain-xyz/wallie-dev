"use client";

import { useParams } from "next/navigation";

import { PageFailure } from "@/components/ui/page-failure";
import { workspaceBenchmarksPath } from "@/lib/routes";

export default function BenchmarkTrialNotFound() {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  return (
    <PageFailure
      notFound
      returnHref={workspaceBenchmarksPath(workspaceSlug)}
      returnLabel="Back to Benchmarks"
    />
  );
}

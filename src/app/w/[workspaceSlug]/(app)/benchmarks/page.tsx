import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { benchmarkPurposeLabel } from "@/features/factory-benchmarks/curation-labels";
import { SuiteCurationForm } from "@/features/factory-benchmarks/suite-curation-form";
import {
  loadBenchmarkScope,
  loadBenchmarkSuites,
  loadBenchmarkTaskChoices,
} from "@/features/factory-benchmarks/suites-data";
import { workspaceBenchmarksPath, workspaceBenchmarkSuitePath } from "@/lib/routes";

export default async function BenchmarksPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{
    factory?: string | string[];
    after?: string | string[];
    newSuite?: string | string[];
  }>;
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const after = z.string().uuid().optional().safeParse(query.after);
  if (!after.success) notFound();
  const scope = await loadBenchmarkScope(workspaceSlug, query.factory);
  if (!scope) return <FactoryUnavailable title="Benchmarks" />;

  const { factory, workspaceId, canEdit } = scope;
  const factoryQuery = { factory: factory.id };
  const creating = canEdit && query.newSuite === "1";
  const [{ suites, nextAfter }, choices] = await Promise.all([
    loadBenchmarkSuites(scope, after.data),
    creating ? loadBenchmarkTaskChoices(scope) : [],
  ]);
  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        title="Benchmarks"
        description={factory.status === "archived" ? `${factory.name} · Archived` : factory.name}
        actionsRightOnDesktop
        actions={
          canEdit ? (
            <Link
              className="ui-button ui-button-primary"
              href={`${workspaceBenchmarksPath(workspaceSlug, { ...factoryQuery, after: after.data, newSuite: "1" })}#new-suite`}
            >
              New suite
            </Link>
          ) : null
        }
      />
      <div className="space-y-8">
        <section aria-label="Benchmark suites" className="ui-sheet divide-y divide-border">
          {suites.length ? (
            <ul className="divide-y divide-border">
              {suites.map((suite) => (
                <li className="min-w-0 px-4 py-4 sm:px-5" key={suite.suite_id}>
                  <Link
                    className="break-words font-semibold text-foreground underline-offset-4 hover:text-accent hover:underline"
                    href={workspaceBenchmarkSuitePath(workspaceSlug, suite.suite_id, factoryQuery)}
                  >
                    {suite.name}
                  </Link>
                  <p className="type-annotation mt-1 text-muted">
                    {benchmarkPurposeLabel(suite.purpose)} · Revision {suite.revision_number}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-secondary px-4 py-5 text-muted sm:px-5">
              {after.data
                ? "No benchmark suites on this page."
                : "No benchmark suites in this factory yet."}
            </p>
          )}
          {after.data || nextAfter ? (
            <div className="flex flex-wrap gap-2 px-4 py-3 sm:px-5">
              {after.data ? (
                <Link
                  className="ui-button"
                  href={workspaceBenchmarksPath(workspaceSlug, factoryQuery)}
                >
                  First page
                </Link>
              ) : null}
              {nextAfter ? (
                <Link
                  className="ui-button"
                  href={workspaceBenchmarksPath(workspaceSlug, {
                    ...factoryQuery,
                    after: nextAfter,
                  })}
                >
                  More suites
                </Link>
              ) : null}
            </div>
          ) : null}
        </section>
        {creating ? (
          <PageSection anchorId="new-suite" title="New suite">
            <SuiteCurationForm
              key={factory.id}
              factoryId={factory.id}
              workspaceId={workspaceId}
              workspaceSlug={workspaceSlug}
              taskChoices={choices}
            />
          </PageSection>
        ) : null}
      </div>
    </PageContainer>
  );
}

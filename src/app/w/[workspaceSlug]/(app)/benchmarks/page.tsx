import Link from "next/link";
import { z } from "zod";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { SelectField } from "@/components/ui/select";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { FactorySelector } from "@/features/factories/factory-selector";
import { BenchmarkCatalogEditor } from "@/features/factory-benchmarks/benchmark-catalog-editor";
import { benchmarkPurposeLabel } from "@/features/factory-benchmarks/curation-labels";
import {
  hasBenchmarkTasks,
  loadBenchmarkScope,
  loadBenchmarkSuites,
  loadBenchmarkTaskChoices,
} from "@/features/factory-benchmarks/suites-data";
import {
  workspaceBenchmarksPath,
  workspaceBenchmarkSuitePath,
  workspaceRunsPath,
  workspaceSessionsPath,
} from "@/lib/routes";

const dateFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export default async function BenchmarksPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const after = z.string().uuid().optional().safeParse(query.after);
  const name = typeof query.q === "string" ? query.q.trim().slice(0, 120) : "";
  const purpose =
    query.purpose === "holdout" || query.purpose === "regression" ? query.purpose : undefined;
  const [scope, factories] = await Promise.all([
    loadBenchmarkScope(workspaceSlug, query.factory),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  if (!scope) {
    return (
      <PageContainer className="pt-5 sm:pt-10">
        <PageHeader
          title="Benchmarks"
          actionsRightOnDesktop
          actions={
            factories.length ? (
              <FactorySelector
                factories={factories}
                resetParams={["newSuite"]}
                selectedValue="unavailable"
              />
            ) : undefined
          }
        />
        <section className="ui-sheet space-y-2 px-4 py-5 sm:px-5">
          <h2 className="type-section-title">
            {factories.length ? "Factory unavailable" : "No visible factories"}
          </h2>
          <p className="type-secondary text-muted">
            {factories.length
              ? "Choose another factory to see its benchmark suites."
              : "No factories are visible to you in this workspace."}
          </p>
          {!factories.length ? (
            <Link
              className="ui-button mt-2"
              href={workspaceSessionsPath(workspaceSlug, { factory: "all" })}
            >
              View accessible sessions
            </Link>
          ) : null}
        </section>
      </PageContainer>
    );
  }

  const { factory, workspaceId, canEdit } = scope;
  const factoryQuery = { factory: factory.id };
  const filters = { ...factoryQuery, q: name || undefined, purpose };
  const catalogPath = workspaceBenchmarksPath(workspaceSlug);
  const firstPage = workspaceBenchmarksPath(workspaceSlug, filters);
  const currentPage = workspaceBenchmarksPath(workspaceSlug, { ...filters, after: after.data });
  const filtered = Boolean(name || purpose);
  if (canEdit && query.newSuite === "1") {
    const choices = await loadBenchmarkTaskChoices(scope);
    return (
      <PageContainer className="pt-5 sm:pt-10">
        <BenchmarkCatalogEditor
          catalogHref={currentPage}
          factories={factories}
          factoryId={factory.id}
          key={factory.id}
          taskChoices={choices}
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
        />
      </PageContainer>
    );
  }

  const { suites, nextAfter } = after.success
    ? await loadBenchmarkSuites(scope, { after: after.data, name, purpose })
    : { suites: [], nextAfter: undefined };
  const emptyCatalog = after.success && !after.data && !filtered && !suites.length;
  const firstRun = emptyCatalog && canEdit && !(await hasBenchmarkTasks(scope));
  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        title="Benchmarks"
        description="Build suites of captured tasks to compare factory configurations against the same work."
        actionsRightOnDesktop
        actions={
          <>
            <FactorySelector
              factories={factories}
              resetParams={["newSuite"]}
              selectedValue={factory.id}
            />
            {canEdit ? (
              <Link
                className="ui-button ui-button-primary"
                href={`${workspaceBenchmarksPath(workspaceSlug, { ...filters, after: after.data, newSuite: "1" })}#new-suite`}
              >
                New suite
              </Link>
            ) : null}
          </>
        }
      />
      {!canEdit ? (
        <p className="type-secondary mb-4 text-muted">
          {factory.status === "archived"
            ? "This factory is archived. Existing suites are read-only."
            : "Only factory managers can create or edit benchmark suites."}
        </p>
      ) : null}
      <section aria-label="Benchmark suites" className="ui-sheet divide-y divide-border">
        <form
          action={catalogPath}
          className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,0.45fr)_auto] sm:items-end sm:px-5"
          key={firstPage}
          role="search"
          aria-label="Benchmark suites"
        >
          <input name="factory" type="hidden" value={factory.id} />
          <label className="block min-w-0 space-y-1.5">
            <span className="type-label">Suite name</span>
            <input
              className="ui-input"
              defaultValue={name}
              maxLength={120}
              name="q"
              type="search"
            />
          </label>
          <SelectField
            defaultValue={purpose ?? "all"}
            label="Purpose"
            labelClassName="type-label"
            name="purpose"
            options={[
              { label: "Any purpose", value: "all" },
              { label: "Regression", value: "regression" },
              { label: "Holdout", value: "holdout" },
            ]}
          />
          <div className="flex flex-wrap gap-2">
            <button className="ui-button" type="submit">
              Search
            </button>
            {filtered ? (
              <Link
                className="ui-button"
                href={workspaceBenchmarksPath(workspaceSlug, factoryQuery)}
              >
                Clear filters
              </Link>
            ) : null}
          </div>
        </form>
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
                <p className="type-secondary mt-1 text-muted">
                  {benchmarkPurposeLabel(suite.purpose)} · Revision {suite.revision_number} ·{" "}
                  {suite.task_count === 0
                    ? "No tasks"
                    : `${suite.task_count} ${suite.task_count === 1 ? "task" : "tasks"}`}
                  {" · Saved "}
                  <time dateTime={suite.created_at}>
                    {dateFormat.format(new Date(suite.created_at))} UTC
                  </time>
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <div className="type-secondary space-y-2 px-4 py-5 text-muted sm:px-5">
            <p>
              {!after.success
                ? "This page link is invalid. Return to the first page to continue."
                : after.data
                  ? "No benchmark suites on this page."
                  : filtered
                    ? "No benchmark suites match these filters."
                    : "No benchmark suites in this factory yet."}
            </p>
            {firstRun ? (
              <>
                <p>Open a finished run and choose “Add to benchmark” to capture your first task.</p>
                <Link className="ui-button" href={workspaceRunsPath(workspaceSlug, factoryQuery)}>
                  Browse runs
                </Link>
              </>
            ) : null}
          </div>
        )}
        {!after.success || after.data || nextAfter ? (
          <nav
            aria-label="Benchmark suite pages"
            className="flex flex-wrap gap-2 px-4 py-3 sm:px-5"
          >
            {!after.success || after.data ? (
              <Link className="ui-button" href={firstPage}>
                First page
              </Link>
            ) : null}
            {nextAfter ? (
              <Link
                className="ui-button"
                href={workspaceBenchmarksPath(workspaceSlug, { ...filters, after: nextAfter })}
              >
                More suites
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </PageContainer>
  );
}

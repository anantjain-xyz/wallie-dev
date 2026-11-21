import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { TimeDisplay } from "@/components/shared/time-display";
import {
  MetadataItem,
  MetadataList,
  PageContainer,
  PageHeader,
  PageSection,
} from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import {
  benchmarkEligibilityLabel,
  benchmarkPurposeLabel,
} from "@/features/factory-benchmarks/curation-labels";
import { SuiteCurationForm } from "@/features/factory-benchmarks/suite-curation-form";
import {
  loadBenchmarkScope,
  loadBenchmarkSuiteDetail,
} from "@/features/factory-benchmarks/suites-data";
import { TaskCurationEditor } from "@/features/factory-benchmarks/task-curation-editor";
import {
  workspaceBenchmarksPath,
  workspaceBenchmarkSuitePath,
  workspaceRunDetailPath,
} from "@/lib/routes";

const pageQuery = z.object({
  revision: z.string().uuid().optional(),
  before: z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().max(2_147_483_647))
    .optional(),
});

export default async function BenchmarkSuitePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string; suiteId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug, suiteId: rawSuiteId }, query] = await Promise.all([params, searchParams]);
  const suiteId = z.string().uuid().safeParse(rawSuiteId);
  const page = pageQuery.safeParse(query);
  if (!suiteId.success || !page.success) notFound();
  const scope = await loadBenchmarkScope(workspaceSlug, query.factory, suiteId.data);
  if (!scope) notFound();
  const detail = await loadBenchmarkSuiteDetail(scope, {
    suiteId: suiteId.data,
    revisionId: page.data.revision,
    before: page.data.before,
    edit: query.edit === "suite",
  });
  if (!detail) notFound();
  const { factory, workspaceId } = scope;
  const { selected, latest, editable, members, latestTasks, choices, revisions, nextBefore } =
    detail;
  const editing = editable && query.edit === "suite";
  const factoryQuery = { factory: factory.id };
  const suitePath = (extra?: Parameters<typeof workspaceBenchmarkSuitePath>[2]) =>
    workspaceBenchmarkSuitePath(workspaceSlug, selected.suite_id, { ...factoryQuery, ...extra });
  const historical = selected.id !== latest.id;
  const now = new Date().toISOString();
  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        title={selected.name}
        description={`${factory.name} · ${benchmarkPurposeLabel(selected.purpose)}${factory.status === "archived" ? " · Archived" : ""}`}
        eyebrow={
          <Link
            className="hover:text-foreground"
            href={workspaceBenchmarksPath(workspaceSlug, factoryQuery)}
          >
            ← Benchmarks
          </Link>
        }
        eyebrowAsPlain
        actionsRightOnDesktop
        actions={
          editable ? (
            <Link
              className="ui-button ui-button-primary"
              href={`${suitePath({ edit: "suite" })}#edit-suite`}
            >
              Edit suite
            </Link>
          ) : historical ? (
            <Link className="ui-button" href={suitePath()}>
              View latest revision
            </Link>
          ) : null
        }
      />
      <div className="space-y-8">
        <PageSection
          title="Suite membership"
          statusBadge={
            <Status
              label={`Revision ${selected.revision_number}${historical ? " · Historical" : ""}`}
              value={historical ? "archived" : "approved"}
            />
          }
        >
          <div className="ui-sheet divide-y divide-border">
            {selected.selection_tags ? (
              <p className="type-secondary px-4 py-3 text-muted [overflow-wrap:anywhere] sm:px-5">
                Selection tags: {selected.selection_tags.join(", ")}
              </p>
            ) : null}
            {members.length ? (
              <ul className="divide-y divide-border">
                {members.map((task) => {
                  const latestTask = latestTasks.get(task.task_id);
                  const availability = benchmarkEligibilityLabel(task.replay_eligibility);
                  return (
                    <li className="min-w-0 space-y-3 px-4 py-4 sm:px-5" key={task.id}>
                      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <h3 className="type-label min-w-0 break-words text-foreground">
                          {task.name}
                        </h3>
                        <p className="type-annotation text-muted">{availability}</p>
                      </div>
                      {task.eligibility_reason ? (
                        <p className="type-secondary whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">
                          {task.eligibility_reason}
                        </p>
                      ) : null}
                      <details className="rounded-md border border-border">
                        <summary className="type-label cursor-pointer px-3 py-2.5">
                          Task details
                        </summary>
                        <div className="space-y-3 px-3 pb-3">
                          <MetadataList>
                            <MetadataItem label="Task revision" value={task.revision_number} />
                            <MetadataItem
                              label="Tags"
                              value={task.tags.length ? task.tags.join(", ") : "None"}
                            />
                            <MetadataItem label="Replay eligibility" value={availability} />
                            <MetadataItem
                              label="Source run"
                              value={
                                <Link
                                  className="underline underline-offset-4"
                                  href={workspaceRunDetailPath(workspaceSlug, task.sourceRunId)}
                                >
                                  View source run
                                </Link>
                              }
                            />
                          </MetadataList>
                          <div>
                            <h4 className="type-label mb-1 text-foreground">Acceptance criteria</h4>
                            <p className="type-secondary whitespace-pre-wrap [overflow-wrap:anywhere]">
                              {task.acceptance_criteria}
                            </p>
                          </div>
                        </div>
                      </details>
                      {latestTask && latestTask.id !== task.id ? (
                        <p className="type-secondary text-muted">
                          Task revision {latestTask.revision_number} is available to select in a new
                          suite revision.
                        </p>
                      ) : null}
                      {latestTask ? (
                        <TaskCurationEditor
                          workspaceId={workspaceId}
                          factoryId={factory.id}
                          revision={latestTask}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="type-secondary px-4 py-5 text-muted sm:px-5">
                No tasks were saved in this revision.
              </p>
            )}
          </div>
        </PageSection>
        {editing ? (
          <PageSection anchorId="edit-suite" title="Edit suite">
            <SuiteCurationForm
              key={selected.id}
              workspaceId={workspaceId}
              workspaceSlug={workspaceSlug}
              factoryId={factory.id}
              taskChoices={choices}
              draft={{
                suiteId: selected.suite_id,
                revisionId: selected.id,
                name: selected.name,
                purpose: selected.purpose,
                selectionTags: selected.selection_tags,
                members,
              }}
            />
          </PageSection>
        ) : null}
        <PageSection title="Revision history">
          <div className="ui-sheet divide-y divide-border">
            {revisions.length ? (
              <ul className="divide-y divide-border">
                {revisions.map((entry) => (
                  <li
                    className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5"
                    key={entry.id}
                  >
                    <Link
                      aria-current={entry.id === selected.id ? "page" : undefined}
                      className="type-label text-foreground underline-offset-4 hover:text-accent hover:underline"
                      href={suitePath({ revision: entry.id, before: page.data.before })}
                    >
                      Revision {entry.revision_number}
                    </Link>
                    <span className="type-annotation text-muted">
                      {benchmarkPurposeLabel(entry.purpose)} ·{" "}
                      <TimeDisplay initialNow={now} value={entry.created_at} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="type-secondary px-4 py-3 text-muted sm:px-5">
                No older revisions on this page.
              </p>
            )}
            {page.data.before || nextBefore ? (
              <div className="flex flex-wrap gap-2 px-4 py-3 sm:px-5">
                {page.data.before ? (
                  <Link className="ui-button" href={suitePath({ revision: selected.id })}>
                    Latest history
                  </Link>
                ) : null}
                {nextBefore ? (
                  <Link
                    className="ui-button"
                    href={suitePath({ revision: selected.id, before: nextBefore })}
                  >
                    Older revisions
                  </Link>
                ) : null}
              </div>
            ) : null}
          </div>
        </PageSection>
      </div>
    </PageContainer>
  );
}

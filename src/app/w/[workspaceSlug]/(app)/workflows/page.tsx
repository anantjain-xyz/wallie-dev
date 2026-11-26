import Form from "next/form";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { sessionLaunchHref } from "@/components/app-shell/shell-navigation";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { FactorySelector } from "@/features/factories/factory-selector";
import { loadWorkflowAuthoringScope } from "@/features/factory-workflows/authoring-page-data";
import { CreateWorkflowForm } from "@/features/factory-workflows/create-workflow-form";
import {
  workflowDirectoryAvailability,
  workflowTemplateLabel,
} from "@/features/factory-workflows/workflow-directory-state";
import { shouldShowOnboardingResumeCta } from "@/features/onboarding/resume";
import { isWorkspaceOperator } from "@/features/workspaces/authenticated-context";
import { loadWorkspaceLayoutContext } from "@/features/workspaces/workspace-layout-data";
import { directoryQuerySchema, loadWorkflowDirectory } from "@/lib/factory-workflows/directory";
import { loadWorkflowTemplatePrerequisites } from "@/lib/factory-workflows/reference-catalog";
import {
  workflowAuthoringApiPath,
  workspaceFactoryDefinitionPath,
  workspaceOnboardingPath,
  workspaceSessionsPath,
  workspaceSettingsPath,
  workspaceWorkflowDetailPath,
  workspaceWorkflowsPath,
} from "@/lib/routes";

const createdDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

type Props = {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{
    factory?: string | string[];
    after?: string | string[];
    q?: string | string[];
  }>;
};

export default function WorkflowsPage(props: Props) {
  return (
    <Suspense
      fallback={
        <PageContainer>
          <PageHeader title="Workflows" />
          <p className="type-secondary text-muted" role="status">
            Loading workflows…
          </p>
        </PageContainer>
      }
    >
      <WorkflowDirectory {...props} />
    </Suspense>
  );
}

async function WorkflowDirectory({ params, searchParams }: Props) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const scope = await loadWorkflowAuthoringScope(workspaceSlug, query.factory);
  const { factory, factories, workspaceId, supabase, currentMember } = scope;
  const header = (
    <PageHeader
      title="Workflows"
      description="Find, edit, and publish graph workflows for a factory."
      actionsRightOnDesktop
      actions={
        factories.length ? (
          <FactorySelector
            factories={factories}
            selectedValue={factory?.id ?? ""}
            resetParams={["after"]}
          />
        ) : undefined
      }
    />
  );
  const selection = directoryQuerySchema.safeParse(query);
  if (factory && !selection.success) {
    redirect(workspaceWorkflowsPath(workspaceSlug, { factory: factory.id }));
  }

  const directory =
    factory && selection.success
      ? await loadWorkflowDirectory(
          supabase,
          { workspaceId, factoryId: factory.id },
          selection.data,
        )
      : null;
  if (!factory || !directory || !selection.success) {
    return (
      <PageContainer>
        {header}
        <section className="ui-sheet space-y-3 p-5" aria-labelledby="workflow-scope">
          <h2 id="workflow-scope" className="type-section-title">
            Factory unavailable
          </h2>
          <p className="type-secondary text-muted">
            {factories.length
              ? "Choose an active factory you manage to see its workflows."
              : "You need to manage an active factory to view and edit its workflows."}
          </p>
          <Link
            className="ui-button w-fit"
            href={workspaceSessionsPath(workspaceSlug, { factory: "all" })}
          >
            View accessible sessions
          </Link>
        </section>
      </PageContainer>
    );
  }

  const { id: factoryId, name: factoryName, isDefault } = factory;
  const directoryScope = { workspaceId, factoryId, supabase };
  const [prerequisites, { onboarding }] = await Promise.all([
    loadWorkflowTemplatePrerequisites(directoryScope, directory.baseDefinition),
    loadWorkspaceLayoutContext(workspaceSlug),
  ]);
  const setupRequired = shouldShowOnboardingResumeCta(onboarding);
  const { q, after } = selection.data;
  const directoryHref = workspaceWorkflowsPath(workspaceSlug, {
    factory: factoryId,
    ...(q ? { q } : {}),
    after,
  });
  const firstHref = workspaceWorkflowsPath(workspaceSlug, {
    factory: factoryId,
    q: q || undefined,
  });
  const clearHref = workspaceWorkflowsPath(workspaceSlug, { factory: factoryId });
  return (
    <PageContainer>
      {header}
      <div className="grid min-w-0 gap-8">
        <section className="ui-sheet grid gap-4 p-4 sm:p-5" aria-labelledby="workflow-directory">
          <h2 id="workflow-directory" className="type-section-title">
            Factory workflows
          </h2>
          {!isDefault ? (
            <p className="type-secondary text-muted">
              You can edit and publish workflows for {factoryName} here. New session only opens in
              the workspace’s default factory.
            </p>
          ) : null}
          <Form
            action={workspaceWorkflowsPath(workspaceSlug)}
            className="grid max-w-xl gap-2"
            role="search"
            aria-label="Factory workflows"
          >
            <input type="hidden" name="factory" value={factoryId} />
            <label className="type-label" htmlFor="workflow-search">
              Search workflow names
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                key={q ?? ""}
                id="workflow-search"
                name="q"
                type="search"
                className="ui-input w-auto min-w-0 flex-1"
                maxLength={120}
                defaultValue={q}
              />
              <button type="submit" className="ui-button">
                Search
              </button>
              {q ? (
                <Link className="ui-button" href={clearHref}>
                  Clear
                </Link>
              ) : null}
            </div>
          </Form>
          {directory.cursorUnavailable ? (
            <p className="type-secondary text-muted">
              This page of results is no longer available.{" "}
              <Link href={firstHref} className="underline underline-offset-4">
                Return to the first page
              </Link>
            </p>
          ) : directory.workflows.length ? (
            <ul className="divide-y divide-border border-y border-border">
              {directory.workflows.map((workflow) => {
                const { workflowId, displayName, createdAt, publication, draftRevision, template } =
                  workflow;
                const editHref = workspaceWorkflowDetailPath(workspaceSlug, workflowId, {
                  factory: factoryId,
                });
                const availability = workflowDirectoryAvailability(publication?.intake, {
                  isDefault,
                  setupRequired,
                });
                return (
                  <li
                    key={workflowId}
                    id={`workflow-${workflowId}`}
                    className="scroll-mt-6 space-y-3 py-4"
                  >
                    <div className="min-w-0 space-y-1">
                      <h3 className="font-medium wrap-anywhere">
                        <Link
                          href={editHref}
                          className="inline-flex flex-wrap items-baseline gap-x-2 rounded-sm underline-offset-4"
                          aria-describedby={`workflow-meta-${workflowId}`}
                        >
                          <span className="min-w-0">{displayName}</span>
                          <span className="type-secondary text-muted underline">Edit draft</span>
                        </Link>
                      </h3>
                      <p id={`workflow-meta-${workflowId}`} className="type-secondary text-muted">
                        {workflowTemplateLabel(template)} · Created{" "}
                        <time dateTime={createdAt}>{createdDate.format(new Date(createdAt))}</time>
                      </p>
                    </div>
                    <dl className="grid gap-x-5 gap-y-2 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
                      <div>
                        <dt className="type-label text-muted">Working draft</dt>
                        <dd>
                          {draftRevision === null ? "Not saved yet" : `Draft ${draftRevision}`}
                        </dd>
                      </div>
                      <div>
                        <dt className="type-label text-muted">Published version</dt>
                        <dd>
                          {publication
                            ? `Version ${publication.number} · Draft ${publication.draftRevision}`
                            : "Not published"}
                        </dd>
                      </div>
                      <div>
                        <dt className="type-label text-muted">New sessions</dt>
                        <dd className={availability.canLaunch ? "text-success" : undefined}>
                          {availability.message}
                        </dd>
                      </div>
                    </dl>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                      {publication ? (
                        <Link
                          href={workspaceWorkflowDetailPath(workspaceSlug, workflowId, {
                            factory: factoryId,
                            draft: publication.draftId,
                          })}
                          className="underline underline-offset-4"
                          aria-label={`View published revision: ${displayName}, version ${publication.number}`}
                        >
                          View published revision
                        </Link>
                      ) : null}
                      {publication && availability.canLaunch ? (
                        <Link
                          className="ui-button max-w-full text-left whitespace-normal wrap-anywhere"
                          href={sessionLaunchHref(
                            workspaceSlug,
                            factoryId,
                            `${directoryHref}#workflow-${workflowId}`,
                            publication.activationId,
                          )}
                          aria-label={`Start in ${factoryName}: ${displayName}`}
                          aria-describedby={`workflow-meta-${workflowId}`}
                          prefetch={false}
                        >
                          Start in {factoryName}
                        </Link>
                      ) : publication?.intake === "eligible" && isDefault && setupRequired ? (
                        <Link
                          className="underline underline-offset-4"
                          href={workspaceOnboardingPath(workspaceSlug)}
                        >
                          Resume workspace setup
                        </Link>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="type-secondary text-muted">
              {q
                ? "No workflows match that name in this factory."
                : "No workflows in this factory yet."}
            </p>
          )}
          {(after && !directory.cursorUnavailable) || directory.nextAfterId ? (
            <nav aria-label="Workflow pagination" className="flex flex-wrap gap-2">
              {after && !directory.cursorUnavailable ? (
                <Link className="ui-button" href={firstHref}>
                  First page
                </Link>
              ) : null}
              {directory.nextAfterId ? (
                <Link
                  className="ui-button"
                  href={workspaceWorkflowsPath(workspaceSlug, {
                    factory: factoryId,
                    q: q || undefined,
                    after: directory.nextAfterId,
                  })}
                >
                  Next workflows
                </Link>
              ) : null}
            </nav>
          ) : null}
        </section>
        <section className="ui-sheet grid gap-4 p-4 sm:p-5" aria-labelledby="workflow-create">
          <h2 id="workflow-create" className="type-section-title">
            Create a workflow
          </h2>
          <CreateWorkflowForm
            key={factoryId}
            endpoint={workflowAuthoringApiPath(workspaceId, factoryId)}
            factoryId={factoryId}
            workspaceSlug={workspaceSlug}
            prerequisites={prerequisites}
            setupHref={
              isWorkspaceOperator(currentMember)
                ? workspaceFactoryDefinitionPath(workspaceSlug, { factory: factoryId })
                : undefined
            }
          />
        </section>
        <Link
          className="w-fit text-sm text-muted underline underline-offset-4"
          href={`${workspaceSettingsPath(workspaceSlug, { category: "integrations" })}#pipeline`}
        >
          Open serial pipeline settings
        </Link>
      </div>
    </PageContainer>
  );
}

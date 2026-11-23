import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { FactorySelector } from "@/features/factories/factory-selector";
import { loadWorkflowAuthoringPageScope } from "@/features/factory-workflows/authoring-page-data";
import { CreateWorkflowForm } from "@/features/factory-workflows/create-workflow-form";
import { listWorkflowAuthoring } from "@/lib/factory-workflows/authoring";
import {
  workspaceSettingsPath,
  workspaceWorkflowDetailPath,
  workspaceWorkflowsPath,
  workflowAuthoringApiPath,
} from "@/lib/routes";

const cursorSchema = z.string().uuid().toLowerCase().optional();

export default async function WorkflowsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{ factory?: string | string[]; after?: string | string[] }>;
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const cursor = cursorSchema.safeParse(query.after);
  if (!cursor.success) notFound();
  const { workspaceId, factoryId, factories, supabase } = await loadWorkflowAuthoringPageScope(
    workspaceSlug,
    query.factory,
  );
  const result = await listWorkflowAuthoring(supabase, { workspaceId, factoryId }, cursor.data);
  if (!result) notFound();
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-7 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
        <h1 className="type-page-title">Workflows</h1>
        <FactorySelector factories={factories} selectedValue={factoryId} resetParams={["after"]} />
      </header>
      <section className="grid gap-4" aria-label="Graph workflows">
        <CreateWorkflowForm
          endpoint={workflowAuthoringApiPath(workspaceId, factoryId)}
          factoryId={factoryId}
          workspaceSlug={workspaceSlug}
        />
        {result.workflows.length ? (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {result.workflows.map((workflow) => (
              <li key={workflow.workflowId}>
                <Link
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-muted/10"
                  href={workspaceWorkflowDetailPath(workspaceSlug, workflow.workflowId, {
                    factory: factoryId,
                  })}
                >
                  <span className="break-words font-medium">{workflow.displayName}</span>
                  <span className="text-sm text-muted">
                    {workflow.activationId
                      ? workflow.publishedDraftId === workflow.draftId
                        ? "Published"
                        : "Published · New draft"
                      : workflow.draftId
                        ? "Draft"
                        : "No draft"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No workflows in this factory yet.</p>
        )}
        {result.nextAfterId ? (
          <Link
            className="ui-button w-fit"
            href={workspaceWorkflowsPath(workspaceSlug, {
              factory: factoryId,
              after: result.nextAfterId,
            })}
          >
            Next workflows
          </Link>
        ) : null}
      </section>
      <Link
        className="w-fit text-sm text-muted underline underline-offset-4"
        href={`${workspaceSettingsPath(workspaceSlug, { category: "integrations" })}#pipeline`}
      >
        Open serial pipeline settings
      </Link>
    </div>
  );
}

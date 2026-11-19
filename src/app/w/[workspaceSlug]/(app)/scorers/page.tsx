import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { ScorerForm } from "@/features/factory-scorers/scorer-form";
import {
  loadScorerPageScope,
  readScorerRevisionOwner,
} from "@/features/factory-scorers/scorer-pages-data";
import { listFactoryScorers } from "@/lib/factory-scorers/service";
import { workspaceScorerDetailPath, workspaceScorersPath } from "@/lib/routes";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export default async function ScorersPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{
    factory?: string | string[];
    after?: string | string[];
    revision?: string | string[];
  }>;
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const scope = await loadScorerPageScope(workspaceSlug, query.factory);
  if (!scope) return <FactoryUnavailable title="Scorers" />;

  const { factory, canEdit, supabase, workspaceId } = scope;
  const factoryQuery = { factory: factory.id };
  if (query.revision !== undefined) {
    const revision = uuid.safeParse(query.revision);
    if (!revision.success) notFound();
    const scorerId = await readScorerRevisionOwner(scope, revision.data);
    if (!scorerId) notFound();
    redirect(
      workspaceScorerDetailPath(workspaceSlug, scorerId, {
        ...factoryQuery,
        revision: revision.data,
      }),
    );
  }

  const after = uuid.optional().safeParse(query.after);
  if (!after.success) notFound();
  const { scorers, nextAfterId } = await listFactoryScorers(supabase, {
    workspaceId,
    factoryId: factory.id,
    afterId: after.data,
    limit: 30,
  });

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        actions={
          canEdit ? (
            <Link className="ui-button ui-button-primary" href="#new-scorer">
              New scorer
            </Link>
          ) : undefined
        }
        actionsRightOnDesktop
        description={factory.status === "archived" ? `${factory.name} · Archived` : factory.name}
        title="Scorers"
      />
      <div className="space-y-8">
        <section aria-label="Factory scorers" className="ui-sheet divide-y divide-border">
          {scorers.length ? (
            <ul className="divide-y divide-border">
              {scorers.map((scorer) => (
                <li className="min-w-0 px-4 py-4 sm:px-5" key={scorer.id}>
                  <Link
                    className="break-words font-semibold text-foreground underline-offset-4 hover:text-accent hover:underline"
                    href={workspaceScorerDetailPath(workspaceSlug, scorer.id, factoryQuery)}
                  >
                    {scorer.name}
                  </Link>
                  <p className="type-annotation mt-1 break-words text-muted">{scorer.slug}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-secondary px-4 py-5 text-muted sm:px-5">
              {after.data ? "No scorers on this page." : "No scorers in this factory yet."}
            </p>
          )}
          {after.data || nextAfterId ? (
            <div className="flex flex-wrap gap-2 px-4 py-3 sm:px-5">
              {after.data ? (
                <Link
                  className="ui-button"
                  href={workspaceScorersPath(workspaceSlug, factoryQuery)}
                >
                  First page
                </Link>
              ) : null}
              {nextAfterId ? (
                <Link
                  className="ui-button"
                  href={workspaceScorersPath(workspaceSlug, {
                    ...factoryQuery,
                    after: nextAfterId,
                  })}
                >
                  More scorers
                </Link>
              ) : null}
            </div>
          ) : null}
        </section>
        {canEdit ? (
          <PageSection
            anchorId="new-scorer"
            statusBadge={<Status label="Draft" value="not_started" />}
            title="Draft rubric"
          >
            <ScorerForm
              draft={{ kind: "create" }}
              factoryId={factory.id}
              key={factory.id}
              workspaceId={workspaceId}
              workspaceSlug={workspaceSlug}
            />
          </PageSection>
        ) : null}
      </div>
    </PageContainer>
  );
}

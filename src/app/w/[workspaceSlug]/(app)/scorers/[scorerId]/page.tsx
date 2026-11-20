import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { ScorerDefinitionView } from "@/features/factory-scorers/scorer-definition-view";
import { ScorerForm } from "@/features/factory-scorers/scorer-form";
import { ScorerTrends } from "@/features/factory-scorers/scorer-trends";
import {
  loadScorerDetail,
  loadScorerPageScope,
} from "@/features/factory-scorers/scorer-pages-data";
import { parseScorerTrendQuery } from "@/lib/factory-evaluations/score-trend-query";
import { loadScoreTrendPanel } from "@/lib/factory-evaluations/score-trends";
import {
  workspaceFactoryDefinitionPath,
  workspaceScorerDetailPath,
  workspaceScorersPath,
} from "@/lib/routes";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const revisionNumber = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().max(2_147_483_647));

export default async function ScorerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string; scorerId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug, scorerId }, query] = await Promise.all([params, searchParams]);
  const scorerKey = uuid.safeParse(scorerId);
  const revision = uuid.optional().safeParse(query.revision);
  const before = revisionNumber.optional().safeParse(query.before);
  if (!scorerKey.success || !revision.success || !before.success) notFound();
  const scope = await loadScorerPageScope(workspaceSlug, query.factory);
  if (!scope) return <FactoryUnavailable title="Scorers" />;
  const data = await loadScorerDetail(scope, {
    scorerId: scorerKey.data,
    revisionId: revision.data,
    before: before.data,
  });
  if (!data) notFound();

  const { factory, canEdit, canBind, workspaceId } = scope;
  const { scorer, latest, selected, activePins, revisions, nextBeforeRevisionNumber } = data;
  const factoryQuery = { factory: factory.id };
  const historical = selected.id !== latest.id;
  const active = activePins.includes(selected.id);
  const trendQuery = parseScorerTrendQuery(query);
  const revisionFilters = { ...factoryQuery, from: trendQuery?.from, to: trendQuery?.to };
  const latestHref = workspaceScorerDetailPath(workspaceSlug, scorer.id, revisionFilters);
  const trend = trendQuery
    ? await loadScoreTrendPanel(
        scope.supabase,
        { workspaceId, factoryId: factory.id },
        trendQuery,
        {
          scorerId: scorer.id,
          scorerRevisionId: selected.id,
        },
      ).catch(() => null)
    : null;

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        description={`${factory.name} · ${scorer.slug}${factory.status === "archived" ? " · Archived" : ""}`}
        eyebrow={
          <Link
            className="hover:text-foreground"
            href={workspaceScorersPath(workspaceSlug, factoryQuery)}
          >
            ← Scorers
          </Link>
        }
        eyebrowAsPlain
        title={scorer.name}
      />
      <div className="space-y-8">
        <PageSection
          statusBadge={
            active ? (
              <Status label="Active in factory" value="approved" />
            ) : historical ? (
              <Status label="Historical" value="archived" />
            ) : (
              <Status label="Published" value="approved" />
            )
          }
          tagline={historical ? "Read-only revision" : undefined}
          title={`Revision ${selected.revision_number}`}
        >
          <ScorerDefinitionView definition={selected.definition} />
          {canBind ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                className="ui-button"
                href={workspaceFactoryDefinitionPath(workspaceSlug, {
                  ...factoryQuery,
                  scorerRevision: selected.id,
                })}
              >
                Configure binding
              </Link>
            </div>
          ) : null}
        </PageSection>
        <ScorerTrends
          data={trend}
          path={workspaceScorerDetailPath(workspaceSlug, scorer.id)}
          preserved={{
            factory: factory.id,
            revision: selected.id,
            before: before.data?.toString(),
          }}
          query={trendQuery}
          workspaceSlug={workspaceSlug}
        />
        {canEdit ? (
          historical ? (
            <Link className="ui-button" href={latestHref}>
              Edit latest revision
            </Link>
          ) : (
            <PageSection
              statusBadge={<Status label="Draft" value="not_started" />}
              title="Draft rubric"
            >
              <ScorerForm
                draft={{
                  kind: "revise",
                  scorerId: scorer.id,
                  expectedRevisionNumber: latest.revision_number,
                  definition: selected.definition,
                }}
                factoryId={factory.id}
                key={latest.id}
                workspaceId={workspaceId}
                workspaceSlug={workspaceSlug}
              />
            </PageSection>
          )
        ) : null}
        <PageSection title="Revision history">
          {revisions.length ? (
            <ul className="ui-sheet divide-y divide-border">
              {revisions.map((entry) => (
                <li
                  className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5"
                  key={entry.id}
                >
                  <Link
                    aria-current={entry.id === selected.id ? "true" : undefined}
                    className="font-semibold text-foreground underline-offset-4 hover:text-accent hover:underline"
                    href={workspaceScorerDetailPath(workspaceSlug, scorer.id, {
                      ...revisionFilters,
                      before: before.data,
                      revision: entry.id,
                    })}
                  >
                    Revision {entry.revision_number}
                  </Link>
                  {activePins.includes(entry.id) ? (
                    <Status compact label="Active in factory" value="approved" />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-secondary text-muted">No revisions on this page.</p>
          )}
          {before.data || nextBeforeRevisionNumber ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {before.data ? (
                <Link className="ui-button" href={latestHref}>
                  Latest revisions
                </Link>
              ) : null}
              {nextBeforeRevisionNumber ? (
                <Link
                  className="ui-button"
                  href={workspaceScorerDetailPath(workspaceSlug, scorer.id, {
                    ...revisionFilters,
                    before: nextBeforeRevisionNumber,
                    revision: selected.id,
                  })}
                >
                  Older revisions
                </Link>
              ) : null}
            </div>
          ) : null}
        </PageSection>
      </div>
    </PageContainer>
  );
}

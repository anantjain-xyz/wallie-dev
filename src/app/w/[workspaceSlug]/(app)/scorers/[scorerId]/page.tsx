import { WorkspaceResourceScope } from "@/components/app-shell/workspace-factory-page.server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { ScorerDefinitionView } from "@/features/factory-scorers/scorer-definition-view";
import { ScorerDraftGuard, ScorerDraftLink } from "@/features/factory-scorers/scorer-draft-guard";
import { scorerFactoryLabel } from "@/features/factory-scorers/scorer-factory-label";
import { ScorerForm } from "@/features/factory-scorers/scorer-form";
import {
  loadScorerGovernanceData,
  ScorerGovernanceSection,
} from "@/features/factory-scorers/scorer-governance-section";
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
  if (!scope) return <FactoryUnavailable title="Scorers" workspaceSlug={workspaceSlug} />;
  const data = await loadScorerDetail(scope, {
    scorerId: scorerKey.data,
    revisionId: revision.data,
    before: before.data,
  });
  if (!data) notFound();

  const { factory, factories, canEdit, canBind, workspaceId } = scope;
  const { scorer, latest, selected, activePins, revisions, nextBeforeRevisionNumber } = data;
  const factoryQuery = { factory: factory.id };
  const historical = selected.id !== latest.id;
  const EditLink = historical ? ScorerDraftLink : Link;
  const active = activePins.includes(selected.id);
  const published = query.published === selected.id && revision.data === selected.id;
  const factoryLabel = scorerFactoryLabel(factory, factories ?? [factory]);
  const trendQuery = parseScorerTrendQuery(query);
  const revisionFilters = { ...factoryQuery, from: trendQuery?.from, to: trendQuery?.to };
  const latestHref = workspaceScorerDetailPath(workspaceSlug, scorer.id, revisionFilters);
  const governanceScope = { workspaceId, factoryId: factory.id };
  const [trend, governance] = await Promise.all([
    trendQuery
      ? loadScoreTrendPanel(scope.supabase, { workspaceId, factoryId: factory.id }, trendQuery, {
          scorerId: scorer.id,
          scorerRevisionId: selected.id,
        }).catch(() => null)
      : null,
    loadScorerGovernanceData(scope.supabase, governanceScope, scorer.id, query),
  ]);

  return (
    <ScorerDraftGuard>
      <PageContainer className="pt-5 sm:pt-10">
        <WorkspaceResourceScope
          factoryId={factory.id}
          pathname={workspaceScorerDetailPath(workspaceSlug, scorerId)}
          workspaceSlug={workspaceSlug}
        />
        <PageHeader
          actions={
            canEdit ? (
              <EditLink
                className="ui-button ui-button-primary"
                href={historical ? `${latestHref}#draft-rubric` : "#draft-rubric"}
              >
                Edit latest rubric
              </EditLink>
            ) : undefined
          }
          description={`${factoryLabel} · ${scorer.slug}${factory.status === "archived" ? " · Read only — archived factory" : !canEdit ? " · Only factory managers can publish" : ""}`}
          eyebrow={
            <ScorerDraftLink
              back
              className="hover:text-foreground"
              href={workspaceScorersPath(workspaceSlug, factoryQuery)}
            >
              Scorers
            </ScorerDraftLink>
          }
          eyebrowAsPlain
          title={scorer.name}
        />
        <div className="space-y-8">
          {published ? (
            <p className="ui-sheet type-secondary px-4 py-3 sm:px-5" role="status">
              Revision {selected.revision_number} published. The active factory binding is
              unchanged.
            </p>
          ) : null}
          <PageSection
            statusBadge={
              <div className="flex flex-wrap items-center gap-2">
                <Status
                  label={historical ? "Historical" : "Latest published"}
                  value={historical ? "archived" : "approved"}
                />
                {active ? <Status label="Active in factory" value="approved" /> : null}
              </div>
            }
            tagline={historical ? "Read-only revision" : undefined}
            title={`Revision ${selected.revision_number}`}
          >
            <ScorerDefinitionView definition={selected.definition} />
            {canBind ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <ScorerDraftLink
                  className="ui-button"
                  href={workspaceFactoryDefinitionPath(workspaceSlug, {
                    ...factoryQuery,
                    scorerRevision: selected.id,
                  })}
                >
                  Bind revision {selected.revision_number} in Factory Definition
                </ScorerDraftLink>
              </div>
            ) : null}
            <p className="type-secondary mt-3 text-muted">
              {active
                ? "This exact rubric is in the active factory definition."
                : "This rubric is published but isn’t in the active factory definition."}
              {canBind && !active
                ? " To use it for new sessions, bind this revision and activate the factory definition."
                : ""}
            </p>
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
          <ScorerGovernanceSection
            workspaceSlug={workspaceSlug}
            data={governance}
            scope={governanceScope}
            scorerId={scorer.id}
            scorerRevisionId={selected.id}
            scorerRevisionNumber={selected.revision_number}
            canEdit={canEdit}
            stats={trend?.trend?.totals}
            hasCohorts={
              trend
                ? Boolean(trend.cohorts.length || trend.nextCohort || trend.policyId)
                : undefined
            }
            path={workspaceScorerDetailPath(workspaceSlug, scorer.id, {
              ...trendQuery,
              factory: factory.id,
              revision: selected.id,
            })}
          />
          {canEdit ? (
            <ScorerForm
              draft={{
                kind: "revise",
                scorerId: scorer.id,
                expectedRevisionNumber: selected.revision_number,
                definition: selected.definition,
              }}
              factoryId={factory.id}
              factoryLabel={factoryLabel}
              historical={historical}
              key={selected.id}
              workspaceId={workspaceId}
              workspaceSlug={workspaceSlug}
            />
          ) : null}
          <PageSection title="Revision history">
            {revisions.length ? (
              <ul className="ui-sheet divide-y divide-border">
                {revisions.map((entry) => (
                  <li
                    className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5"
                    key={entry.id}
                  >
                    <ScorerDraftLink
                      aria-current={entry.id === selected.id ? "true" : undefined}
                      className="font-semibold text-foreground underline-offset-4 hover:text-accent hover:underline"
                      href={workspaceScorerDetailPath(workspaceSlug, scorer.id, {
                        ...revisionFilters,
                        before: before.data,
                        revision: entry.id,
                      })}
                    >
                      Revision {entry.revision_number}
                    </ScorerDraftLink>
                    <div className="flex flex-wrap gap-2">
                      {entry.id === latest.id ? (
                        <Status compact label="Latest published" value="approved" />
                      ) : null}
                      {activePins.includes(entry.id) ? (
                        <Status compact label="Active in factory" value="approved" />
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="type-secondary text-muted">No revisions on this page.</p>
            )}
            {before.data || nextBeforeRevisionNumber ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {before.data ? (
                  <Link
                    className="ui-button"
                    href={workspaceScorerDetailPath(workspaceSlug, scorer.id, {
                      ...revisionFilters,
                      revision: selected.id,
                    })}
                  >
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
    </ScorerDraftGuard>
  );
}

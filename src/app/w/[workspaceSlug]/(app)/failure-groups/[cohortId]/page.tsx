import { WorkspaceResourceScope } from "@/components/app-shell/workspace-factory-page.server";
import Form from "next/form";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { failureValidationPath } from "@/features/factory-failures/failure-evidence-path";
import { FailureGroupReview } from "@/features/factory-failures/failure-group-review";
import { loadFailureGroupScope } from "@/features/factory-failures/failure-group-scope";
import {
  FailureGroupCounts,
  FailureGroupLimits,
  FailureGroupStatus,
  failureGroupSymptom,
  failureGroupTask,
  failureGroupTitle,
} from "@/features/factory-failures/failure-group-summary";
import {
  failureEvidenceLabels,
  failureMemberLabel,
  failureMemberObservation,
} from "@/features/factory-failures/failure-member-labels";
import { runAttemptHref } from "@/features/factory-scorers/run-evaluation-governance";
import {
  failureCohortIdSchema,
  parseFailureCohortEvidenceQuery,
  parseFailureCohortQuery,
  type FailureCohortMember,
  type FailureRevisionOption,
} from "@/lib/factory-failures/cohort-contracts";
import {
  getFailureCohort,
  loadFailureActivation,
  loadFailureAgentNames,
  loadFailureRevisionOptions,
} from "@/lib/factory-failures/cohorts";
import {
  workspaceAgentDetailPath,
  workspaceFailureGroupPath,
  workspaceFailureGroupsPath,
  workspaceImprovementsPath,
  workspaceRunDetailPath,
  workspaceScorersPath,
} from "@/lib/routes";

function FailureMember({
  member,
  workspaceSlug,
  factoryId,
  validationHref,
  definition,
}: {
  member: FailureCohortMember;
  workspaceSlug: string;
  factoryId: string;
  validationHref: string;
  definition?: FailureRevisionOption;
}) {
  const { source, configuration } = member;
  const label = failureMemberLabel(member);
  const configurationPath = workspaceRunDetailPath(workspaceSlug, member.run_id, {
    attempt: member.run_attempt_count,
  });
  const evaluation =
    source.kind === "scorer"
      ? runAttemptHref(
          workspaceSlug,
          member.run_id,
          source.evaluation_attempt_id,
          source.evaluation_job_id,
        )
      : null;
  return (
    <li className="min-w-0 space-y-2 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          className="font-semibold underline-offset-4 [overflow-wrap:anywhere] hover:underline"
          href={configurationPath}
        >
          {label}
        </Link>
        <time className="type-annotation text-muted" dateTime={member.observed_at}>
          {failureMemberObservation(member)}
        </time>
      </div>
      <p className="type-secondary break-words text-muted">
        {configuration.model_provider} / {configuration.model_name} ·{" "}
        {failureEvidenceLabels[source.evidence_state]}
        {source.kind === "validation" && source.validation_record_key
          ? ` · ${source.validation_record_key}`
          : null}
      </p>
      <div className="flex flex-wrap gap-2">
        {evaluation ? (
          <Link
            className="ui-button"
            href={evaluation}
            prefetch={false}
            aria-label={`Open evaluation for ${label}`}
          >
            Open evaluation
          </Link>
        ) : null}
        {source.kind === "validation" && source.evidence_state === "available" ? (
          <Link
            className="ui-button"
            href={validationHref}
            prefetch={false}
            aria-label={`Open validation evidence for ${label}`}
          >
            Open validation evidence
          </Link>
        ) : null}
        <Link
          className="ui-button"
          href={`${configurationPath}#execution-profile`}
          prefetch={false}
        >
          Producing configuration
        </Link>
        <Link
          className="ui-button"
          href={workspaceAgentDetailPath(workspaceSlug, configuration.agent_id, {
            factory: factoryId,
            revision: configuration.agent_prompt_revision_id,
          })}
          prefetch={false}
        >
          Agent revision
        </Link>
        {source.kind === "scorer" ? (
          <Link
            className="ui-button"
            href={workspaceScorersPath(workspaceSlug, {
              factory: factoryId,
              revision: source.scorer_revision_id,
            })}
            prefetch={false}
          >
            Scorer revision
          </Link>
        ) : null}
      </div>
      {configuration.definition_revision_id ? (
        <Link
          className="type-annotation inline-block text-muted underline underline-offset-4 [overflow-wrap:anywhere]"
          href={workspaceFailureGroupsPath(workspaceSlug, {
            factory: factoryId,
            revision: configuration.definition_revision_id,
          })}
        >
          Show groups from {definition?.label.toLowerCase() ?? "unavailable revision"}
          {definition ? ` · ${definition.detail}` : ""}
        </Link>
      ) : null}
    </li>
  );
}

export default async function FailureGroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string; cohortId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug, cohortId }, search] = await Promise.all([params, searchParams]);
  const id = failureCohortIdSchema.safeParse(cohortId);
  if (!id.success) notFound();
  const query = parseFailureCohortQuery(search);
  const evidenceQuery = parseFailureCohortEvidenceQuery(search);
  const scope = await loadFailureGroupScope(workspaceSlug, search.factory);
  if (!scope) return <FactoryUnavailable title="Failure group" workspaceSlug={workspaceSlug} />;
  const data =
    query.success && evidenceQuery.success
      ? await getFailureCohort(scope.supabase, scope, id.data, {
          ...query.data,
          ...evidenceQuery.data,
        })
      : null;
  const factoryQuery = { factory: scope.factoryId };
  const filters = query.success
    ? {
        symptom: query.data.symptom,
        revision: query.data.revision,
        disposition: query.data.disposition,
        order: query.data.order,
      }
    : {};
  const list = workspaceFailureGroupsPath(workspaceSlug, { ...factoryQuery, ...filters });
  const back = (
    <Link className="underline-offset-4 hover:underline" href={list}>
      Back to failure groups
    </Link>
  );
  const resourceScope = (
    <WorkspaceResourceScope
      factoryId={scope.factoryId}
      pathname={workspaceFailureGroupPath(workspaceSlug, cohortId)}
      workspaceSlug={workspaceSlug}
    />
  );
  if (!data || !query.success || !evidenceQuery.success) {
    return (
      <PageContainer>
        {resourceScope}
        <PageHeader title="Failure group unavailable" eyebrow={back} eyebrowAsPlain />
        {!evidenceQuery.success || !query.success ? (
          <Link
            className="ui-button"
            href={workspaceFailureGroupPath(workspaceSlug, id.data, {
              ...factoryQuery,
              ...filters,
            })}
          >
            Reset group filters
          </Link>
        ) : query.data.revision ? (
          <Link
            className="ui-button"
            href={workspaceFailureGroupPath(workspaceSlug, id.data, {
              ...factoryQuery,
              ...filters,
              revision: undefined,
            })}
          >
            Clear revision filter
          </Link>
        ) : null}
      </PageContainer>
    );
  }

  const { cohort, members, membership_digest: digest } = data;
  const { after, revision } = query.data;
  const pageQuery = { ...factoryQuery, ...filters, ...evidenceQuery.data };
  const evidenceFiltered = Boolean(evidenceQuery.data.runSearch || evidenceQuery.data.observedOn);
  const firstPage = after ? workspaceFailureGroupPath(workspaceSlug, id.data, pageQuery) : null;
  const nextPage = data.next_member_id
    ? workspaceFailureGroupPath(workspaceSlug, id.data, {
        ...pageQuery,
        after: data.next_member_id,
      })
    : null;
  const uniqueRuns = new Map<string, { id: string; label: string; detail: string }>();
  for (const member of members) {
    if (!uniqueRuns.has(member.run_id)) {
      uniqueRuns.set(member.run_id, {
        id: member.run_id,
        label: failureMemberLabel(member),
        detail: `${failureMemberObservation(member)} · ${failureEvidenceLabels[member.source.evidence_state]}`,
      });
    }
  }
  const split =
    digest && !revision && cohort.failure_count > 1
      ? { digest, runs: [...uniqueRuns.values()], firstPage, nextPage }
      : null;
  const [agentNames, active] = await Promise.all([
    loadFailureAgentNames(scope.supabase, scope, [cohort.agent_id]),
    loadFailureActivation(scope.supabase, scope),
  ]);
  const revisionOptions = await loadFailureRevisionOptions(
    scope.supabase,
    scope,
    members
      .map(({ configuration }) => configuration.definition_revision_id)
      .filter((id): id is string => id !== null),
    active,
  );
  const lineageQuery = { ...factoryQuery, ...filters, revision: undefined };
  const readOnly = cohort.partition
    ? "This split snapshot is read-only. The original group retains the full history."
    : cohort.review.disposition === "dismissed"
      ? "Review is closed. Run evidence is still available below."
      : cohort.review.disposition === "split"
        ? "Review is closed. The original group retains all run evidence; the split groups show snapshots."
        : scope.factory.status === "archived"
          ? "This factory is archived. Evidence is read-only."
          : "Only factory managers can review this group.";
  return (
    <PageContainer>
      {resourceScope}
      <PageHeader
        actions={
          <Link
            className="ui-button"
            href={workspaceImprovementsPath(workspaceSlug, {
              factory: scope.factoryId,
              cohort: cohort.parent_cohort_id ?? cohort.id,
            })}
            prefetch={false}
          >
            {cohort.parent_cohort_id
              ? "View original group’s proposals"
              : "View proposals for this group"}
          </Link>
        }
        actionsRightOnDesktop
        title={failureGroupTitle(cohort)}
        eyebrow={back}
        eyebrowAsPlain
        description={scope.factory.name}
      />
      <div className="space-y-7">
        <section aria-label="Failure group summary" className="ui-sheet space-y-3 p-4 sm:p-5">
          <FailureGroupStatus cohort={cohort} />
          <p className="type-secondary break-words text-muted">
            Grouped by {failureGroupTask(cohort)} ·{" "}
            {agentNames.get(cohort.agent_id) ?? "Agent unavailable"} · {failureGroupSymptom(cohort)}
          </p>
          {cohort.qualification === "qualified" ? (
            <p className="type-secondary text-muted">
              Enough comparable evidence to investigate; not a confirmed cause.
            </p>
          ) : null}
          <FailureGroupLimits cohort={cohort} />
          <FailureGroupCounts cohort={cohort} />
          {!cohort.review.can_review ? (
            <p className="type-secondary text-muted">{readOnly}</p>
          ) : null}
          {revision || cohort.parent_cohort_id ? (
            <div className="flex flex-wrap gap-2">
              {revision ? (
                <Link
                  className="ui-button"
                  href={workspaceFailureGroupPath(workspaceSlug, id.data, {
                    ...pageQuery,
                    revision: undefined,
                  })}
                >
                  View all revisions
                </Link>
              ) : null}
              {cohort.parent_cohort_id ? (
                <Link
                  className="ui-button"
                  href={workspaceFailureGroupPath(
                    workspaceSlug,
                    cohort.parent_cohort_id,
                    lineageQuery,
                  )}
                >
                  Original group
                </Link>
              ) : null}
            </div>
          ) : null}
          {data.split_groups.length ? (
            <nav aria-label="Split groups" className="flex flex-wrap gap-2">
              {data.split_groups.map(({ id: childId, side }) => (
                <Link
                  className="ui-button"
                  key={childId}
                  href={workspaceFailureGroupPath(workspaceSlug, childId, lineageQuery)}
                >
                  {side === "selected" ? "Selected runs group" : "Remaining runs group"}
                </Link>
              ))}
            </nav>
          ) : null}
        </section>
        <PageSection title="Run evidence">
          <div className="ui-sheet">
            {cohort.failure_count > 1 || evidenceFiltered ? (
              <Form
                action={workspaceFailureGroupPath(workspaceSlug, id.data)}
                prefetch={false}
                scroll={false}
                className="flex flex-wrap items-end gap-3 border-b border-border p-4 sm:p-5"
              >
                {Object.entries({ ...factoryQuery, ...filters }).map(([name, value]) =>
                  value ? <input key={name} type="hidden" name={name} value={value} /> : null,
                )}
                <label className="type-label grid min-w-0 flex-1 basis-52 gap-1.5">
                  Search by session or stage
                  <input
                    key={evidenceQuery.data.runSearch ?? ""}
                    className="ui-input w-full"
                    name="runSearch"
                    type="search"
                    maxLength={120}
                    autoComplete="off"
                    defaultValue={evidenceQuery.data.runSearch}
                  />
                </label>
                <label className="type-label grid min-w-0 gap-1.5">
                  Observed date (UTC)
                  <input
                    key={evidenceQuery.data.observedOn ?? ""}
                    className="ui-input w-full"
                    name="observedOn"
                    type="date"
                    defaultValue={evidenceQuery.data.observedOn}
                  />
                </label>
                <button className="ui-button" type="submit">
                  Filter runs
                </button>
                {evidenceFiltered ? (
                  <Link
                    className="ui-button"
                    href={workspaceFailureGroupPath(workspaceSlug, id.data, {
                      ...factoryQuery,
                      ...filters,
                    })}
                    scroll={false}
                  >
                    Clear run filters
                  </Link>
                ) : null}
              </Form>
            ) : null}
            {members.length ? (
              <ul className="divide-y divide-border">
                {members.map((member) => (
                  <FailureMember
                    member={member}
                    key={member.id}
                    workspaceSlug={workspaceSlug}
                    factoryId={scope.factoryId}
                    validationHref={failureValidationPath(workspaceSlug, cohort.id, member.id, {
                      ...pageQuery,
                      after,
                    })}
                    definition={revisionOptions.get(
                      member.configuration.definition_revision_id ?? "",
                    )}
                  />
                ))}
              </ul>
            ) : (
              <p className="type-secondary px-4 py-6 text-muted">
                {after
                  ? "There are no more members on this page."
                  : "No run evidence matches these filters."}
              </p>
            )}
            {firstPage || nextPage ? (
              <nav
                aria-label="Evidence pages"
                className="flex flex-wrap gap-2 border-t border-border p-4"
              >
                {firstPage ? (
                  <Link className="ui-button" href={firstPage}>
                    First page
                  </Link>
                ) : null}
                {nextPage ? (
                  <Link className="ui-button" href={nextPage}>
                    More evidence
                  </Link>
                ) : null}
              </nav>
            ) : null}
          </div>
        </PageSection>
        {cohort.review.can_review ? (
          <PageSection title="Review group">
            {revision ? (
              <p className="type-secondary mb-3 text-muted">
                View all revisions to split the group by run.
              </p>
            ) : null}
            <FailureGroupReview
              endpoint={`/api/workspaces/${scope.workspaceId}/factories/${scope.factoryId}/failure-groups/${cohort.id}/review`}
              revision={cohort.review.revision}
              label={cohort.review.label}
              split={split}
            />
          </PageSection>
        ) : null}
      </div>
    </PageContainer>
  );
}

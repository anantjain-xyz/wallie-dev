import Link from "next/link";
import { notFound } from "next/navigation";

import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { FailureGroupReview } from "@/features/factory-failures/failure-group-review";
import { loadFailureGroupScope } from "@/features/factory-failures/failure-group-scope";
import {
  FailureGroupCounts,
  FailureGroupLimits,
  FailureGroupStatus,
  failureGroupTitle,
} from "@/features/factory-failures/failure-group-summary";
import { runAttemptHref } from "@/features/factory-scorers/run-evaluation-governance";
import { browserEvidencePath } from "@/features/wallie/browser-evidence-contracts";
import {
  failureCohortIdSchema,
  parseFailureCohortQuery,
  type FailureCohortMember,
} from "@/lib/factory-failures/cohort-contracts";
import { getFailureCohort } from "@/lib/factory-failures/cohorts";
import {
  workspaceAgentDetailPath,
  workspaceFailureGroupPath,
  workspaceFailureGroupsPath,
  workspaceRunDetailPath,
  workspaceScorersPath,
} from "@/lib/routes";
import { titleFromSlug } from "@/lib/utils";

const evidenceLabels = {
  available: "Evidence available",
  withheld: "Evidence withheld",
  unavailable: "Evidence unavailable",
};
const observedAt = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function FailureMember({
  member,
  workspaceSlug,
  factoryId,
}: {
  member: FailureCohortMember;
  workspaceSlug: string;
  factoryId: string;
}) {
  const { source, configuration } = member;
  const run = workspaceRunDetailPath(workspaceSlug, member.run_id);
  const evaluation =
    source.kind === "scorer"
      ? runAttemptHref(
          workspaceSlug,
          member.run_id,
          source.evaluation_attempt_id,
          source.evaluation_job_id,
        )
      : null;
  const validation =
    source.kind === "validation" && source.evidence_state === "available"
      ? browserEvidencePath(member.session_id, { runId: source.validation_run_id })
      : null;
  return (
    <li className="min-w-0 space-y-2 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link className="font-semibold underline-offset-4 hover:underline" href={run}>
          Run {member.run_id.slice(0, 8)}
        </Link>
        <time className="type-annotation text-muted" dateTime={member.observed_at}>
          {observedAt.format(new Date(member.observed_at))} UTC
        </time>
      </div>
      <p className="type-secondary break-words text-muted">
        Attempt {member.run_attempt_count} · {configuration.model_provider} /{" "}
        {configuration.model_name} · {evidenceLabels[source.evidence_state]}
        {source.kind === "validation" && source.validation_record_key
          ? ` · ${source.validation_record_key}`
          : null}
      </p>
      <div className="flex flex-wrap gap-2">
        {evaluation ? (
          <Link className="ui-button" href={evaluation} prefetch={false}>
            Open evaluation
          </Link>
        ) : null}
        {validation ? (
          <Link className="ui-button" href={validation} prefetch={false}>
            Open validation receipt
          </Link>
        ) : null}
        <Link className="ui-button" href={`${run}#execution-profile`} prefetch={false}>
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
          className="type-annotation inline-block break-all text-muted underline underline-offset-4"
          href={workspaceFailureGroupsPath(workspaceSlug, {
            factory: factoryId,
            revision: configuration.definition_revision_id,
          })}
        >
          Filter groups by revision {configuration.definition_revision_id.slice(0, 8)}
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
  const scope = await loadFailureGroupScope(workspaceSlug, search.factory);
  if (!scope) return <FactoryUnavailable title="Failure group" workspaceSlug={workspaceSlug} />;
  const data = query.success
    ? await getFailureCohort(scope.supabase, scope, id.data, query.data)
    : null;
  const factoryQuery = { factory: scope.factoryId };
  const filters = query.success
    ? {
        symptom: query.data.symptom,
        revision: query.data.revision,
        disposition: query.data.disposition,
      }
    : {};
  const list = workspaceFailureGroupsPath(workspaceSlug, { ...factoryQuery, ...filters });
  const back = (
    <Link className="underline-offset-4 hover:underline" href={list}>
      Back to failure groups
    </Link>
  );
  if (!data || !query.success) {
    return (
      <PageContainer>
        <PageHeader title="Failure group unavailable" eyebrow={back} eyebrowAsPlain />
        {query.success && query.data.revision ? (
          <Link
            className="ui-button"
            href={workspaceFailureGroupPath(workspaceSlug, id.data, factoryQuery)}
          >
            Clear revision filter
          </Link>
        ) : null}
      </PageContainer>
    );
  }

  const { cohort, members, membership_digest: digest } = data;
  const { after, revision } = query.data;
  const pageQuery = { ...factoryQuery, ...filters };
  const uniqueRuns = new Map<string, { id: string; label: string }>();
  for (const member of members) {
    if (!uniqueRuns.has(member.run_id)) {
      uniqueRuns.set(member.run_id, {
        id: member.run_id,
        label: `Run ${member.run_id.slice(0, 8)} · ${observedAt.format(new Date(member.observed_at))} UTC`,
      });
    }
  }
  const split =
    digest && !revision && cohort.failure_count > 1 && uniqueRuns.size
      ? { digest, runs: [...uniqueRuns.values()] }
      : null;
  return (
    <PageContainer>
      <PageHeader
        title={failureGroupTitle(cohort)}
        eyebrow={back}
        eyebrowAsPlain
        description={scope.factory.name}
      />
      <div className="space-y-7">
        <section aria-label="Failure group summary" className="ui-sheet space-y-3 p-4 sm:p-5">
          <FailureGroupStatus cohort={cohort} />
          <p className="type-secondary break-words text-muted">
            {cohort.task_class_slug ? titleFromSlug(cohort.task_class_slug) : "Unclassified task"} ·{" "}
            {cohort.symptom_label ??
              (cohort.symptom_kind === "scorer" ? "Scorer failure" : "Validation failure")}
          </p>
          <FailureGroupLimits cohort={cohort} />
          <FailureGroupCounts cohort={cohort} />
          {revision ? (
            <Link
              className="ui-button"
              href={workspaceFailureGroupPath(workspaceSlug, id.data, factoryQuery)}
            >
              View all revisions
            </Link>
          ) : null}
          {cohort.parent_cohort_id ? (
            <Link
              className="ui-button"
              href={workspaceFailureGroupPath(workspaceSlug, cohort.parent_cohort_id, factoryQuery)}
            >
              Original group
            </Link>
          ) : null}
          {cohort.split_cohort_ids.length ? (
            <nav aria-label="Split groups" className="flex flex-wrap gap-2">
              {cohort.split_cohort_ids.map((childId, index) => (
                <Link
                  className="ui-button"
                  key={childId}
                  href={workspaceFailureGroupPath(workspaceSlug, childId, factoryQuery)}
                >
                  {cohort.split_cohort_ids.length === 1
                    ? "Open split group"
                    : index === 0
                      ? "Selected runs group"
                      : "Remaining runs group"}
                </Link>
              ))}
            </nav>
          ) : null}
        </section>
        <PageSection title="Run evidence">
          <div className="ui-sheet">
            {members.length ? (
              <ul className="divide-y divide-border">
                {members.map((member) => (
                  <FailureMember
                    member={member}
                    key={member.id}
                    workspaceSlug={workspaceSlug}
                    factoryId={scope.factoryId}
                  />
                ))}
              </ul>
            ) : (
              <p className="type-secondary px-4 py-6 text-muted">
                There are no more members on this page.
              </p>
            )}
            {after || data.next_member_id ? (
              <nav
                aria-label="Evidence pages"
                className="flex flex-wrap gap-2 border-t border-border p-4"
              >
                {after ? (
                  <Link
                    className="ui-button"
                    href={workspaceFailureGroupPath(workspaceSlug, id.data, pageQuery)}
                  >
                    First page
                  </Link>
                ) : null}
                {data.next_member_id ? (
                  <Link
                    className="ui-button"
                    href={workspaceFailureGroupPath(workspaceSlug, id.data, {
                      ...pageQuery,
                      after: data.next_member_id,
                    })}
                  >
                    More evidence
                  </Link>
                ) : null}
              </nav>
            ) : null}
          </div>
        </PageSection>
        {cohort.review.can_review ? (
          <PageSection title="Review group">
            <FailureGroupReview
              endpoint={`/api/workspaces/${scope.workspaceId}/factories/${scope.factoryId}/failure-groups/${cohort.id}/review`}
              revision={cohort.review.revision}
              label={cohort.review.label}
              dismissed={cohort.review.disposition === "dismissed"}
              split={split}
            />
          </PageSection>
        ) : null}
      </div>
    </PageContainer>
  );
}

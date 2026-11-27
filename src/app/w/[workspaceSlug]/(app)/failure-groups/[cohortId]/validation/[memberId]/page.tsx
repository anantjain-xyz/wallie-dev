import Link from "next/link";
import { notFound } from "next/navigation";

import { WorkspaceResourceScope } from "@/components/app-shell/workspace-factory-page.server";
import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import { failureValidationPath } from "@/features/factory-failures/failure-evidence-path";
import { failureMemberLabel } from "@/features/factory-failures/failure-member-labels";
import { loadFailureGroupScope } from "@/features/factory-failures/failure-group-scope";
import { loadFailureValidation } from "@/features/factory-failures/failure-validation-data";
import { browserEvidencePath } from "@/features/wallie/browser-evidence-contracts";
import {
  failureCohortIdSchema,
  parseFailureCohortEvidenceQuery,
  parseFailureCohortQuery,
} from "@/lib/factory-failures/cohort-contracts";
import { getFailureCohort } from "@/lib/factory-failures/cohorts";
import { workspaceFailureGroupPath } from "@/lib/routes";

const outcomes = {
  passed: { label: "Passed", value: "complete" },
  failed: { label: "Failed", value: "failed" },
  stale: { label: "Stale result", value: "needs_attention" },
  error: { label: "Check error", value: "failed" },
} as const;

export default async function FailureValidationPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string; cohortId: string; memberId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug, cohortId, memberId }, search] = await Promise.all([params, searchParams]);
  const cohort = failureCohortIdSchema.safeParse(cohortId);
  const memberKey = failureCohortIdSchema.safeParse(memberId);
  if (!cohort.success || !memberKey.success) notFound();
  const scope = await loadFailureGroupScope(workspaceSlug, search.factory);
  const filters = parseFailureCohortQuery(search);
  const evidenceFilters = parseFailureCohortEvidenceQuery(search);
  const revision = filters.success ? filters.data.revision : undefined;
  const data =
    scope && filters.success
      ? await getFailureCohort(scope.supabase, scope, cohort.data, {
          memberId: memberKey.data,
          revision,
        })
      : null;
  const member = data?.members[0];
  const result = scope && member ? await loadFailureValidation(scope, member) : null;
  const backQuery = {
    factory: scope?.factoryId,
    ...(filters.success ? filters.data : {}),
    ...(evidenceFilters.success ? evidenceFilters.data : {}),
  };
  const back = (
    <Link
      className="underline-offset-4 hover:underline"
      href={workspaceFailureGroupPath(workspaceSlug, cohort.data, backQuery)}
    >
      Back to failure group
    </Link>
  );
  const resourceScope = (
    <WorkspaceResourceScope
      factoryId={scope?.factoryId ?? null}
      pathname={failureValidationPath(workspaceSlug, cohortId, memberId, {})}
      workspaceSlug={workspaceSlug}
    />
  );
  if (!result?.evidence || !member) {
    return (
      <PageContainer>
        {resourceScope}
        <PageHeader title="Validation evidence" eyebrow={back} eyebrowAsPlain />
        <section className="ui-sheet space-y-2 p-5">
          <h2 className="type-label">
            {result?.state === "withheld" ? "Evidence withheld" : "Evidence unavailable"}
          </h2>
          <p className="type-secondary text-muted">
            {result?.state === "withheld"
              ? "The receipt or its supporting files are no longer available for review."
              : "This exact check couldn’t be opened. Return to the group to check what evidence is still available."}
          </p>
        </section>
      </PageContainer>
    );
  }

  const { check, logPreview, truncated, logId, logUnavailable, reports, runId } = result.evidence;
  const assetBase = `/api/sessions/${member.session_id}/validation-evidence/assets`;
  return (
    <PageContainer className="space-y-6">
      {resourceScope}
      <PageHeader
        title="Validation evidence"
        eyebrow={back}
        eyebrowAsPlain
        description={failureMemberLabel(member)}
      />
      <PageSection title="Recorded check">
        <div className="ui-sheet space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="type-body min-w-0 font-semibold [overflow-wrap:anywhere]" translate="no">
              {check.key}
            </p>
            <Status {...outcomes[check.status]} />
          </div>
          <dl className="space-y-2">
            <div>
              <dt className="type-label text-muted">Command</dt>
              <dd className="type-secondary [overflow-wrap:anywhere]">
                <code>{check.command}</code>
              </dd>
            </div>
            <div>
              <dt className="type-label text-muted">Exit code</dt>
              <dd className="type-secondary tabular-nums">{check.exitCode ?? "Not recorded"}</dd>
            </div>
          </dl>
          {check.missingRequiredReports.length ? (
            <p className="type-secondary text-muted [overflow-wrap:anywhere]">
              Missing required reports: {check.missingRequiredReports.join(", ")}
            </p>
          ) : null}
        </div>
      </PageSection>
      <PageSection title="Check output">
        <div className="ui-sheet space-y-4 p-4 sm:p-5">
          {logPreview ? (
            <pre
              className="type-annotation max-h-96 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]"
              aria-label="Check log preview"
              tabIndex={0}
            >
              {logPreview}
            </pre>
          ) : (
            <p className="type-secondary text-muted">
              {logUnavailable
                ? "The log couldn’t be loaded."
                : logId
                  ? "The recorded log is empty."
                  : "No log was recorded for this check."}
            </p>
          )}
          {logUnavailable ? (
            <a
              className="ui-button"
              href={failureValidationPath(workspaceSlug, cohort.data, memberKey.data, backQuery)}
            >
              Retry log
            </a>
          ) : null}
          {truncated ? (
            <p className="type-annotation text-muted">
              Showing the start of the log. Download it for the full output.
            </p>
          ) : null}
          {logId ? (
            <a className="ui-button" href={`${assetBase}/${logId}`}>
              Download log
            </a>
          ) : null}
          {reports.length ? (
            <ul className="space-y-2">
              {reports.map((report) => (
                <li key={report.id}>
                  <a
                    className="type-secondary break-words underline underline-offset-4"
                    href={`${assetBase}/${report.id}`}
                  >
                    Download report: {report.evidence_key}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </PageSection>
      <a
        className="type-secondary text-muted underline underline-offset-4"
        href={browserEvidencePath(member.session_id, { runId })}
      >
        View technical receipt (JSON)
      </a>
    </PageContainer>
  );
}

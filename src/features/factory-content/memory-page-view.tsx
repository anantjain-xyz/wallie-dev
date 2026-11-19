import Link from "next/link";

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
  MemoryProposalForm,
  MemoryRevisionActions,
} from "@/features/factory-content/content-actions";
import type { loadMemoryPage } from "@/features/factory-content/content-data";
import type { GovernanceScope } from "@/features/factory-governance/governance-data";
import {
  workspaceMemoryPath,
  workspaceRunDetailPath,
  workspaceRunsPath,
  workspaceSessionDetailPath,
} from "@/lib/routes";

function digest(value: string) {
  return <span className="[overflow-wrap:anywhere]">{value}</span>;
}

const decisionLabels = {
  proposed: "Proposed",
  corrected: "Corrected",
  approved: "Approved",
  rejected: "Rejected",
  forgotten: "Forgotten",
};

export function MemoryPageView({
  scope,
  data,
  query,
}: {
  scope: Pick<GovernanceScope, "workspaceId" | "workspaceSlug" | "factory">;
  data: Awaited<ReturnType<typeof loadMemoryPage>> | null;
  query: Parameters<typeof loadMemoryPage>[1];
}) {
  const { workspaceSlug } = scope;
  const factoryQuery = { factory: scope.factory.id };
  const rootPath = workspaceMemoryPath(workspaceSlug, factoryQuery);
  const actionScope = {
    workspaceSlug,
    workspaceId: scope.workspaceId,
    factoryId: scope.factory.id,
  };
  const canChange = scope.factory.status === "active";
  const now = new Date().toISOString();
  const detail = data?.detail;

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        title="Memory"
        description={
          scope.factory.status === "archived"
            ? `${scope.factory.name} · Archived`
            : scope.factory.name
        }
      />
      <div className="space-y-8">
        {!data || (query.memory && !detail) ? (
          <div className="ui-sheet space-y-3 p-4 sm:p-5">
            <p className="type-secondary text-muted">The requested memory is unavailable.</p>
            <Link className="ui-button" href={rootPath}>
              Back to memory
            </Link>
          </div>
        ) : detail ? (
          <>
            <PageSection
              title={detail.memory.title ?? "Forgotten memory"}
              actions={
                <Link className="ui-button" href={rootPath}>
                  All memory
                </Link>
              }
            >
              <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
                {detail.memory.forgotten_at ? (
                  <Status value="archived" label="Forgotten" />
                ) : detail.memory.pending_revision_id ? (
                  <Status value="awaiting_review" />
                ) : detail.memory.current_revision_id ? (
                  <Status value="approved" />
                ) : (
                  <Status value="not_started" label="No approved revision" />
                )}
                <MetadataList>
                  <MetadataItem
                    label="Source run"
                    value={
                      <Link
                        className="underline underline-offset-4"
                        href={workspaceRunDetailPath(workspaceSlug, detail.memory.source_run_id)}
                      >
                        Attempt {detail.memory.source_attempt_count}
                      </Link>
                    }
                  />
                  <MetadataItem
                    label="Source artifact"
                    value={
                      detail.sourceSessionNumber !== null && detail.sourceArtifactStage ? (
                        <Link
                          className="underline underline-offset-4"
                          href={workspaceSessionDetailPath(
                            workspaceSlug,
                            detail.sourceSessionNumber,
                            {
                              artifactId: detail.memory.source_artifact_id,
                              artifactStage: detail.sourceArtifactStage,
                              artifactVersion: detail.memory.source_artifact_version,
                            },
                          )}
                        >
                          Artifact version {detail.memory.source_artifact_version}
                        </Link>
                      ) : (
                        "Source session unavailable"
                      )
                    }
                  />
                  <MetadataItem
                    label="Source commit"
                    value={digest(detail.memory.source_commit_sha)}
                    monospace
                  />
                  <MetadataItem
                    label="Source artifact digest"
                    value={digest(detail.memory.source_content_sha256)}
                    monospace
                  />
                </MetadataList>
              </div>
            </PageSection>
            <PageSection title="Revision history">
              <div className="ui-sheet min-w-0 divide-y divide-border">
                {query.revision && !detail.revision && (
                  <p className="type-secondary p-4 text-muted">
                    The requested memory revision is unavailable.
                  </p>
                )}
                {detail.revision && (
                  <div className="space-y-4 p-4 sm:p-5">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="type-label">Revision {detail.revision.revision_number}</h3>
                      {detail.revision.expires_at &&
                        Date.parse(detail.revision.expires_at) <= Date.parse(now) && (
                          <Status value="archived" label="Expired" />
                        )}
                    </div>
                    <MetadataList>
                      <MetadataItem
                        label="Revision ID"
                        value={digest(detail.revision.id)}
                        monospace
                      />
                      <MetadataItem
                        label="Content digest"
                        value={digest(detail.revision.content_sha256)}
                        monospace
                      />
                      <MetadataItem
                        label="Expires"
                        value={
                          detail.revision.expires_at ? (
                            <TimeDisplay value={detail.revision.expires_at} initialNow={now} />
                          ) : (
                            "Never"
                          )
                        }
                      />
                      <MetadataItem
                        label="Created"
                        value={<TimeDisplay value={detail.revision.created_at} initialNow={now} />}
                      />
                    </MetadataList>
                    {detail.body ? (
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-canvas p-3 text-sm">
                        {detail.body}
                      </pre>
                    ) : (
                      <p className="type-secondary text-muted">
                        {detail.memory.forgotten_at
                          ? "The stored note was removed. Its provenance remains available."
                          : "This revision’s note is unavailable."}
                      </p>
                    )}
                  </div>
                )}
                {detail.history.length ? (
                  <ul className="divide-y divide-border">
                    {detail.history.map((revision) => (
                      <li
                        className="flex flex-wrap justify-between gap-3 px-4 py-3 sm:px-5"
                        key={revision.id}
                      >
                        <Link
                          className="underline underline-offset-4"
                          aria-current={detail.revision?.id === revision.id ? "true" : undefined}
                          href={workspaceMemoryPath(workspaceSlug, {
                            ...factoryQuery,
                            memory: detail.memory.id,
                            revision: revision.id,
                            before: query.before,
                          })}
                        >
                          Revision {revision.revision_number}
                        </Link>
                        {revision.id === detail.memory.pending_revision_id ? (
                          <Status value="awaiting_review" />
                        ) : revision.id === detail.memory.current_revision_id ? (
                          <Status value="approved" />
                        ) : (
                          <span className="type-annotation text-muted">Historical</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="type-secondary p-4 text-muted">No revisions on this page.</p>
                )}
                {detail.nextRevision && (
                  <div className="p-4">
                    <Link
                      className="ui-button"
                      href={workspaceMemoryPath(workspaceSlug, {
                        ...factoryQuery,
                        memory: detail.memory.id,
                        revision: query.revision,
                        before: detail.nextRevision,
                      })}
                    >
                      Older revisions
                    </Link>
                  </div>
                )}
              </div>
            </PageSection>
            {detail.revision && (
              <PageSection title="Review decisions">
                <div className="ui-sheet min-w-0 divide-y divide-border">
                  {query.decision && !detail.requestedDecision && (
                    <p className="type-secondary p-4 text-muted">
                      The requested decision is unavailable for this revision.
                    </p>
                  )}
                  {[
                    ...(detail.requestedDecision ? [detail.requestedDecision] : []),
                    ...detail.decisions.filter(({ id }) => id !== detail.requestedDecision?.id),
                  ].map((decision) => (
                    <div className="min-w-0 space-y-2 p-4 sm:p-5" key={decision.id}>
                      <h3 className="type-label">
                        {decisionLabels[decision.action as keyof typeof decisionLabels] ??
                          decision.action}
                        {decision.id === detail.requestedDecision?.id ? " · Selected decision" : ""}
                      </h3>
                      <MetadataList>
                        <MetadataItem label="Decision ID" value={digest(decision.id)} monospace />
                        <MetadataItem
                          label="Reviewer"
                          value={digest(decision.actor_member_id)}
                          monospace
                        />
                        <MetadataItem
                          label="Recorded"
                          value={<TimeDisplay value={decision.created_at} initialNow={now} />}
                        />
                      </MetadataList>
                    </div>
                  ))}
                  {!detail.decisions.length && !detail.requestedDecision && (
                    <p className="type-secondary p-4 text-muted">
                      No decisions recorded for this revision.
                    </p>
                  )}
                </div>
              </PageSection>
            )}
            {canChange && !detail.memory.forgotten_at && (
              <PageSection title="Manage memory">
                <MemoryRevisionActions
                  key={`${detail.memory.current_revision_id}/${detail.memory.pending_revision_id}/${detail.revision?.id}`}
                  scope={actionScope}
                  memory={detail.memory}
                  body={detail.body}
                  canReview={Boolean(
                    detail.memory.pending_revision_id &&
                    detail.revision?.id === detail.memory.pending_revision_id,
                  )}
                />
              </PageSection>
            )}
          </>
        ) : (
          <>
            {query.proposal && (
              <PageSection title="Import a run proposal">
                {data.proposalAvailable && query.version ? (
                  <MemoryProposalForm
                    scope={actionScope}
                    artifactId={query.proposal}
                    artifactVersion={query.version}
                  />
                ) : (
                  <p className="ui-sheet type-secondary p-4 text-muted">
                    This proposal is unavailable or was already imported.
                  </p>
                )}
              </PageSection>
            )}
            <section
              aria-label="Factory memory"
              className="ui-sheet min-w-0 divide-y divide-border"
            >
              {data.items.length ? (
                <ul className="divide-y divide-border">
                  {data.items.map((item) => (
                    <li
                      className="flex min-w-0 flex-wrap justify-between gap-3 px-4 py-4 sm:px-5"
                      key={item.id}
                    >
                      <Link
                        className="min-w-0 font-semibold underline-offset-4 hover:underline [overflow-wrap:anywhere]"
                        href={workspaceMemoryPath(workspaceSlug, {
                          ...factoryQuery,
                          memory: item.id,
                        })}
                      >
                        {item.title ?? "Forgotten memory"}
                      </Link>
                      {item.forgotten_at ? (
                        <Status value="archived" label="Forgotten" />
                      ) : item.pending_revision_id ? (
                        <Status value="awaiting_review" />
                      ) : item.current_revision_id ? (
                        <Status value="approved" />
                      ) : (
                        <Status value="not_started" label="No approved revision" />
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="type-secondary px-4 py-5 text-muted sm:px-5">
                  No memory on this page.
                </p>
              )}
              {data.nextMemory && (
                <div className="p-4">
                  <Link
                    className="ui-button"
                    href={workspaceMemoryPath(workspaceSlug, {
                      ...factoryQuery,
                      after: data.nextMemory,
                    })}
                  >
                    More memory
                  </Link>
                </div>
              )}
            </section>
            {canChange && !query.proposal && (
              <p className="type-secondary text-muted">
                Open a run with a private proposal and choose{" "}
                <strong>Import memory proposal</strong>.{" "}
                <Link
                  className="underline underline-offset-4"
                  href={workspaceRunsPath(workspaceSlug, factoryQuery)}
                >
                  Browse runs
                </Link>
              </p>
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}

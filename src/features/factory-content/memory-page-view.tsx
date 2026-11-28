import type { ReactNode } from "react";
import Form from "next/form";
import Link from "next/link";

import { TimeDisplay } from "@/components/shared/time-display";
import { BackLink } from "@/components/ui/back-link";
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
  RetryMemoryProposal,
} from "@/features/factory-content/content-actions";
import type {
  loadMemoryPage,
  MemoryEligibility,
  MemoryIdentity,
} from "@/features/factory-content/content-data";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
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

const eligibilityLabels: Record<MemoryEligibility, string> = {
  eligible: "Eligible for future runs",
  archived: "Not eligible · factory archived",
  "workspace-deleting": "Not eligible · workspace scheduled for deletion",
  forgotten: "Not eligible · note removed",
  "awaiting-review": "Not eligible · awaiting review",
  "no-approval": "Not eligible · no approved revision",
  expired: "Not eligible · expired",
  "note-unavailable": "Not eligible · note unavailable",
};

function MemoryStatus({
  memory,
}: {
  memory: MemoryIdentity & { eligibility: MemoryEligibility; forgotten_at: string | null };
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {memory.forgotten_at ? (
        <Status
          value="archived"
          label="Forgotten"
          description="The stored memory note was removed."
        />
      ) : memory.current_revision_id ? (
        <Status value="approved" description="A manager approved the current memory revision." />
      ) : memory.pending_revision_id ? (
        <Status value="awaiting_review" description="A new memory revision needs manager review." />
      ) : (
        <Status value="not_started" label="No approved revision" />
      )}
      <span className="type-secondary text-muted">{eligibilityLabels[memory.eligibility]}</span>
    </div>
  );
}

const eligibilityHelp =
  "Wallie may include eligible memory as reference text for this factory. Not every run uses it.";

export function MemoryPageView({
  scope,
  data,
  factorySelector,
  activeFactory,
  query,
}: {
  scope: Pick<GovernanceScope, "workspaceId" | "workspaceSlug" | "factory">;
  data: Awaited<ReturnType<typeof loadMemoryPage>> | null;
  factorySelector?: ReactNode;
  activeFactory?: FactorySelectionOption;
  query: Parameters<typeof loadMemoryPage>[1];
}) {
  const { workspaceSlug } = scope;
  const factoryQuery = { factory: scope.factory.id };
  const rootPath = workspaceMemoryPath(workspaceSlug, factoryQuery);
  const listQuery = { q: query.q, after: query.after };
  const listPath = workspaceMemoryPath(workspaceSlug, { ...factoryQuery, ...listQuery });
  const actionScope = {
    workspaceSlug,
    workspaceId: scope.workspaceId,
    factoryId: scope.factory.id,
  };
  const canChange = scope.factory.status === "active";
  const now = data?.asOf ?? new Date().toISOString();
  const detail = data?.detail;
  const liveRevisionId = detail?.memory.pending_revision_id ?? detail?.memory.current_revision_id;
  const managePath = detail
    ? workspaceMemoryPath(workspaceSlug, {
        ...factoryQuery,
        ...listQuery,
        memory: detail.memory.id,
      })
    : rootPath;
  const canManage =
    canChange &&
    detail?.revision &&
    !detail.memory.forgotten_at &&
    !query.decision &&
    (liveRevisionId ? detail.revision.id === liveRevisionId : !query.revision && !query.before);
  const canReview = Boolean(
    detail?.memory.pending_revision_id && detail.revision?.id === detail.memory.pending_revision_id,
  );
  const selectedExpired = Boolean(
    detail?.revision?.expires_at && Date.parse(detail.revision.expires_at) <= Date.parse(now),
  );
  const approvalBlockedReason = !canReview
    ? undefined
    : selectedExpired
      ? "This revision expired. Save a correction with a future expiry or no expiry before approving."
      : !detail?.body
        ? "This revision’s note is unavailable. Save a correction with a note before approving."
        : undefined;
  const list = data?.list;
  const browseRuns = (
    <Link
      className="underline underline-offset-4"
      href={workspaceRunsPath(workspaceSlug, factoryQuery)}
    >
      Browse runs
    </Link>
  );

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        actions={factorySelector}
        actionsRightOnDesktop
        title="Memory"
        description={
          factorySelector
            ? undefined
            : scope.factory.status === "archived"
              ? `${scope.factory.name} · Archived`
              : scope.factory.name
        }
      />
      <div className="space-y-8">
        {!canChange && (
          <section aria-labelledby="memory-archived" className="ui-sheet space-y-2 p-4 sm:p-5">
            <h2 className="type-label" id="memory-archived">
              Archived · read-only
            </h2>
            <p className="type-secondary text-muted">
              You can still inspect memory revisions and decisions. This factory’s memory can’t be
              imported, changed, or used in new runs.
            </p>
            {activeFactory && (
              <Link
                className="ui-button"
                href={workspaceMemoryPath(workspaceSlug, { factory: activeFactory.id })}
              >
                Open memory in an active factory
              </Link>
            )}
          </section>
        )}
        {!detail && !list ? (
          <div className="ui-sheet space-y-3 p-4 sm:p-5">
            <p className="type-secondary text-muted">The requested memory is unavailable.</p>
            <BackLink className="ui-button" href={listPath}>
              Back to memory
            </BackLink>
          </div>
        ) : detail ? (
          <>
            <PageSection
              title={detail.memory.title ?? "Forgotten memory"}
              actions={
                <BackLink className="ui-button" href={listPath}>
                  All memory
                </BackLink>
              }
            >
              <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
                <div className="space-y-1">
                  <h3 className="type-label">Current memory status</h3>
                  <MemoryStatus memory={{ ...detail.memory, eligibility: detail.eligibility }} />
                  <p className="type-secondary text-muted">{eligibilityHelp}</p>
                </div>
                <MetadataList>
                  <MetadataItem
                    label="Source run"
                    value={
                      <Link
                        className="underline underline-offset-4"
                        href={workspaceRunDetailPath(workspaceSlug, detail.memory.source_run_id)}
                      >
                        {detail.sourceSessionNumber !== null &&
                          `Session #${detail.sourceSessionNumber} · `}
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
                          <span className="capitalize">
                            {detail.sourceArtifactStage.replaceAll("-", " ")}
                          </span>
                          {" · Artifact v"}
                          {detail.memory.source_artifact_version}
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
                  <div className="space-y-2 p-4 sm:p-5">
                    <p className="type-secondary text-muted">
                      The requested memory revision is unavailable. No changes can be made from this
                      view.
                    </p>
                    {canChange && !detail.memory.forgotten_at && (
                      <Link className="ui-button" href={managePath}>
                        {liveRevisionId
                          ? "Open current or pending revision"
                          : "Open memory management"}
                      </Link>
                    )}
                  </div>
                )}
                {detail.revision && (
                  <div className="space-y-4 p-4 sm:p-5">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="type-label">Revision {detail.revision.revision_number}</h3>
                      {selectedExpired && (
                        <Status
                          value="archived"
                          label="Expired"
                          description="This memory revision’s expiry has passed."
                        />
                      )}
                    </div>
                    {!canManage && canChange && !detail.memory.forgotten_at && (
                      <div className="space-y-2">
                        <p className="type-secondary text-muted">
                          {query.decision
                            ? "This decision receipt is read-only."
                            : "This historical revision is read-only."}
                        </p>
                        <Link className="ui-button" href={managePath}>
                          {liveRevisionId
                            ? "Open current or pending revision"
                            : "Open memory management"}
                        </Link>
                      </div>
                    )}
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
                      <pre
                        aria-label="Stored memory note"
                        className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-canvas p-3 text-sm focus-visible:outline-2 focus-visible:outline-accent"
                        role="region"
                        tabIndex={0}
                      >
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
                            ...listQuery,
                            memory: detail.memory.id,
                            revision: revision.id,
                            before: query.before,
                          })}
                        >
                          Revision {revision.revision_number}
                        </Link>
                        {revision.id === detail.memory.pending_revision_id ? (
                          <Status
                            value="awaiting_review"
                            description="This memory revision needs manager review."
                          />
                        ) : revision.id === detail.memory.current_revision_id ? (
                          <Status
                            value="approved"
                            description="This is the current approved memory revision."
                          />
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
                        ...listQuery,
                        memory: detail.memory.id,
                        revision: query.revision,
                        decision: query.decision,
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
                        <MetadataItem
                          label="Recorded by"
                          value={
                            detail.actorNames[decision.actor_member_id] || "Member unavailable"
                          }
                        />
                        <MetadataItem
                          label="Recorded"
                          value={<TimeDisplay value={decision.created_at} initialNow={now} />}
                        />
                      </MetadataList>
                      <details>
                        <summary className="type-secondary w-fit cursor-pointer rounded-sm text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent">
                          Technical details
                        </summary>
                        <MetadataList className="mt-2">
                          <MetadataItem label="Decision ID" value={digest(decision.id)} monospace />
                          <MetadataItem
                            label="Member ID"
                            value={digest(decision.actor_member_id)}
                            monospace
                          />
                        </MetadataList>
                      </details>
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
            {canManage && (
              <PageSection title="Manage memory">
                {!liveRevisionId && (
                  <p className="type-secondary mb-3 text-muted">
                    There’s no current or pending revision. You can start a correction without
                    copying the historical note.
                  </p>
                )}
                <MemoryRevisionActions
                  key={`${detail.memory.current_revision_id}/${detail.memory.pending_revision_id}/${detail.revision?.id}`}
                  scope={actionScope}
                  memory={detail.memory}
                  body={liveRevisionId ? detail.body : null}
                  expiresAt={liveRevisionId ? (detail.revision?.expires_at ?? null) : null}
                  canReview={canReview}
                  approvalBlockedReason={approvalBlockedReason}
                  listQuery={listQuery}
                />
              </PageSection>
            )}
          </>
        ) : (
          list && (
            <>
              {query.proposal && (
                <PageSection title="Import a run proposal">
                  {list.proposalAvailability === "available" && query.version ? (
                    <MemoryProposalForm
                      scope={actionScope}
                      artifactId={query.proposal}
                      artifactVersion={query.version}
                      listQuery={listQuery}
                    />
                  ) : (
                    <div className="ui-sheet type-secondary space-y-3 p-4 text-muted sm:p-5">
                      {list.proposalAvailability === "archived" ? (
                        <p>Proposals can’t be imported into an archived factory.</p>
                      ) : list.proposalAvailability === "error" ? (
                        <>
                          <p>Wallie couldn’t check whether this proposal is available.</p>
                          <RetryMemoryProposal />
                        </>
                      ) : list.proposalAvailability === "access-required" ? (
                        <p>
                          Factory manager access is required to open this proposal.{" "}
                          <BackLink className="underline underline-offset-4" href={listPath}>
                            Back to memory
                          </BackLink>
                        </p>
                      ) : (
                        <p>This proposal is unavailable or was already imported. {browseRuns}</p>
                      )}
                    </div>
                  )}
                </PageSection>
              )}
              <section
                aria-label="Factory memory"
                className="ui-sheet min-w-0 divide-y divide-border"
              >
                <div className="space-y-2 p-4 sm:p-5">
                  <Form
                    action={workspaceMemoryPath(workspaceSlug)}
                    className="flex flex-wrap items-end gap-2"
                  >
                    <input type="hidden" name="factory" value={scope.factory.id} />
                    <label className="block min-w-0 grow space-y-1.5 sm:max-w-sm">
                      <span className="type-label">Search memory titles</span>
                      <input
                        autoComplete="off"
                        className="ui-input w-full"
                        defaultValue={query.q ?? ""}
                        key={query.q ?? ""}
                        maxLength={120}
                        name="q"
                        type="search"
                      />
                    </label>
                    <button className="ui-button" type="submit">
                      Search
                    </button>
                    {query.q && (
                      <Link className="ui-button" href={rootPath}>
                        Clear search
                      </Link>
                    )}
                  </Form>
                  <p className="type-secondary text-muted">{eligibilityHelp}</p>
                </div>
                {list.items.length ? (
                  <ul className="divide-y divide-border">
                    {list.items.map((item) => (
                      <li
                        className="flex min-w-0 flex-wrap justify-between gap-3 px-4 py-4 sm:px-5"
                        key={item.id}
                      >
                        <Link
                          className="min-w-0 font-semibold underline-offset-4 hover:underline [overflow-wrap:anywhere]"
                          href={workspaceMemoryPath(workspaceSlug, {
                            ...factoryQuery,
                            ...listQuery,
                            memory: item.id,
                          })}
                        >
                          {item.title ?? "Forgotten memory"}
                        </Link>
                        <MemoryStatus memory={item} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="space-y-2 p-4 sm:p-5">
                    <h2 className="type-label">
                      {query.after
                        ? "No more memories on this page"
                        : query.q
                          ? "No matching memories"
                          : "No memories in this factory yet"}
                    </h2>
                    {query.after ? (
                      <Link
                        className="ui-button"
                        href={workspaceMemoryPath(workspaceSlug, { ...factoryQuery, q: query.q })}
                      >
                        Back to first page
                      </Link>
                    ) : query.q ? (
                      <p className="type-secondary text-muted">
                        Try a different title or clear the search.
                      </p>
                    ) : canChange ? (
                      <p className="type-secondary text-muted">
                        Open a run with a private proposal and choose{" "}
                        <strong>Import memory proposal</strong>. {browseRuns}
                      </p>
                    ) : null}
                  </div>
                )}
                {list.nextMemory && (
                  <div className="p-4">
                    <Link
                      className="ui-button"
                      href={workspaceMemoryPath(workspaceSlug, {
                        ...factoryQuery,
                        q: query.q,
                        after: list.nextMemory,
                      })}
                    >
                      Older memories
                    </Link>
                  </div>
                )}
              </section>
              {canChange && !query.proposal && list.items.length > 0 && (
                <p className="type-secondary text-muted">
                  Open a run with a private proposal and choose{" "}
                  <strong>Import memory proposal</strong>. {browseRuns}
                </p>
              )}
            </>
          )
        )}
      </div>
    </PageContainer>
  );
}

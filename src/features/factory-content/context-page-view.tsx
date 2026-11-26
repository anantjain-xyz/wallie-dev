import type { ReactNode } from "react";
import Link from "next/link";

import { TimeDisplay } from "@/components/shared/time-display";
import {
  MetadataItem,
  MetadataList,
  PageContainer,
  PageHeader,
  PageSection,
} from "@/components/ui/page-shell";
import { Status, type StatusValue } from "@/components/ui/status";
import {
  ContextRegistration,
  ContextSourceActions,
} from "@/features/factory-content/content-actions";
import type { loadContextPage } from "@/features/factory-content/content-data";
import type { GovernanceScope } from "@/features/factory-governance/governance-data";
import { factoryContextPinHref } from "@/lib/factory-definitions/context-handoff";
import { workspaceContextPath, workspaceGovernancePath, workspaceSettingsPath } from "@/lib/routes";

function sourceStatus(saved: string, access: string | undefined): [StatusValue, string] {
  if (saved === "deleted") return ["archived", "Source removed"];
  if (access === "access_revoked" || (access === undefined && saved === "access_revoked"))
    return ["blocked", "Grant unavailable"];
  if (access === undefined) return ["needs_attention", "Source access not verified"];
  if (saved === "upstream_deleted") return ["blocked", "Upstream file removed"];
  if (saved === "stale") return ["needs_attention", "Stale revision"];
  if (saved === "pending") return ["not_started", "Awaiting sync"];
  if (saved === "synced" && access === "available") return ["healthy", "Synced"];
  return ["needs_attention", "Source unavailable"];
}

function ContextAccessRecovery({
  scope,
  grantId,
}: {
  scope: Pick<GovernanceScope, "workspaceSlug" | "factory" | "isOperator">;
  grantId?: string;
}) {
  return (
    <div className="space-y-2">
      <p className="type-secondary text-muted">
        {scope.isOperator
          ? "Check that GitHub is connected and this factory has an approved read grant for the repository."
          : "Check this factory’s read grants in Governance. Ask a workspace owner or admin to fix the GitHub connection if needed."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Link
          className="ui-button"
          href={workspaceGovernancePath(scope.workspaceSlug, {
            factory: scope.factory.id,
            grant: grantId,
          })}
        >
          {grantId ? "Review execution grant" : "View Governance"}
        </Link>
        {scope.isOperator && (
          <Link
            className="ui-button"
            href={`${workspaceSettingsPath(scope.workspaceSlug, { category: "integrations" })}#github`}
          >
            GitHub settings
          </Link>
        )}
      </div>
    </div>
  );
}

export function ContextPageView({
  scope,
  data,
  factorySelector,
  query,
}: {
  scope: Pick<GovernanceScope, "workspaceId" | "workspaceSlug" | "factory" | "isOperator">;
  data: Awaited<ReturnType<typeof loadContextPage>> | null;
  factorySelector?: ReactNode;
  query: Parameters<typeof loadContextPage>[1];
}) {
  const { workspaceSlug } = scope;
  const rootPath = workspaceContextPath(workspaceSlug, { factory: scope.factory.id });
  const canChange = scope.factory.status === "active";
  const actionScope = {
    workspaceSlug,
    workspaceId: scope.workspaceId,
    factoryId: scope.factory.id,
  };
  const now = new Date().toISOString();
  const source = data?.source;
  const revision = data?.revision;
  const access = source ? data?.access[source.id] : undefined;
  const publishedPin = data?.publishedDocuments?.find(({ sourceId }) => sourceId === source?.id);
  const pinStatusUnavailable = data?.publishedDocuments === undefined;
  const canPropose =
    canChange &&
    source &&
    (source.status === "synced" || source.status === "stale") &&
    access === "available" &&
    revision?.source_id === source.id &&
    !revision.content_purged_at;
  const [sourceValue, sourceLabel] = source
    ? sourceStatus(source.status, access)
    : (["not_started", ""] as const);

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        actions={factorySelector}
        actionsRightOnDesktop
        title="Context"
        eyebrow={factorySelector ? undefined : scope.factory.name}
        description="Synced means Wallie saved a revision. Pinned means the published factory definition selects an exact revision for new sessions. Syncing does not change pins. Open a run’s Frozen inputs to see what it actually used, omitted, or could not access."
      />
      <div className="space-y-8">
        {!canChange && (
          <p className="type-secondary text-muted">
            This factory is archived. You can inspect its sources and history, but cannot register,
            sync, remove, or propose revisions.
          </p>
        )}
        {!data || (query.source && !source) ? (
          <section aria-label="Source unavailable" className="ui-sheet space-y-3 p-4 sm:p-5">
            <p className="type-secondary text-muted">
              The requested context source is unavailable.
            </p>
            <Link className="ui-button" href={rootPath}>
              Back to context
            </Link>
          </section>
        ) : source ? (
          <>
            <PageSection
              className="[overflow-wrap:anywhere]"
              title={source.file_path}
              actions={
                <Link className="ui-button" href={rootPath}>
                  All sources
                </Link>
              }
            >
              <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
                <Status value={sourceValue} label={sourceLabel} />
                <MetadataList>
                  <MetadataItem
                    label="Repository"
                    value={data.repositoryNames[source.id] ?? "Repository unavailable"}
                  />
                  <MetadataItem
                    label="Execution grant"
                    value={
                      data.sourceGrant ? (
                        <Link
                          className="[overflow-wrap:anywhere] underline underline-offset-4"
                          href={workspaceGovernancePath(workspaceSlug, {
                            factory: scope.factory.id,
                            grant: source.grant_id,
                          })}
                        >
                          {data.sourceGrant.principalName} · Grant v{source.grant_version}
                          {data.sourceGrant.published ? " · Used by published definition" : ""}
                        </Link>
                      ) : (
                        "Grant unavailable"
                      )
                    }
                  />
                  {data.sourceGrant && (
                    <MetadataItem
                      label="Grant expiry"
                      value={<TimeDisplay value={data.sourceGrant.expiresAt} initialNow={now} />}
                    />
                  )}
                  <MetadataItem
                    label="Published pin"
                    value={
                      publishedPin ? (
                        <Link
                          className="underline underline-offset-4"
                          href={workspaceContextPath(workspaceSlug, {
                            factory: scope.factory.id,
                            source: source.id,
                            revision: publishedPin.revisionId,
                          })}
                        >
                          View pinned revision
                        </Link>
                      ) : pinStatusUnavailable ? (
                        "Pin status unavailable"
                      ) : (
                        "Not pinned"
                      )
                    }
                  />
                  <MetadataItem
                    label="Last successful sync"
                    value={
                      source.last_successful_sync_at ? (
                        <TimeDisplay value={source.last_successful_sync_at} initialNow={now} />
                      ) : (
                        "Never synced"
                      )
                    }
                  />
                  <MetadataItem
                    label="Last sync attempt"
                    value={
                      source.last_sync_attempt_at ? (
                        <TimeDisplay value={source.last_sync_attempt_at} initialNow={now} />
                      ) : (
                        "No attempts"
                      )
                    }
                  />
                </MetadataList>
                {canChange &&
                  (sourceLabel === "Grant unavailable" ||
                    source.status === "access_revoked" ||
                    !data.sourceGrant) && (
                    <ContextAccessRecovery scope={scope} grantId={source.grant_id} />
                  )}
                {sourceLabel === "Source access not verified" && (
                  <p className="type-secondary text-muted">
                    Reload this page before syncing or proposing a revision.
                  </p>
                )}
                {sourceLabel === "Stale revision" && (
                  <p className="type-secondary text-muted">
                    The last verified revision is retained. Sync to check for a newer version.
                  </p>
                )}
                {sourceLabel === "Upstream file removed" && (
                  <p className="type-secondary text-muted">
                    Check the document path in the repository before syncing again.
                  </p>
                )}
                {sourceLabel === "Source unavailable" && canChange && (
                  <p className="type-secondary text-muted">
                    Check that the file is readable at this path, then sync again.
                  </p>
                )}
                {canChange && source.status !== "deleted" && (
                  <ContextSourceActions
                    key={source.id}
                    scope={actionScope}
                    sourceId={source.id}
                    canSync={access === "available" || access === "unavailable"}
                  />
                )}
                <details>
                  <summary className="type-label w-fit cursor-pointer">Source identifiers</summary>
                  <div className="mt-2">
                    <MetadataList>
                      <MetadataItem label="Source ID" value={source.id} monospace />
                      <MetadataItem label="Grant ID" value={source.grant_id} monospace />
                      <MetadataItem label="Grant version" value={source.grant_version} />
                    </MetadataList>
                  </div>
                </details>
              </div>
            </PageSection>
            <PageSection title="Revision history">
              <div className="ui-sheet min-w-0 divide-y divide-border">
                {query.revision && !data.revision && (
                  <p className="type-secondary p-4 text-muted">
                    The requested source revision is unavailable.
                  </p>
                )}
                {revision && (
                  <div className="space-y-3 p-4 sm:p-5">
                    <h3 className="type-label">
                      {revision.id === source.current_revision_id
                        ? "Current revision"
                        : "Selected historical revision"}
                    </h3>
                    <MetadataList>
                      <MetadataItem
                        label="Revision commit"
                        value={revision.upstream_revision.slice(0, 12)}
                        monospace
                      />
                      <MetadataItem
                        label="Recorded"
                        value={<TimeDisplay value={revision.created_at} initialNow={now} />}
                      />
                      <MetadataItem
                        label="Size"
                        value={
                          revision.content_bytes === null
                            ? "Unavailable"
                            : `${revision.content_bytes.toLocaleString("en")} bytes`
                        }
                      />
                      {revision.content_purged_at ? (
                        <MetadataItem
                          label="Body removed"
                          value={
                            <TimeDisplay value={revision.content_purged_at} initialNow={now} />
                          }
                        />
                      ) : null}
                    </MetadataList>
                    <p className="type-secondary text-muted">
                      {revision.id === publishedPin?.revisionId
                        ? "This exact revision is pinned in the published definition."
                        : pinStatusUnavailable
                          ? "Wallie could not verify the published pin for this revision."
                          : publishedPin
                            ? "The published definition pins a different revision of this source."
                            : "This revision is not pinned in the published definition."}
                    </p>
                    {canPropose ? (
                      scope.isOperator ? (
                        <div className="space-y-2">
                          <Link
                            className="ui-button ui-button-primary"
                            href={factoryContextPinHref(workspaceSlug, scope.factory.id, {
                              sourceId: source.id,
                              revisionId: revision.id,
                            })}
                          >
                            Propose revision in Factory Definition
                          </Link>
                          <p className="type-secondary text-muted">
                            The editor checks the source’s exact grant and version. Opening the
                            proposal does not add a pin, save a draft, or publish.
                          </p>
                        </div>
                      ) : (
                        <p className="type-secondary text-muted">
                          Ask a workspace owner or admin to pin this revision. Send them the{" "}
                          <Link
                            className="underline underline-offset-4"
                            href={workspaceContextPath(workspaceSlug, {
                              factory: scope.factory.id,
                              source: source.id,
                              revision: revision.id,
                            })}
                          >
                            exact revision link
                          </Link>
                          .
                        </p>
                      )
                    ) : canChange ? (
                      <p className="type-secondary text-muted">
                        {revision.content_purged_at
                          ? "This revision’s body was removed. Choose a retained revision."
                          : "This revision is not currently eligible for a pin. Check source and grant access above."}
                      </p>
                    ) : null}
                    <details>
                      <summary className="type-label w-fit cursor-pointer">
                        Technical details
                      </summary>
                      <div className="mt-2 [overflow-wrap:anywhere]">
                        <MetadataList>
                          <MetadataItem label="Revision ID" value={revision.id} monospace />
                          <MetadataItem
                            label="Upstream commit"
                            value={revision.upstream_revision}
                            monospace
                          />
                          <MetadataItem
                            label="Content digest"
                            value={revision.content_sha256}
                            monospace
                          />
                        </MetadataList>
                      </div>
                    </details>
                  </div>
                )}
                {data.history.length ? (
                  <ul className="divide-y divide-border">
                    {data.history.map((item) => (
                      <li
                        className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5"
                        key={item.id}
                      >
                        <Link
                          className="break-words underline underline-offset-4"
                          aria-current={revision?.id === item.id ? "true" : undefined}
                          href={workspaceContextPath(workspaceSlug, {
                            factory: scope.factory.id,
                            source: source.id,
                            revision: item.id,
                            before: query.before,
                          })}
                        >
                          {item.id === source.current_revision_id ? "Current" : "Historical"} ·{" "}
                          {item.upstream_revision.slice(0, 12)}
                        </Link>
                        <span className="type-annotation text-muted">
                          {item.content_purged_at ? (
                            "Body removed"
                          ) : (
                            <TimeDisplay value={item.created_at} initialNow={now} />
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="type-secondary px-4 py-5 text-muted sm:px-5">
                    No source revisions have been retained.
                  </p>
                )}
                {data.nextRevision && (
                  <div className="p-4">
                    <Link
                      className="ui-button"
                      href={workspaceContextPath(workspaceSlug, {
                        factory: scope.factory.id,
                        source: source.id,
                        revision: query.revision,
                        before: data.nextRevision,
                      })}
                    >
                      Older revisions
                    </Link>
                  </div>
                )}
              </div>
            </PageSection>
          </>
        ) : (
          <>
            <section
              aria-label="Context sources"
              className="ui-sheet min-w-0 divide-y divide-border"
            >
              {data.items.length ? (
                <ul className="divide-y divide-border">
                  {data.items.map((item) => {
                    const [value, label] = sourceStatus(item.status, data.access[item.id]);
                    const repository = data.repositoryNames[item.id] ?? "Repository unavailable";
                    const pin = data.publishedDocuments?.some(
                      ({ sourceId }) => sourceId === item.id,
                    );
                    return (
                      <li
                        className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5"
                        key={item.id}
                      >
                        <Link
                          className="min-w-0 underline-offset-4 hover:underline [overflow-wrap:anywhere]"
                          href={workspaceContextPath(workspaceSlug, {
                            factory: scope.factory.id,
                            source: item.id,
                          })}
                        >
                          <span className="block font-semibold">{item.file_path}</span>
                          <span className="type-annotation block text-muted">{repository}</span>
                        </Link>
                        <div className="flex flex-wrap items-center gap-2">
                          <Status value={value} label={label} />
                          <span className="type-annotation text-muted">
                            {pin
                              ? "Pinned in published definition"
                              : pinStatusUnavailable
                                ? "Pin status unavailable"
                                : "Not pinned"}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="type-secondary px-4 py-5 text-muted sm:px-5">
                  No context sources on this page.
                </p>
              )}
              {data.nextSource && (
                <div className="p-4">
                  <Link
                    className="ui-button"
                    href={workspaceContextPath(workspaceSlug, {
                      factory: scope.factory.id,
                      after: data.nextSource,
                    })}
                  >
                    More sources
                  </Link>
                </div>
              )}
            </section>
            {canChange && (
              <PageSection title="Register a source">
                {data.options.length ? (
                  <>
                    <ContextRegistration
                      key={`${scope.factory.id}/${query.grantAfter}/${query.repoAfter}`}
                      scope={actionScope}
                      options={data.options}
                    />
                    {data.nextOption && (
                      <Link
                        className="ui-button mt-3"
                        href={workspaceContextPath(workspaceSlug, {
                          factory: scope.factory.id,
                          after: query.after,
                          grantAfter: data.nextOption.grant_id,
                          repoAfter: data.nextOption.repository_id,
                        })}
                      >
                        More repositories
                      </Link>
                    )}
                  </>
                ) : (
                  <div className="ui-sheet space-y-3 p-4 sm:p-5">
                    <p className="type-secondary text-muted">
                      {data.optionsUnavailable
                        ? "Repository access could not be verified. Reload to try again."
                        : query.grantAfter
                          ? "No authorized repositories remain on this page."
                          : "No repository has verified read access for this factory."}
                    </p>
                    {query.grantAfter ? (
                      <Link className="ui-button" href={rootPath}>
                        Back to first repository choices
                      </Link>
                    ) : null}
                    {!data.optionsUnavailable && <ContextAccessRecovery scope={scope} />}
                  </div>
                )}
              </PageSection>
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}

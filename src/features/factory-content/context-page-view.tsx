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
import { workspaceContextPath, workspaceGovernancePath } from "@/lib/routes";

function sourceStatus(saved: string, access: string | undefined): [StatusValue, string] {
  if (saved === "deleted") return ["archived", "Source removed"];
  if (access === "access_revoked" || (access === undefined && saved === "access_revoked"))
    return ["blocked", "Grant unavailable"];
  if (saved === "upstream_deleted") return ["blocked", "Upstream file removed"];
  if (saved === "stale") return ["needs_attention", "Stale revision"];
  if (saved === "pending") return ["not_started", "Awaiting sync"];
  if (saved === "synced" && access === "available") return ["healthy", "Synced"];
  return ["needs_attention", "Source unavailable"];
}

export function ContextPageView({
  scope,
  data,
  query,
}: {
  scope: Pick<GovernanceScope, "workspaceId" | "workspaceSlug" | "factory">;
  data: Awaited<ReturnType<typeof loadContextPage>> | null;
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
  const [sourceValue, sourceLabel] = source
    ? sourceStatus(source.status, data?.access[source.id])
    : (["not_started", ""] as const);

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        title="Context"
        description={
          scope.factory.status === "archived"
            ? `${scope.factory.name} · Archived`
            : scope.factory.name
        }
      />
      <div className="space-y-8">
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
              title="Context source"
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
                    label="Document"
                    value={<span className="[overflow-wrap:anywhere]">{source.file_path}</span>}
                  />
                  <MetadataItem
                    label="Repository"
                    value={data.repositoryName ?? "Repository unavailable"}
                  />
                  <MetadataItem
                    label="Execution grant"
                    value={
                      <Link
                        className="underline underline-offset-4"
                        href={workspaceGovernancePath(workspaceSlug, {
                          factory: scope.factory.id,
                          grant: source.grant_id,
                        })}
                      >
                        {source.grant_id.slice(0, 8)} · v{source.grant_version}
                      </Link>
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
                {sourceLabel === "Grant unavailable" && (
                  <p className="type-secondary text-muted">
                    Review the repository’s execution grant in Governance.
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
                {canChange && source.status !== "deleted" && (
                  <ContextSourceActions
                    scope={actionScope}
                    sourceId={source.id}
                    canSync={sourceLabel !== "Grant unavailable"}
                  />
                )}
              </div>
            </PageSection>
            <PageSection title="Revision history">
              <div className="ui-sheet min-w-0 divide-y divide-border">
                {query.revision && !data.revision && (
                  <p className="type-secondary p-4 text-muted">
                    The requested source revision is unavailable.
                  </p>
                )}
                {data.revision && (
                  <div className="space-y-3 p-4 sm:p-5">
                    <h3 className="type-label">
                      {data.revision.id === source.current_revision_id
                        ? "Current revision"
                        : "Selected historical revision"}
                    </h3>
                    <MetadataList>
                      <MetadataItem
                        label="Revision ID"
                        value={<span className="[overflow-wrap:anywhere]">{data.revision.id}</span>}
                        monospace
                      />
                      <MetadataItem
                        label="Upstream commit"
                        value={
                          <span className="[overflow-wrap:anywhere]">
                            {data.revision.upstream_revision}
                          </span>
                        }
                        monospace
                      />
                      <MetadataItem
                        label="Content digest"
                        value={
                          <span className="[overflow-wrap:anywhere]">
                            {data.revision.content_sha256}
                          </span>
                        }
                        monospace
                      />
                      <MetadataItem
                        label="Size"
                        value={
                          data.revision.content_bytes === null
                            ? "Unavailable"
                            : `${data.revision.content_bytes.toLocaleString("en")} bytes`
                        }
                      />
                      {data.revision.content_purged_at ? (
                        <MetadataItem
                          label="Body removed"
                          value={
                            <TimeDisplay value={data.revision.content_purged_at} initialNow={now} />
                          }
                        />
                      ) : null}
                    </MetadataList>
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
                          aria-current={data.revision?.id === item.id ? "true" : undefined}
                          href={workspaceContextPath(workspaceSlug, {
                            factory: scope.factory.id,
                            source: source.id,
                            revision: item.id,
                            before: query.before,
                          })}
                        >
                          Revision {item.upstream_revision.slice(0, 12)}
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
                    return (
                      <li
                        className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5"
                        key={item.id}
                      >
                        <Link
                          className="min-w-0 font-semibold underline-offset-4 hover:underline [overflow-wrap:anywhere]"
                          href={workspaceContextPath(workspaceSlug, {
                            factory: scope.factory.id,
                            source: item.id,
                          })}
                        >
                          {item.file_path}
                        </Link>
                        <Status value={value} label={label} />
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
                      key={`${query.grantAfter}/${query.repoAfter}`}
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
                        : "Approve repository read access for this factory in Governance before registering a source."}
                    </p>
                    <Link
                      className="ui-button"
                      href={workspaceGovernancePath(workspaceSlug, { factory: scope.factory.id })}
                    >
                      View governance
                    </Link>
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

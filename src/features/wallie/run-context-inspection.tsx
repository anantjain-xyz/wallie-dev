import Link from "next/link";

import { TimeDisplay } from "@/components/shared/time-display";
import { MetadataItem, MetadataList, PageSection } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import type { RunInspectorContext } from "@/features/wallie/run-inspector-data";
import { workspaceContextPath, workspaceMemoryPath, workspaceRunDetailPath } from "@/lib/routes";

const reasonLabels = {
  not_selected: "Outside the pinned definition",
  byte_limit: "Document exceeded its size limit",
  context_budget: "Context budget reached",
  missing_revision: "Revision unavailable",
  source_unavailable: "Source unavailable",
  access_revoked: "Source access revoked",
  revision_changed: "Revision changed",
  upstream_deleted: "Upstream file removed",
  upstream_unavailable: "Upstream unavailable",
  revision_mismatch: "Upstream did not match the recorded revision",
};

function digest(value: string) {
  return <span className="[overflow-wrap:anywhere]">{value}</span>;
}

export function RunContextInspection({
  result,
  workspaceSlug,
  initialNow,
  memoryProposalHref,
}: {
  result: RunInspectorContext;
  workspaceSlug: string;
  initialNow: string;
  memoryProposalHref?: string | null;
}) {
  if (result.kind !== "recorded") {
    return (
      <PageSection anchorId="frozen-inputs" title="Frozen inputs">
        <p className="ui-sheet type-secondary p-4 text-muted">
          {result.kind === "unrecorded"
            ? "This attempt has no recorded input manifest."
            : "The input manifest is unavailable."}
        </p>
      </PageSection>
    );
  }
  const { factoryId, canManage, originRunId, manifestSha256, createdAt, manifest } = result.context;
  const memories = manifest.version === 2 ? manifest.memories : [];
  const omitted = manifest.conversation.messages.filter((message) => "reason" in message).length;
  return (
    <PageSection
      anchorId="frozen-inputs"
      title="Frozen inputs"
      actions={
        memoryProposalHref ? (
          <Link className="ui-button" href={memoryProposalHref}>
            Import memory proposal
          </Link>
        ) : undefined
      }
    >
      <div className="ui-sheet min-w-0 divide-y divide-border">
        <div className="p-4 sm:p-5">
          <MetadataList>
            <MetadataItem label="Manifest digest" value={digest(manifestSha256)} monospace />
            <MetadataItem
              label="Frozen"
              value={<TimeDisplay value={createdAt} initialNow={initialNow} />}
            />
            <MetadataItem
              label="Context budget"
              value={`${manifest.budget.usedUtf8Bytes.toLocaleString("en")} of ${manifest.budget.maxEstimatedTokens.toLocaleString("en")} estimated tokens`}
            />
            {originRunId && (
              <MetadataItem
                label="Retry origin"
                value={
                  <Link
                    className="underline underline-offset-4"
                    href={workspaceRunDetailPath(workspaceSlug, originRunId)}
                  >
                    Open original attempt
                  </Link>
                }
              />
            )}
          </MetadataList>
        </div>
        <div className="space-y-3 p-4 sm:p-5">
          <h3 className="type-label">Context documents</h3>
          {manifest.documents.length ? (
            <ul className="divide-y divide-border">
              {manifest.documents.map((document) => (
                <li className="min-w-0 space-y-2 py-3" key={document.sourceId}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {canManage ? (
                      <Link
                        className="break-words underline underline-offset-4 [overflow-wrap:anywhere]"
                        href={workspaceContextPath(workspaceSlug, {
                          factory: factoryId,
                          source: document.sourceId,
                          revision: document.revisionId,
                        })}
                      >
                        {document.status === "selected"
                          ? (document.filePath ?? "Document revision")
                          : "Document revision"}
                      </Link>
                    ) : (
                      <span className="type-secondary">Document revision</span>
                    )}
                    <Status
                      value={
                        document.status === "selected"
                          ? document.stale
                            ? "needs_attention"
                            : "healthy"
                          : document.status === "excluded"
                            ? "skipped"
                            : "blocked"
                      }
                      label={
                        document.status === "selected"
                          ? document.stale
                            ? "Used stale revision"
                            : "Used"
                          : document.status === "excluded"
                            ? "Omitted"
                            : "Unavailable"
                      }
                    />
                  </div>
                  <MetadataList>
                    <MetadataItem label="Source ID" value={digest(document.sourceId)} monospace />
                    <MetadataItem
                      label="Revision ID"
                      value={digest(document.revisionId)}
                      monospace
                    />
                    {document.status === "selected" ? (
                      <>
                        <MetadataItem
                          label="Upstream commit"
                          value={digest(document.upstreamRevision)}
                          monospace
                        />
                        <MetadataItem
                          label="Content digest"
                          value={digest(document.contentSha256)}
                          monospace
                        />
                      </>
                    ) : (
                      <MetadataItem label="Reason" value={reasonLabels[document.reason]} />
                    )}
                  </MetadataList>
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-secondary text-muted">
              No document revisions were selected for this attempt.
            </p>
          )}
        </div>
        <div className="space-y-3 p-4 sm:p-5">
          <h3 className="type-label">Factory memory</h3>
          {memories.length ? (
            <ul className="divide-y divide-border">
              {memories.map((memory) => (
                <li className="min-w-0 space-y-2 py-3" key={memory.memoryId}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {canManage ? (
                      <Link
                        className="underline underline-offset-4"
                        href={workspaceMemoryPath(workspaceSlug, {
                          factory: factoryId,
                          memory: memory.memoryId,
                          revision: memory.revisionId,
                          decision: memory.status === "selected" ? memory.approvalId : undefined,
                        })}
                      >
                        Memory revision
                      </Link>
                    ) : (
                      <span className="type-secondary">Memory revision</span>
                    )}
                    <Status
                      value={memory.status === "selected" ? "healthy" : "skipped"}
                      label={memory.status === "selected" ? "Used" : "Omitted"}
                    />
                  </div>
                  <MetadataList>
                    <MetadataItem label="Memory ID" value={digest(memory.memoryId)} monospace />
                    <MetadataItem label="Revision ID" value={digest(memory.revisionId)} monospace />
                    {memory.status === "selected" ? (
                      <>
                        <MetadataItem
                          label="Approval ID"
                          value={digest(memory.approvalId)}
                          monospace
                        />
                        <MetadataItem
                          label="Content digest"
                          value={digest(memory.sha256)}
                          monospace
                        />
                      </>
                    ) : (
                      <MetadataItem label="Reason" value={reasonLabels[memory.reason]} />
                    )}
                  </MetadataList>
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-secondary text-muted">
              {manifest.version === 1
                ? "This manifest version did not record memory inputs."
                : "No memory revisions were selected for this attempt."}
            </p>
          )}
        </div>
        <details className="p-4 sm:p-5">
          <summary className="type-label cursor-pointer">Required inputs and conversation</summary>
          {manifest.required.length > 0 && (
            <ul className="mt-3 space-y-2">
              {manifest.required.map((item) => (
                <li className="min-w-0" key={item.key}>
                  <MetadataList>
                    <MetadataItem label={item.key} value={digest(item.sha256)} monospace />
                    <MetadataItem
                      label="Size"
                      value={`${item.utf8Bytes.toLocaleString("en")} bytes`}
                    />
                  </MetadataList>
                </li>
              ))}
            </ul>
          )}
          <p className="type-secondary mt-3 text-muted">
            {manifest.conversation.messages.length - omitted} conversation messages used. {omitted}{" "}
            omitted by budget. {manifest.conversation.olderOmitted} earlier messages outside the
            recorded window.
          </p>
        </details>
      </div>
    </PageSection>
  );
}

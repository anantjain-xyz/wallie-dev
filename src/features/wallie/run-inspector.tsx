import Link from "next/link";
import type { ReactNode } from "react";

import { ExecutionProfileFields } from "@/components/shared/execution-profile-fields";
import { TimeDisplay } from "@/components/shared/time-display";
import {
  MetadataItem,
  MetadataList,
  PageContainer,
  PageHeader,
  PageSection,
} from "@/components/ui/page-shell";
import { Status, agentRunStatusValue } from "@/components/ui/status";
import { ArtifactEvidenceInspector } from "@/features/wallie/artifact-evidence-inspector";
import type { WorkspaceRunCatalogItem } from "@/features/wallie/run-catalog";
import type {
  RunInspectorArtifact,
  RunInspectorCredential,
  RunInspectorExecutionProfile,
  RunInspectorMcpManifest,
  RunInspectorSkills,
} from "@/features/wallie/run-inspector-data";
import { RUN_PROVIDER_LABELS, runCatalogCostLabel } from "@/features/wallie/runs-list-state";
import { workspaceRunsPath } from "@/lib/routes";

export function RunInspector({
  run,
  artifact,
  credential,
  executionProfile,
  mcp,
  skills,
  workspaceId,
  workspaceSlug,
  initialNow,
  transcript,
}: {
  run: WorkspaceRunCatalogItem;
  artifact: RunInspectorArtifact;
  credential?: RunInspectorCredential | null;
  executionProfile?: RunInspectorExecutionProfile;
  mcp?: RunInspectorMcpManifest | null;
  skills: RunInspectorSkills;
  workspaceId: string;
  workspaceSlug: string;
  initialNow: string;
  transcript: ReactNode;
}) {
  const active = run.status === "started" || run.status === "running";
  const recovery = recoveryAction(run);
  const recorded = executionProfile?.kind === "recorded" ? executionProfile.profile : null;
  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        actions={
          <Status
            label={
              run.interrupted ? "Interrupted" : run.status === "started" ? "Starting" : undefined
            }
            value={agentRunStatusValue(run.status)}
          />
        }
        actionsRightOnDesktop
        description={
          <>
            {run.stageName ?? "Session run"} ·{" "}
            {run.attemptCount === null ? "Attempt not recorded" : `Attempt ${run.attemptCount}`}
          </>
        }
        eyebrow={
          <Link className="hover:text-foreground" href={workspaceRunsPath(workspaceSlug)}>
            ← Runs
          </Link>
        }
        eyebrowAsPlain
        title={run.sessionTitle}
      />

      <div className="space-y-8">
        <section aria-label="Run details" className="ui-sheet px-4 py-5 sm:px-5">
          <MetadataList>
            <MetadataItem
              label="Source session"
              value={
                <Link
                  className="break-words text-foreground underline underline-offset-4"
                  href={run.sessionRunHref}
                  prefetch={false}
                >
                  #{run.sessionNumber} · {run.sessionTitle}
                </Link>
              }
            />
            {!recorded && (
              <MetadataItem
                label="Agent"
                value={`${RUN_PROVIDER_LABELS[run.modelProvider] ?? run.modelProvider} · ${run.modelName}`}
              />
            )}
            {credential && recorded?.authority.kind !== "service" && (
              <RunCredentialFields credential={credential} initialNow={initialNow} />
            )}
            <MetadataItem
              label="Created"
              value={<TimeDisplay initialNow={initialNow} value={run.createdAt} />}
            />
            <MetadataItem
              label="Started"
              value={
                run.startedAt ? (
                  <TimeDisplay initialNow={initialNow} value={run.startedAt} />
                ) : (
                  "Not started"
                )
              }
            />
            <MetadataItem
              label="Finished"
              value={
                run.finishedAt ? (
                  <TimeDisplay initialNow={initialNow} value={run.finishedAt} />
                ) : active || run.status === "queued" ? (
                  "Not finished"
                ) : (
                  "Not recorded"
                )
              }
            />
            <MetadataItem
              label="Duration"
              value={
                run.startedAt && (active || run.finishedAt) ? (
                  <TimeDisplay
                    active={active}
                    endValue={run.finishedAt}
                    initialNow={initialNow}
                    value={run.startedAt}
                    variant="elapsed"
                  />
                ) : (
                  "Unavailable"
                )
              }
            />
            <MetadataItem label="Tokens" value={tokenLabel(run)} />
            <MetadataItem
              label="Cost"
              value={`${runCatalogCostLabel(run)}${run.usage.finalized ? "" : " · Not final"}`}
            />
            <MetadataItem
              className="sm:col-span-2"
              label="Run ID"
              monospace
              value={<span className="[overflow-wrap:anywhere]">{run.id}</span>}
            />
          </MetadataList>
        </section>

        {executionProfile && (
          <PageSection
            anchorId="execution-profile"
            title={recorded ? "Recorded execution profile" : "Execution profile"}
          >
            <div className="ui-sheet px-4 py-5 sm:px-5">
              {recorded ? (
                <MetadataList>
                  <ExecutionProfileFields profile={recorded} />
                  <MetadataItem
                    label="Worker runtime"
                    value={recorded.workerRuntime === "node" ? "Node.js" : "Workerd"}
                  />
                  <MetadataItem
                    label="Sandbox connection revision"
                    value={
                      recorded.sandboxConnectionRevision ? (
                        <span className="break-all">{recorded.sandboxConnectionRevision}</span>
                      ) : (
                        "Unrecorded"
                      )
                    }
                  />
                  <MetadataItem
                    label="Factory definition revision"
                    value={
                      recorded.definitionRevisionId ? (
                        <span className="break-all">{recorded.definitionRevisionId}</span>
                      ) : (
                        "Legacy configuration"
                      )
                    }
                  />
                  {recorded.authority.kind === "human" ? (
                    <MetadataItem
                      label="Credential owner"
                      value={
                        <span className="break-all">Member · {recorded.authority.memberId}</span>
                      }
                    />
                  ) : recorded.authority.kind === "service" ? (
                    <>
                      <MetadataItem
                        label="Execution grant"
                        value={
                          <span className="break-all">
                            {recorded.authority.grantId} · v{recorded.authority.grantVersion}
                          </span>
                        }
                      />
                      {credential ? (
                        <RunCredentialFields credential={credential} initialNow={initialNow} />
                      ) : (
                        <>
                          <MetadataItem
                            label="Credential owner"
                            value={
                              <span className="break-all">
                                Service principal · {recorded.authority.servicePrincipalId}
                              </span>
                            }
                          />
                          <MetadataItem
                            label="Service credential binding"
                            value={
                              <span className="break-all">{recorded.authority.bindingId}</span>
                            }
                          />
                        </>
                      )}
                    </>
                  ) : (
                    <MetadataItem label="Credential authority" value="Unrecorded" />
                  )}
                </MetadataList>
              ) : (
                <p className="type-secondary text-muted">
                  {executionProfile.kind === "unavailable"
                    ? "Recorded execution profile unavailable."
                    : "This attempt has no recorded execution profile."}
                </p>
              )}
            </div>
          </PageSection>
        )}

        <PageSection title="Outcome">
          <div className="ui-sheet divide-y divide-border">
            <div className="grid gap-4 px-4 py-5 sm:grid-cols-2 sm:gap-8 sm:px-5">
              <div className="min-w-0">
                <h3 className="type-label font-semibold text-foreground">
                  {run.status === "error" || run.status === "canceled" ? "Stop cause" : "Run state"}
                </h3>
                <p className="mt-2 text-sm leading-6 text-muted">{stopCause(run)}</p>
              </div>
              <div className="min-w-0">
                <h3 className="type-label font-semibold text-foreground">{recovery.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted">{recovery.description}</p>
                {recovery.scheduledAt ? (
                  <p className="mt-2 text-xs text-muted">
                    Scheduled for{" "}
                    <TimeDisplay initialNow={initialNow} value={recovery.scheduledAt} />
                  </p>
                ) : null}
                <Link className="ui-button mt-4" href={run.sessionRunHref} prefetch={false}>
                  {recovery.action}
                </Link>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-5">
              <div>
                <h3 className="type-label font-semibold text-foreground">Accepted artifact</h3>
                <p className="mt-2 text-sm text-muted">
                  {artifact.kind === "available"
                    ? `${artifact.stageSlug} · Version ${artifact.version}`
                    : artifact.kind === "none"
                      ? "This attempt has no accepted artifact."
                      : artifact.kind === "unrecorded"
                        ? "An exact artifact link was not recorded for this run."
                        : "Artifact details could not be loaded."}
                </p>
              </div>
              {artifact.kind === "available" ? (
                <Link className="ui-button" href={artifact.href} prefetch={false}>
                  Open artifact
                </Link>
              ) : null}
            </div>
          </div>
        </PageSection>

        <RunSkillRevisions skills={skills} />

        {mcp && (
          <PageSection
            title={mcp.kind === "planned" ? "Planned MCP manifest" : "Pinned MCP manifest"}
          >
            <ul className="divide-y divide-border rounded-md border border-border">
              {mcp.manifest.servers.map((server) => (
                <li key={server.serverId} className="space-y-2 p-4">
                  <p className="font-medium">
                    {server.serverSlug} · Revision {server.revisionNumber}
                  </p>
                  <MetadataList>
                    <MetadataItem
                      label="Approved operations"
                      value={server.operations.join(", ")}
                    />
                    <MetadataItem
                      label="Endpoint"
                      value={<span className="break-all">{server.endpoint}</span>}
                    />
                    {server.auth.kind === "bearer" && (
                      <MetadataItem
                        label="Credential binding"
                        value={<span className="break-all">{server.auth.secretBindingId}</span>}
                      />
                    )}
                  </MetadataList>
                </li>
              ))}
            </ul>
          </PageSection>
        )}

        <ArtifactEvidenceInspector
          source={{
            kind: "run",
            workspaceId,
            runId: run.id,
            artifactId: artifact.kind === "available" ? artifact.id : null,
          }}
        />

        {transcript}
      </div>
    </PageContainer>
  );
}

function RunCredentialFields({
  credential,
  initialNow,
}: {
  credential: RunInspectorCredential;
  initialNow: string;
}) {
  return (
    <>
      <MetadataItem
        label="Service credential binding"
        value={
          <span className="break-all">
            {credential.bindingId} · v{credential.bindingVersion}
          </span>
        }
      />
      <MetadataItem
        label="Credential owner"
        value={<span className="break-all">{credential.servicePrincipalId}</span>}
      />
      <MetadataItem label="Secret revision" value={credential.materialRevision} />
      <MetadataItem
        label="Credential resolved"
        value={<TimeDisplay initialNow={initialNow} value={credential.resolvedAt} />}
      />
    </>
  );
}

const skillSourceLabels = {
  wallie_builtin: "Wallie built-in",
  manual: "Factory-authored",
  repository: "Repository",
};

function RunSkillRevisions({ skills }: { skills: RunInspectorSkills }) {
  if (skills.kind === "unrecorded") return null;
  if (skills.kind === "unavailable") {
    return (
      <PageSection title="Skill revisions">
        <p className="ui-sheet px-4 py-5 text-sm text-muted sm:px-5">
          Skill revision details could not be loaded.
        </p>
      </PageSection>
    );
  }
  if (!skills.revisions.length) return null;

  return (
    <PageSection title="Skill revisions" tagline="Revisions included in this attempt’s prompt.">
      <ul className="ui-sheet divide-y divide-border">
        {skills.revisions.map((revision) => (
          <li key={revision.revisionId} className="min-w-0 space-y-3 px-4 py-5 sm:px-5">
            <div className="space-y-1">
              <h3 className="break-words text-sm font-semibold text-foreground">{revision.name}</h3>
              <p className="type-annotation text-muted">
                Revision {revision.version} · {skillSourceLabels[revision.sourceKind]}
              </p>
            </div>
            <MetadataList>
              <MetadataItem
                label="Revision ID"
                monospace
                value={<span className="[overflow-wrap:anywhere]">{revision.revisionId}</span>}
              />
              <MetadataItem
                label="Content SHA-256"
                monospace
                value={<span className="[overflow-wrap:anywhere]">{revision.contentSha256}</span>}
              />
            </MetadataList>
          </li>
        ))}
      </ul>
    </PageSection>
  );
}

function tokenLabel(run: WorkspaceRunCatalogItem) {
  const { inputTokens, outputTokens, tokenProvenance, finalized } = run.usage;
  if (inputTokens === null || outputTokens === null || tokenProvenance === "unavailable")
    return "Unavailable";
  return `${inputTokens.toLocaleString("en-US")} in · ${outputTokens.toLocaleString("en-US")} out · ${tokenProvenance}${finalized ? "" : " · Not final"}`;
}

function stopCause(run: WorkspaceRunCatalogItem) {
  switch (run.status) {
    case "canceled":
      return "This attempt was canceled.";
    case "error":
      return run.failure?.cause ?? "This attempt stopped without a recorded cause.";
    case "success":
      return "This attempt completed successfully.";
    case "queued":
      return "This attempt is waiting to start.";
    case "started":
      return "This attempt is starting.";
    case "running":
      return "This attempt is running.";
  }
}

function recoveryAction(run: WorkspaceRunCatalogItem): {
  title: string;
  description: string;
  action: string;
  scheduledAt: string | null;
} {
  const common = { action: "Open session", scheduledAt: null };
  const recovery = run.recovery;
  if (recovery?.sourceRecoveryRequired)
    return {
      ...common,
      title: "Source recovery needed",
      description:
        "The session needs source recovery before it can continue. Review its recovery options.",
    };
  const publication = recovery?.publication;
  if (publication?.status === "pending" || publication?.status === "claimed")
    return {
      ...common,
      title: publication.deadlineExpired
        ? "Publication recovery expired"
        : "Publishing saved output",
      description: publication.deadlineExpired
        ? "The saved output could not be accepted before its recovery deadline. Review the session before retrying."
        : "Wallie is recovering publication of this attempt’s saved output. Its artifact will appear once publication is accepted.",
    };
  if (recovery?.queue.state === "retry_scheduled")
    return {
      ...common,
      title: "Retry scheduled",
      description: "A retry is queued. This failed attempt keeps its own outcome and transcript.",
      scheduledAt: recovery.queue.scheduledAt,
    };
  if (recovery?.queue.state === "superseded")
    return {
      ...common,
      title: "A newer attempt exists",
      description:
        "Open the session to follow the newer attempt. The activity here belongs to the selected run.",
    };
  if (!recovery?.metadataAvailable)
    return {
      ...common,
      title: "Recovery details unavailable",
      description:
        "Current recovery details could not be loaded. Open the session to check its available actions.",
    };
  if ((run.status === "running" || run.status === "started") && recovery.activity.state === "stale")
    return {
      ...common,
      title: "No recent activity",
      description:
        "No activity has been saved recently. This alone does not confirm that the worker stopped. Check the session before taking action.",
    };
  if (run.status === "error" || run.status === "canceled")
    return {
      ...common,
      title: "Review before retrying",
      description:
        run.failure?.recovery ??
        "Review this attempt in the session and use its available recovery actions to continue.",
    };
  return {
    ...common,
    title: run.status === "success" ? "Continue in the session" : "Follow this run",
    description:
      run.status === "success"
        ? "Review the session’s current stage and available output."
        : "Open the source session to see its current controls and progress.",
  };
}

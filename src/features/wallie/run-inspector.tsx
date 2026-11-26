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
import { WorkflowInspectionDisclosure } from "@/features/factory-workflows/workflow-inspection-disclosure";
import { ArtifactEvidenceInspector } from "@/features/wallie/artifact-evidence-inspector";
import type { WorkspaceRunCatalogItem } from "@/features/wallie/run-catalog";
import type {
  RunInspectorArtifact,
  RunInspectorCredential,
  RunInspectorContext,
  RunInspectorExecutionProfile,
  RunInspectorMcpManifest,
  RunInspectorRoutingDecision,
  RunInspectorSkills,
} from "@/features/wallie/run-inspector-data";
import { RunRoutingDecisionInspection } from "@/features/wallie/run-inspector-routing";
import { RunContextInspection } from "@/features/wallie/run-context-inspection";
import { RUN_PROVIDER_LABELS, runCatalogCostLabel } from "@/features/wallie/runs-list-state";
import type { RunInspectorNames } from "@/features/wallie/run-inspector-names";
import { RunTechnicalDetails } from "@/features/wallie/run-technical-details";
import type { WorkflowInspectionHeader } from "@/lib/factory-workflows/inspection-contracts";
import { workspaceActivityPath, workspaceAgentDetailPath, workspaceRunsPath } from "@/lib/routes";

export function RunInspector({
  run,
  artifact,
  canOpenRoutingPolicy = false,
  credential,
  executionProfile,
  executionProfileAttempt,
  frozenContext,
  memoryProposalHref,
  mcp,
  routingDecision,
  skills,
  workspaceId,
  workspaceSlug,
  initialNow,
  benchmarkCapture,
  evaluations,
  transcript,
  workflowInspection,
  returnTo,
  newerRunHref,
  names,
}: {
  run: WorkspaceRunCatalogItem;
  artifact: RunInspectorArtifact;
  canOpenRoutingPolicy?: boolean;
  credential?: RunInspectorCredential | null;
  executionProfile?: RunInspectorExecutionProfile;
  executionProfileAttempt?: number;
  frozenContext?: RunInspectorContext;
  memoryProposalHref?: string | null;
  mcp?: RunInspectorMcpManifest | null;
  routingDecision?: RunInspectorRoutingDecision;
  skills: RunInspectorSkills;
  workspaceId: string;
  workspaceSlug: string;
  initialNow: string;
  benchmarkCapture?: ReactNode;
  evaluations?: ReactNode;
  transcript: ReactNode;
  workflowInspection?: WorkflowInspectionHeader;
  returnTo?: { href: string; label: string };
  newerRunHref?: string;
  names?: RunInspectorNames;
}) {
  const active = run.status === "started" || run.status === "running";
  const recovery = recoveryAction(run, newerRunHref);
  const recorded = executionProfile?.kind === "recorded" ? executionProfile.profile : null;
  const currentProfile =
    executionProfileAttempt === undefined || executionProfileAttempt === run.attemptCount;
  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        actions={
          <>
            <Status
              label={
                run.interrupted ? "Interrupted" : run.status === "started" ? "Starting" : undefined
              }
              value={agentRunStatusValue(run.status)}
            />
            {run.status === "error" || run.status === "canceled" ? (
              <Link className="ui-button" href="#run-outcome">
                View outcome
              </Link>
            ) : null}
            {benchmarkCapture}
          </>
        }
        actionsRightOnDesktop
        description={
          <>
            {run.stageName ?? "Session run"} ·{" "}
            {run.stageOrdinal === null ? (
              <TimeDisplay initialNow={initialNow} value={run.createdAt} />
            ) : (
              `Attempt ${run.stageOrdinal}`
            )}
          </>
        }
        eyebrow={
          <Link
            className="hover:text-foreground"
            href={returnTo?.href ?? workspaceRunsPath(workspaceSlug)}
          >
            ← {returnTo?.label ?? "Back to runs"}
          </Link>
        }
        eyebrowAsPlain
        title={run.sessionTitle}
      />

      <div className="space-y-8">
        <PageSection anchorId="run-outcome" title="Outcome">
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
                <Link
                  className="ui-button mt-4"
                  href={recovery.href ?? run.sessionRunHref}
                  prefetch={false}
                >
                  {recovery.action}
                </Link>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 px-4 py-3 sm:px-5">
              <Link className="ui-button" href="#run-transcript">
                View transcript
              </Link>
              <Link className="ui-button" href="#run-evidence">
                Inspect run evidence
              </Link>
              <p className="w-full text-xs text-muted">
                Find harness logs, reports, and other retained evidence.
              </p>
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

        <div id="run-transcript" className="scroll-mt-8" tabIndex={-1}>
          {transcript}
        </div>

        <div id="run-evidence" className="scroll-mt-8" tabIndex={-1}>
          <ArtifactEvidenceInspector
            source={{
              kind: "run",
              workspaceId,
              runId: run.id,
              sessionId: run.sessionId,
              artifactId: artifact.kind === "available" ? artifact.id : null,
            }}
          />
        </div>

        {workflowInspection ? (
          <WorkflowInspectionDisclosure
            key={run.id}
            header={workflowInspection}
            initialNow={initialNow}
            workspaceSlug={workspaceSlug}
          />
        ) : null}
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
            {routingDecision?.kind !== "recorded" || !run.startedAt ? (
              <MetadataItem
                label={run.startedAt ? "Ran with" : "Run configuration"}
                value={
                  currentProfile && recorded
                    ? `${RUN_PROVIDER_LABELS[recorded.provider]} · ${recorded.model}`
                    : `${RUN_PROVIDER_LABELS[run.modelProvider] ?? run.modelProvider} · ${run.modelName}`
                }
              />
            ) : null}
            {credential && (!currentProfile || recorded?.authority.kind !== "service") && (
              <RunCredentialFields
                credential={credential}
                initialNow={initialNow}
                principalName={names?.principals[credential.servicePrincipalId]}
              />
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
          </MetadataList>
          <RunTechnicalDetails
            entries={[
              ["Run ID", run.id],
              ["Job attempt", run.attemptCount],
              ["Service credential binding ID", credential?.bindingId],
              ["Service principal ID", credential?.servicePrincipalId],
            ]}
          />
        </section>

        {routingDecision ? (
          <RunRoutingDecisionInspection
            canOpenPolicy={canOpenRoutingPolicy}
            names={names}
            result={routingDecision}
            execution={
              run.startedAt
                ? {
                    name: run.modelName,
                    provider: RUN_PROVIDER_LABELS[run.modelProvider] ?? run.modelProvider,
                  }
                : undefined
            }
            workspaceSlug={workspaceSlug}
          />
        ) : null}

        {frozenContext && (
          <RunContextInspection
            result={frozenContext}
            workspaceSlug={workspaceSlug}
            initialNow={initialNow}
            memoryProposalHref={memoryProposalHref}
          />
        )}

        {executionProfile && (
          <PageSection
            anchorId="execution-profile"
            title={recorded ? "Recorded execution profile" : "Execution profile"}
          >
            <div className="ui-sheet space-y-2 px-4 py-5 sm:px-5">
              {executionProfileAttempt !== undefined ? (
                <p className="type-secondary text-muted">
                  Recorded job attempt {executionProfileAttempt}
                </p>
              ) : null}
              {recorded ? (
                <>
                  <p className="mb-3 text-xs text-muted">
                    Agent and member names reflect current records. The IDs and revision below are
                    from this attempt.
                  </p>
                  <MetadataList>
                    <ExecutionProfileFields profile={recorded} />
                    <MetadataItem
                      label="Worker runtime"
                      value={recorded.workerRuntime === "node" ? "Node.js" : "Workerd"}
                    />
                    {!recorded.definitionRevisionId ? (
                      <MetadataItem label="Factory definition" value="Legacy configuration" />
                    ) : null}
                    <MetadataItem
                      label="Implementation agent"
                      value={
                        recorded.agentId
                          ? (names?.agents[recorded.agentId] ?? "Recorded agent unavailable")
                          : "Unrecorded"
                      }
                    />
                    <MetadataItem
                      label="Agent prompt revision"
                      value={
                        recorded.agentId &&
                        recorded.promptRevisionId &&
                        names?.promptRevisionNumber ? (
                          <Link
                            className="text-foreground underline underline-offset-4"
                            href={workspaceAgentDetailPath(workspaceSlug, recorded.agentId, {
                              factory: recorded.factoryId,
                              revision: recorded.promptRevisionId,
                            })}
                            prefetch={false}
                          >
                            Open prompt revision {names.promptRevisionNumber}
                          </Link>
                        ) : recorded.promptRevisionId ? (
                          "Recorded revision unavailable"
                        ) : (
                          "Unrecorded"
                        )
                      }
                    />
                    <MetadataItem
                      label="Invoking member"
                      value={
                        recorded.invokingMemberId ? (
                          <RecordedRunActor
                            member={names?.members[recorded.invokingMemberId]}
                            action="View invoking member activity"
                            workspaceSlug={workspaceSlug}
                            factoryId={recorded.factoryId}
                            memberId={recorded.invokingMemberId}
                          />
                        ) : (
                          "Unrecorded"
                        )
                      }
                    />
                    {recorded.triggeredByMemberId &&
                      recorded.triggeredByMemberId !== recorded.invokingMemberId && (
                        <MetadataItem
                          label="Triggered by"
                          value={
                            <RecordedRunActor
                              member={names?.members[recorded.triggeredByMemberId]}
                              action="View triggering member activity"
                              workspaceSlug={workspaceSlug}
                              factoryId={recorded.factoryId}
                              memberId={recorded.triggeredByMemberId}
                            />
                          }
                        />
                      )}
                    {recorded.authority.kind === "human" ? (
                      <MetadataItem
                        label="Credential owner"
                        value={
                          names?.members[recorded.authority.memberId]?.label ??
                          "Member details unavailable"
                        }
                      />
                    ) : recorded.authority.kind === "service" ? (
                      <>
                        <MetadataItem
                          label="Execution grant"
                          value={`Service execution grant · Version ${recorded.authority.grantVersion}`}
                        />
                        {credential && currentProfile ? (
                          <RunCredentialFields
                            credential={credential}
                            initialNow={initialNow}
                            principalName={names?.principals[credential.servicePrincipalId]}
                          />
                        ) : (
                          <>
                            <MetadataItem
                              label="Credential owner"
                              value={
                                names?.principals[recorded.authority.servicePrincipalId] ??
                                "Service principal details unavailable"
                              }
                            />
                            <MetadataItem
                              label="Service credential binding"
                              value="Recorded service binding"
                            />
                          </>
                        )}
                      </>
                    ) : (
                      <MetadataItem label="Credential authority" value="Unrecorded" />
                    )}
                  </MetadataList>
                </>
              ) : (
                <p className="type-secondary text-muted">
                  {executionProfile.kind === "unavailable"
                    ? "Recorded execution profile unavailable."
                    : "This attempt has no recorded execution profile."}
                </p>
              )}
              {recorded ? (
                <RunTechnicalDetails
                  entries={[
                    ["Sandbox connection revision ID", recorded.sandboxConnectionRevision],
                    ["Factory definition revision ID", recorded.definitionRevisionId],
                    ["Implementation agent ID", recorded.agentId],
                    ["Agent prompt revision ID", recorded.promptRevisionId],
                    ["Invoking member ID", recorded.invokingMemberId],
                    ["Triggering member ID", recorded.triggeredByMemberId],
                    [
                      "Credential owner member ID",
                      recorded.authority.kind === "human" ? recorded.authority.memberId : null,
                    ],
                    [
                      "Execution grant ID",
                      recorded.authority.kind === "service" ? recorded.authority.grantId : null,
                    ],
                    [
                      "Service credential binding ID",
                      recorded.authority.kind === "service" ? recorded.authority.bindingId : null,
                    ],
                    [
                      "Service principal ID",
                      recorded.authority.kind === "service"
                        ? recorded.authority.servicePrincipalId
                        : null,
                    ],
                  ]}
                />
              ) : null}
            </div>
          </PageSection>
        )}

        {evaluations}

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
      </div>
    </PageContainer>
  );
}

function RecordedRunActor({
  workspaceSlug,
  factoryId,
  memberId,
  member,
  action,
}: {
  workspaceSlug: string;
  factoryId: string;
  memberId: string;
  member?: RunInspectorNames["members"][string];
  action: string;
}) {
  if (!member) return "Member details unavailable";
  if (!member.active) return member.label;
  return (
    <Link
      aria-label={`${action}: ${member.label}`}
      className="break-words text-foreground underline underline-offset-4"
      href={workspaceActivityPath(workspaceSlug, { factory: factoryId, actor: memberId })}
      prefetch={false}
    >
      {member.label}
    </Link>
  );
}

function RunCredentialFields({
  credential,
  initialNow,
  principalName,
}: {
  credential: RunInspectorCredential;
  initialNow: string;
  principalName?: string;
}) {
  return (
    <>
      <MetadataItem
        label="Service credential binding"
        value={`Recorded service binding · Version ${credential.bindingVersion}`}
      />
      <MetadataItem
        label="Credential owner"
        value={principalName ?? "Service principal details unavailable"}
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

function recoveryAction(
  run: WorkspaceRunCatalogItem,
  newerRunHref?: string,
): {
  title: string;
  description: string;
  action: string;
  scheduledAt: string | null;
  href?: string;
} {
  const common = { action: "Check recovery in session", scheduledAt: null };
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
  if (newerRunHref || recovery?.queue.state === "superseded")
    return {
      ...common,
      title: "A newer attempt exists",
      description: "The activity and outcome here still belong to the selected attempt.",
      action: newerRunHref ? "Inspect next attempt" : "Follow newer attempts in session",
      href: newerRunHref,
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
    action: "Open source session",
    title: run.status === "success" ? "Continue in the session" : "Follow this run",
    description:
      run.status === "success"
        ? "Review the session’s current stage and available output."
        : "Open the source session to see its current controls and progress.",
  };
}

import Link from "next/link";
import type { ReactNode } from "react";

import { ExecutionProfileFields } from "@/components/shared/execution-profile-fields";
import { TimeDisplay } from "@/components/shared/time-display";
import { BackLink } from "@/components/ui/back-link";
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
import { workspaceAgentDetailPath, workspaceRunsPath } from "@/lib/routes";

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
  const recovery = recoveryNotice(run, newerRunHref);
  const cause =
    run.status === "error"
      ? (run.failure?.cause ?? "This attempt stopped without a recorded cause.")
      : run.status === "canceled"
        ? "This attempt was canceled."
        : null;
  const showArtifact = artifact.kind !== "none" || run.status === "success";
  const cost = runCatalogCostLabel(run);
  const recorded = executionProfile?.kind === "recorded" ? executionProfile.profile : null;
  const currentProfile =
    executionProfileAttempt === undefined || executionProfileAttempt === run.attemptCount;
  const diagnosticRecords = [
    {
      id: "routing-decision",
      label: "Routing decision",
      kind: routingDecision?.kind,
    },
    {
      id: "frozen-inputs",
      label: "Frozen inputs",
      kind: frozenContext?.kind,
    },
    {
      id: "execution-profile",
      label:
        executionProfileAttempt === undefined
          ? "Execution profile"
          : `Execution profile (job attempt ${executionProfileAttempt})`,
      kind: executionProfile?.kind,
    },
    {
      id: "skill-revisions",
      label: "Skill revisions",
      kind: skills.kind,
    },
  ].filter(({ kind }) => kind === "unavailable" || kind === "unrecorded");
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
          <BackLink
            className="hover:text-foreground"
            href={returnTo?.href ?? workspaceRunsPath(workspaceSlug)}
          >
            {returnTo?.label ?? "Back to runs"}
          </BackLink>
        }
        eyebrowAsPlain
        title={run.sessionTitle}
      />

      <div className="space-y-6">
        <PageSection anchorId="run-outcome" title="Outcome">
          <div className="ui-sheet divide-y divide-border">
            {cause || recovery || showArtifact ? (
              <div className="grid gap-x-6 gap-y-4 px-4 py-4 sm:grid-cols-2 sm:px-5">
                {cause ? (
                  <div className="min-w-0">
                    <h3 className="type-label text-foreground">Stop cause</h3>
                    <p className="mt-1 text-sm text-muted">{cause}</p>
                  </div>
                ) : null}
                {recovery ? (
                  <div className="min-w-0">
                    <h3 className="type-label text-foreground">{recovery.title}</h3>
                    <p className="mt-1 text-sm text-muted">{recovery.description}</p>
                    {recovery.scheduledAt ? (
                      <p className="mt-1 text-xs text-muted">
                        Scheduled for{" "}
                        <TimeDisplay initialNow={initialNow} value={recovery.scheduledAt} />
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {showArtifact ? (
                  <div className="min-w-0">
                    <h3 className="type-label text-foreground">Accepted artifact</h3>
                    <p className="mt-1 text-sm text-muted [overflow-wrap:anywhere]">
                      {artifact.kind === "available" ? (
                        <Link
                          className="text-foreground underline underline-offset-4"
                          href={artifact.href}
                          prefetch={false}
                        >
                          {artifact.stageSlug} · Version {artifact.version}
                        </Link>
                      ) : artifact.kind === "none" ? (
                        "No artifact was accepted."
                      ) : artifact.kind === "unrecorded" ? (
                        "An exact artifact link was not recorded for this run."
                      ) : (
                        "Artifact details could not be loaded."
                      )}
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
              <Link
                className="ui-button min-h-11 sm:min-h-9"
                href={run.sessionRunHref}
                prefetch={false}
              >
                Open session #{run.sessionNumber}
              </Link>
              {recovery?.href ? (
                <Link
                  className="ui-button min-h-11 sm:min-h-9"
                  href={recovery.href}
                  prefetch={false}
                >
                  Next attempt
                </Link>
              ) : null}
              <a
                className="inline-flex min-h-11 items-center text-sm underline underline-offset-4 sm:min-h-9"
                href="#run-transcript"
              >
                Transcript
              </a>
              <a
                className="inline-flex min-h-11 items-center text-sm underline underline-offset-4 sm:min-h-9"
                href="#run-evidence"
              >
                Evidence
              </a>
            </div>
          </div>
        </PageSection>

        <div id="run-transcript" className="scroll-mt-8" tabIndex={-1}>
          {transcript}
        </div>

        <section
          aria-labelledby="run-evidence-heading"
          className="ui-sheet scroll-mt-8 space-y-3 px-4 py-4 sm:px-5"
          id="run-evidence"
          tabIndex={-1}
        >
          <h2 className="type-heading" id="run-evidence-heading">
            Evidence
          </h2>
          <ArtifactEvidenceInspector
            source={{
              kind: "run",
              workspaceId,
              runId: run.id,
              sessionId: run.sessionId,
              artifactId: artifact.kind === "available" ? artifact.id : null,
            }}
          />
        </section>

        {workflowInspection ? (
          <WorkflowInspectionDisclosure
            key={run.id}
            header={workflowInspection}
            initialNow={initialNow}
            workspaceSlug={workspaceSlug}
          />
        ) : null}
        <section
          aria-labelledby="run-details-heading"
          className="ui-sheet space-y-2 px-4 py-4 sm:px-5"
        >
          <h2 className="type-heading" id="run-details-heading">
            Run details
          </h2>
          <MetadataList>
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
            <MetadataItem label="Cost" value={cost ?? "Cost unavailable"} />
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

        {routingDecision?.kind === "recorded" ? (
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

        {frozenContext?.kind === "recorded" && (
          <RunContextInspection
            result={frozenContext}
            workspaceSlug={workspaceSlug}
            initialNow={initialNow}
            memoryProposalHref={memoryProposalHref}
          />
        )}

        {recorded && (
          <PageSection anchorId="execution-profile" title="Recorded execution profile">
            <div className="ui-sheet space-y-2 px-4 py-5 sm:px-5">
              {executionProfileAttempt !== undefined ? (
                <p className="type-secondary text-muted">
                  Recorded job attempt {executionProfileAttempt}
                </p>
              ) : null}
              <p className="mb-3 text-xs text-muted">
                Agent and member names reflect current records. The IDs and revision below are from
                this attempt.
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
                    recorded.agentId && recorded.promptRevisionId && names?.promptRevisionNumber ? (
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
                    recorded.invokingMemberId
                      ? (names?.members[recorded.invokingMemberId] ?? "Member details unavailable")
                      : "Unrecorded"
                  }
                />
                {recorded.triggeredByMemberId &&
                  recorded.triggeredByMemberId !== recorded.invokingMemberId && (
                    <MetadataItem
                      label="Triggered by"
                      value={
                        names?.members[recorded.triggeredByMemberId] ?? "Member details unavailable"
                      }
                    />
                  )}
                {recorded.authority.kind === "human" ? (
                  <MetadataItem
                    label="Credential owner"
                    value={
                      names?.members[recorded.authority.memberId] ?? "Member details unavailable"
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
            </div>
          </PageSection>
        )}

        {skills.kind === "recorded" && skills.revisions.length ? (
          <RunSkillRevisions revisions={skills.revisions} />
        ) : null}

        {mcp && mcp.manifest.servers.length > 0 && (
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
        {diagnosticRecords.length > 0 ? (
          <section
            aria-labelledby="run-records-heading"
            className="ui-sheet space-y-2 px-4 py-4 sm:px-5"
          >
            <h2 className="type-heading" id="run-records-heading">
              Diagnostic records
            </h2>
            <MetadataList className="gap-y-0">
              {diagnosticRecords.map(({ id, kind, label }) => (
                <MetadataItem
                  className="scroll-mt-8"
                  id={id}
                  key={id}
                  label={label}
                  value={kind === "unavailable" ? "Unavailable" : "Not recorded"}
                />
              ))}
            </MetadataList>
          </section>
        ) : null}
        {evaluations}
      </div>
    </PageContainer>
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

function RunSkillRevisions({
  revisions,
}: {
  revisions: Extract<RunInspectorSkills, { kind: "recorded" }>["revisions"];
}) {
  return (
    <PageSection title="Skill revisions" tagline="Revisions included in this attempt’s prompt.">
      <ul className="ui-sheet divide-y divide-border">
        {revisions.map((revision) => (
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

function recoveryNotice(
  run: WorkspaceRunCatalogItem,
  newerRunHref?: string,
): {
  title: string;
  description: string;
  scheduledAt?: string | null;
  href?: string;
} | null {
  const recovery = run.recovery;
  if (recovery?.sourceRecoveryRequired)
    return {
      title: "Source recovery needed",
      description:
        "The session needs source recovery before it can continue. Review its recovery options.",
    };
  const publication = recovery?.publication;
  if (publication?.status === "pending" || publication?.status === "claimed")
    return {
      title: publication.deadlineExpired
        ? "Publication recovery expired"
        : "Publishing saved output",
      description: publication.deadlineExpired
        ? "The saved output could not be accepted before its recovery deadline. Review the session before retrying."
        : "Wallie is recovering publication of this attempt’s saved output. Its artifact will appear once publication is accepted.",
    };
  if (recovery?.queue.state === "retry_scheduled")
    return {
      title: "Retry scheduled",
      description: "A retry is queued. This failed attempt keeps its own outcome and transcript.",
      scheduledAt: recovery.queue.scheduledAt,
    };
  if (newerRunHref || recovery?.queue.state === "superseded")
    return {
      title: "A newer attempt exists",
      description: "The activity and outcome here still belong to the selected attempt.",
      href: newerRunHref,
    };
  if (!recovery?.metadataAvailable)
    return {
      title: "Recovery details unavailable",
      description:
        "Current recovery details could not be loaded. Open the session to check its available actions.",
    };
  if (run.status === "running" || run.status === "started") {
    if (recovery.worker.state === "deadline_expired")
      return {
        title: "Worker deadline exceeded",
        description: "The recorded worker deadline has passed. Check the session before retrying.",
      };
    if (recovery.activity.state === "stale")
      return {
        title: "No recent activity",
        description:
          "No activity has been saved recently. This alone does not confirm that the worker stopped. Check the session before taking action.",
      };
  }
  if (run.status === "error" || run.status === "canceled")
    return {
      title: "Review before retrying",
      description:
        run.failure?.recovery ??
        "Review this attempt in the session and use its available recovery actions to continue.",
    };
  return null;
}

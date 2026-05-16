"use client";

import Link from "next/link";
import { useState } from "react";

import { AgentConfigSection } from "@/features/settings/agent-config-section";
import { CodexConnectionPanel } from "@/features/settings/codex-connection-panel";
import { GitHubInstallSection } from "@/features/settings/github-install-section";
import { shouldShowOnboardingResumeCta } from "@/features/onboarding/flow";
import { LinearRoutingEditor } from "@/features/settings/linear-routing-editor";
import { PipelineEditor } from "@/features/settings/pipeline-editor";
import { SandboxCapabilitySection } from "@/features/settings/sandbox-capability-section";
import {
  type SettingsAnchor,
  SettingsAnchorNav,
  SettingsAnchorNavMobile,
} from "@/features/settings/settings-anchor-nav";
import type { FlashMessage, SettingsPageClientProps } from "@/features/settings/settings-types";
import { Section, toneClass, UsageSummary } from "@/features/settings/settings-ui";
import { WorkspaceAvatarSection } from "@/features/settings/workspace-avatar-section";
import { WorkspaceSecretsSections } from "@/features/settings/workspace-secrets-sections";
import { workspaceOnboardingPath } from "@/lib/routes";

const ANCHORS: SettingsAnchor[] = [
  { id: "workspace", label: "Workspace" },
  { id: "github", label: "GitHub" },
  { id: "linear", label: "Linear" },
  { id: "secrets", label: "Secrets" },
  { id: "usage", label: "Usage" },
  { id: "rate-limits", label: "Rate limits" },
  { id: "pipeline", label: "Pipeline" },
  { id: "linear-routing", label: "Linear routing" },
  { id: "coding-agent", label: "Coding agent" },
  { id: "cloud-execution", label: "Cloud execution" },
  { id: "codex", label: "Codex account" },
];

function initialFlashMessage(searchState: SettingsPageClientProps["searchState"]) {
  switch (searchState.githubStatus) {
    case "connected":
      return {
        kind: "success",
        text: "GitHub App installation connected and repositories synced.",
      } satisfies FlashMessage;
    case "config_missing":
      return {
        kind: "error",
        text: "GitHub install completed, but Wallie is missing server config needed to finish the sync.",
      } satisfies FlashMessage;
    case "failed":
      return {
        kind: "error",
        text: "GitHub installation callback failed. Try the install flow again after checking server config.",
      } satisfies FlashMessage;
    case "invalid_state":
      return {
        kind: "error",
        text: "GitHub installation state expired or could not be verified. Start the install flow again from settings.",
      } satisfies FlashMessage;
    default:
      return null;
  }
}

export function SettingsPageClient({ initialData, searchState }: SettingsPageClientProps) {
  const [flashMessage, setFlashMessage] = useState<FlashMessage | null>(
    initialFlashMessage(searchState),
  );
  const isManager = initialData.canManage;
  const showResumeSetup = shouldShowOnboardingResumeCta(initialData.onboarding);

  return (
    <div className="min-h-full">
      <div className="mx-auto max-w-[1080px] px-6 pb-24 pt-10 sm:px-8">
        <header className="mb-10 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-2">
            <h1 className="text-[28px] font-semibold tracking-tight text-foreground">Settings</h1>
            <p className="max-w-2xl text-[14px] leading-6 text-muted">
              Manage workspace identity, integrations, pipeline, and encrypted secrets.
            </p>
          </div>
          {showResumeSetup ? (
            <Link
              className="ui-button-primary shrink-0"
              href={workspaceOnboardingPath(initialData.workspace.slug)}
            >
              Resume setup
            </Link>
          ) : null}
        </header>

        {flashMessage ? (
          <div
            aria-live="polite"
            className={`mb-8 rounded-[10px] border px-4 py-3 text-sm ${toneClass(flashMessage.kind)}`}
            role="status"
          >
            {flashMessage.text}
          </div>
        ) : null}

        <SettingsAnchorNavMobile anchors={ANCHORS} />

        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[180px_minmax(0,1fr)]">
          <SettingsAnchorNav anchors={ANCHORS} />

          <div className="space-y-16 min-w-0">
            <WorkspaceAvatarSection
              canManage={isManager}
              setFlashMessage={setFlashMessage}
              workspace={initialData.workspace}
            />
            <GitHubInstallSection
              canManage={isManager}
              github={initialData.github}
              setFlashMessage={setFlashMessage}
              workspaceId={initialData.workspace.id}
            />
            <WorkspaceSecretsSections
              canManage={isManager}
              setFlashMessage={setFlashMessage}
              workspaceId={initialData.workspace.id}
            />

            <Section
              anchorId="usage"
              tagline="Aggregate token usage and costs across all agent runs in this workspace."
              title="Usage"
            >
              <UsageSummary usage={initialData.usage} />
            </Section>

            <Section
              anchorId="rate-limits"
              tagline="Per-endpoint caps protecting sandbox spawns and paid LLM calls. Excess requests return 429 with a Retry-After header."
              title="Rate limits"
            >
              <ul className="divide-y divide-border rounded-[10px] border border-border bg-surface">
                {initialData.rateLimits.map((limit) => (
                  <li
                    key={limit.endpoint}
                    className="flex flex-col gap-1.5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="space-y-1">
                      <code className="font-mono text-[12px] text-foreground">
                        {limit.endpoint}
                      </code>
                      <p className="text-[12px] leading-5 text-muted">{limit.description}</p>
                    </div>
                    <span className="ui-pill shrink-0">
                      {limit.max} req / {Math.round(limit.windowMs / 1000)}s
                    </span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section
              anchorId="pipeline"
              tagline="Stages run in order; each stage's prompt is sent to the agent, and an approver reviews the markdown output before the session advances."
              title="Pipeline"
            >
              <PipelineEditor
                canManage={isManager}
                pipeline={initialData.pipeline}
                workspaceId={initialData.workspace.id}
                workspaceMembers={initialData.workspaceMembers}
              />
            </Section>

            <Section
              anchorId="linear-routing"
              tagline="Map Linear workflow states to pipeline stages so Wallie syncs status correctly."
              title="Linear routing"
            >
              <LinearRoutingEditor
                canManage={isManager}
                routing={initialData.linearRouting}
                setFlashMessage={setFlashMessage}
                stages={initialData.pipeline?.stages ?? []}
                workspaceId={initialData.workspace.id}
              />
            </Section>

            <AgentConfigSection
              canManage={isManager}
              initialAgentConfig={initialData.agentConfig}
              setFlashMessage={setFlashMessage}
              workspaceId={initialData.workspace.id}
            />

            <Section
              anchorId="cloud-execution"
              tagline="Verify that Wallie can spawn sandboxes for a repository and execute jobs end-to-end."
              title="Cloud execution"
            >
              <SandboxCapabilitySection
                canManage={isManager}
                initialCheck={initialData.latestSandboxCapabilityCheck}
                repositories={initialData.github.repositories}
                setFlashMessage={setFlashMessage}
                workspaceId={initialData.workspace.id}
              />
            </Section>

            <Section
              anchorId="codex"
              tagline="Sessions you create use the Codex tokens stored here. Tokens are encrypted at rest and only decrypted inside the agent worker."
              title="Codex account"
            >
              <CodexConnectionPanel connectFlash={searchState.codexStatus} />
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

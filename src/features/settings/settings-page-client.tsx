"use client";

import { useState } from "react";

import { AgentConfigSection } from "@/features/settings/agent-config-section";
import { CodexConnectionPanel } from "@/features/settings/codex-connection-panel";
import { GitHubInstallSection } from "@/features/settings/github-install-section";
import { LinearRoutingEditor } from "@/features/settings/linear-routing-editor";
import { PipelineEditor } from "@/features/settings/pipeline-editor";
import { SandboxCapabilitySection } from "@/features/settings/sandbox-capability-section";
import type { FlashMessage, SettingsPageClientProps } from "@/features/settings/settings-types";
import { Section, toneClass, UsageSummary } from "@/features/settings/settings-ui";
import { WorkspaceAvatarSection } from "@/features/settings/workspace-avatar-section";
import { WorkspaceSecretsSections } from "@/features/settings/workspace-secrets-sections";

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

  return (
    <div className="min-h-full bg-[#f6f5f2] px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-3 rounded-[24px] bg-surface px-6 py-6 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_14px_32px_rgba(16,24,40,0.06)] sm:px-8 sm:py-8">
          <p className="ui-label">Workspace Admin</p>
          <h1 className="text-3xl font-semibold tracking-tight text-balance text-foreground">
            Settings
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-muted">
            Manage workspace identity, GitHub sync, and encrypted secrets from one route.
          </p>
        </header>

        {flashMessage ? (
          <div
            aria-live="polite"
            className={`rounded-[14px] border px-4 py-3 text-sm shadow-[0_1px_2px_rgba(16,24,40,0.04)] ${toneClass(flashMessage.kind)}`}
            role="status"
          >
            {flashMessage.text}
          </div>
        ) : null}

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

        <Section title="Usage">
          <UsageSummary usage={initialData.usage} />
        </Section>

        <Section title="Rate limits">
          <div className="space-y-3">
            <p className="text-sm leading-7 text-muted">
              Per-endpoint caps protecting sandbox spawns and paid LLM calls. Excess requests return{" "}
              <code>429 Too Many Requests</code> with a <code>Retry-After</code> header. Contact an
              administrator to raise these limits for a trusted workspace.
            </p>
            <ul className="ui-subpanel divide-y divide-border-soft text-sm">
              {initialData.rateLimits.map((limit) => (
                <li key={limit.endpoint} className="flex flex-col gap-1 px-4 py-3">
                  <span className="font-mono text-xs text-muted">{limit.endpoint}</span>
                  <span className="font-semibold text-foreground">
                    {limit.max} req / {Math.round(limit.windowMs / 1000)}s
                  </span>
                  <span className="text-xs text-muted">{limit.description}</span>
                </li>
              ))}
            </ul>
          </div>
        </Section>

        <Section title="Pipeline">
          <div className="space-y-4">
            <p className="text-sm leading-7 text-muted">
              Stages run in order; each stage&apos;s prompt is sent to the agent, and an approver
              reviews the markdown output before the session advances.
            </p>
            <PipelineEditor
              canManage={isManager}
              pipeline={initialData.pipeline}
              workspaceId={initialData.workspace.id}
              workspaceMembers={initialData.workspaceMembers}
            />
          </div>
        </Section>

        <Section title="Linear Routing">
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

        <Section title="Cloud Execution">
          <SandboxCapabilitySection
            canManage={isManager}
            initialCheck={initialData.latestSandboxCapabilityCheck}
            repositories={initialData.github.repositories}
            setFlashMessage={setFlashMessage}
            workspaceId={initialData.workspace.id}
          />
        </Section>

        <Section title="Your Codex account">
          <CodexConnectionPanel connectFlash={searchState.codexStatus} />
        </Section>
      </div>
    </div>
  );
}

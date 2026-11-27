import Link from "next/link";

import type { PersonalProviderContext } from "@/features/settings/data";
import { ProviderAccessPanel } from "@/features/settings/provider-access-panel";
import { Section } from "@/features/settings/settings-ui";
import { WorkspaceSettingsLoadError } from "@/features/settings/workspace-settings-load-error";
import { normalizeAgentProviderName, type AgentProvider } from "@/lib/agent-config/contracts";
import { workspaceSettingsPath } from "@/lib/routes";

const labels = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
} satisfies Record<AgentProvider, string>;

export async function PersonalProviderAccess({
  canManageWorkspace,
  codexStatus,
  context,
  requestedProvider,
  workspaceId,
  workspaceSlug,
}: {
  canManageWorkspace: boolean;
  codexStatus?: string;
  context: Promise<PersonalProviderContext>;
  requestedProvider?: string;
  workspaceId: string;
  workspaceSlug: string;
}) {
  const providerContext = await context.catch(() => null);
  const provider = codexStatus
    ? "codex"
    : (normalizeAgentProviderName(requestedProvider) ?? providerContext?.provider ?? "codex");
  const providerHref = (selected: AgentProvider) =>
    `${workspaceSettingsPath(workspaceSlug, { category: "personal", provider: selected })}#provider-access`;
  return (
    <Section anchorId="provider-access" title="Provider access">
      <nav aria-label="Agent providers" className="mb-3 flex flex-wrap gap-2">
        {(Object.keys(labels) as AgentProvider[]).map((name) => (
          <Link
            aria-current={provider === name ? "page" : undefined}
            className="ui-button min-h-9 aria-[current=page]:bg-control-hover"
            href={providerHref(name)}
            key={name}
          >
            {labels[name]}
          </Link>
        ))}
      </nav>
      {!providerContext && provider === "codex" ? (
        <WorkspaceSettingsLoadError label="workspace sandbox status" />
      ) : null}
      <ProviderAccessPanel
        connectFlash={codexStatus}
        key={provider}
        provider={provider}
        returnTo={providerHref(provider)}
        sandboxConnectionHref={
          canManageWorkspace
            ? `${workspaceSettingsPath(workspaceSlug, { category: "integrations" })}#sandbox`
            : undefined
        }
        sandboxConnectionLabel={providerContext?.sandboxLabel}
        sandboxConnectionReady={providerContext?.sandboxReady}
        selectedModel={providerContext?.provider === provider ? providerContext.model : undefined}
        showHeading={false}
        workspaceId={workspaceId}
      />
    </Section>
  );
}

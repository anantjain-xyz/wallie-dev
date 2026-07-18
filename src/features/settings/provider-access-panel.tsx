"use client";

import {
  ClaudeCodeConnectionPanel,
  type ClaudeCodeConnectionStatus,
} from "@/features/settings/claude-code-connection-panel";
import {
  CodexConnectionPanel,
  type CodexConnectionStatus,
} from "@/features/settings/codex-connection-panel";
import type { AgentProvider } from "@/lib/agent-config/contracts";
import type { VercelSandboxConnectionPreview } from "@/lib/vercel-sandbox/contracts";

type ProviderAccessPanelProps = {
  connectFlash?: string | null;
  onClaudeCodeStatusChange?: (status: ClaudeCodeConnectionStatus) => void;
  onCodexStatusChange?: (status: CodexConnectionStatus) => void;
  provider: AgentProvider;
  returnTo?: string;
  variant?: "card" | "embedded";
  vercelConnectionHref?: string;
  vercelSandboxConnection?: VercelSandboxConnectionPreview | null;
  workspaceId?: string;
};

export function ProviderAccessPanel({
  connectFlash,
  onClaudeCodeStatusChange,
  onCodexStatusChange,
  provider,
  returnTo,
  variant = "card",
  vercelConnectionHref,
  vercelSandboxConnection,
  workspaceId,
}: ProviderAccessPanelProps) {
  const className =
    variant === "card"
      ? "rounded-[6px] border border-border bg-surface p-4"
      : "border-t border-border pt-4";

  switch (provider) {
    case "codex":
      return (
        <div className={className}>
          <div className="mb-3 min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Provider access</h3>
            <p className="mt-1 text-xs leading-5 text-muted">
              Sessions run with the Codex credential saved by the session creator.
            </p>
          </div>
          <CodexConnectionPanel
            connectFlash={connectFlash}
            onStatusChange={onCodexStatusChange}
            returnTo={returnTo}
            vercelConnectionHref={vercelConnectionHref}
            vercelSandboxConnection={vercelSandboxConnection}
            workspaceId={workspaceId}
          />
        </div>
      );
    case "claude-code":
      return (
        <div className={className}>
          <div className="mb-3 min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Provider access</h3>
            <p className="mt-1 text-[13px] leading-5 text-muted">
              Sessions run with the Anthropic API key saved by the session creator.
            </p>
          </div>
          <ClaudeCodeConnectionPanel onStatusChange={onClaudeCodeStatusChange} />
        </div>
      );
  }
}

"use client";

import dynamic from "next/dynamic";

import type { ClaudeCodeConnectionStatus } from "@/features/settings/claude-code-connection-panel";
import type { CodexConnectionStatus } from "@/features/settings/codex-connection-panel";
import type { CursorConnectionStatus } from "@/features/settings/cursor-connection-panel";
import type { OpenCodeConnectionStatus } from "@/features/settings/opencode-connection-panel";
import type { AgentProvider } from "@/lib/agent-config/contracts";
import type { VercelSandboxConnectionPreview } from "@/lib/vercel-sandbox/contracts";

type ProviderAccessPanelProps = {
  connectFlash?: string | null;
  initialClaudeCodeStatus?: ClaudeCodeConnectionStatus;
  initialCodexStatus?: CodexConnectionStatus;
  initialCursorStatus?: CursorConnectionStatus;
  initialOpenCodeStatus?: OpenCodeConnectionStatus;
  onClaudeCodeStatusChange?: (status: ClaudeCodeConnectionStatus) => void;
  onCodexStatusChange?: (status: CodexConnectionStatus) => void;
  onCursorStatusChange?: (status: CursorConnectionStatus) => void;
  onOpenCodeStatusChange?: (status: OpenCodeConnectionStatus) => void;
  onSandboxConnectionSelect?: () => void;
  provider: AgentProvider;
  returnTo?: string;
  sandboxConnectionHref?: string;
  sandboxConnectionLabel?: string;
  sandboxConnectionReady?: boolean;
  variant?: "card" | "embedded";
  vercelConnectionHref?: string;
  vercelSandboxConnection?: VercelSandboxConnectionPreview | null;
  workspaceId?: string;
};

const CodexConnectionPanel = dynamic(
  () =>
    import("@/features/settings/codex-connection-panel").then(
      (module) => module.CodexConnectionPanel,
    ),
  { loading: () => <p className="text-xs text-muted">Checking connection</p>, ssr: false },
);

const ClaudeCodeConnectionPanel = dynamic(
  () =>
    import("@/features/settings/claude-code-connection-panel").then(
      (module) => module.ClaudeCodeConnectionPanel,
    ),
  {
    loading: () => <p className="text-xs text-muted">Checking connection</p>,
    ssr: false,
  },
);
const CursorConnectionPanel = dynamic(
  () =>
    import("@/features/settings/cursor-connection-panel").then(
      (module) => module.CursorConnectionPanel,
    ),
  { loading: () => <p className="text-xs text-muted">Checking connection</p>, ssr: false },
);
const OpenCodeConnectionPanel = dynamic(
  () =>
    import("@/features/settings/opencode-connection-panel").then(
      (module) => module.OpenCodeConnectionPanel,
    ),
  { loading: () => <p className="text-xs text-muted">Checking connection</p>, ssr: false },
);

export function ProviderAccessPanel({
  connectFlash,
  initialClaudeCodeStatus,
  initialCodexStatus,
  initialCursorStatus,
  initialOpenCodeStatus,
  onClaudeCodeStatusChange,
  onCodexStatusChange,
  onCursorStatusChange,
  onOpenCodeStatusChange,
  onSandboxConnectionSelect,
  provider,
  returnTo,
  sandboxConnectionHref,
  sandboxConnectionLabel,
  sandboxConnectionReady,
  variant = "card",
  vercelConnectionHref,
  vercelSandboxConnection,
  workspaceId,
}: ProviderAccessPanelProps) {
  const className =
    variant === "card"
      ? "rounded-[6px] border border-border bg-sheet p-4"
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
            initialStatus={initialCodexStatus}
            onSandboxConnectionSelect={onSandboxConnectionSelect}
            onStatusChange={onCodexStatusChange}
            returnTo={returnTo}
            sandboxConnectionHref={sandboxConnectionHref}
            sandboxConnectionLabel={sandboxConnectionLabel}
            sandboxConnectionReady={sandboxConnectionReady}
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
          <ClaudeCodeConnectionPanel
            initialStatus={initialClaudeCodeStatus}
            onStatusChange={onClaudeCodeStatusChange}
          />
        </div>
      );
    case "cursor":
      return (
        <div className={className}>
          <div className="mb-3 min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Provider access</h3>
            <p className="mt-1 text-xs leading-5 text-muted">
              Sessions use the connected user&apos;s Cursor plan through an expiring user API key.
            </p>
          </div>
          <CursorConnectionPanel
            initialStatus={initialCursorStatus}
            onStatusChange={onCursorStatusChange}
            workspaceId={workspaceId}
          />
        </div>
      );
    case "opencode":
      return (
        <div className={className}>
          <div className="mb-3 min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Provider access</h3>
            <p className="mt-1 text-xs leading-5 text-muted">
              Sessions run with the OpenCode API key saved by the session creator. Zen models use
              the OpenCode Zen key; custom provider ids need a matching provider key.
            </p>
          </div>
          <OpenCodeConnectionPanel
            initialStatus={initialOpenCodeStatus}
            onStatusChange={onOpenCodeStatusChange}
          />
        </div>
      );
  }
}

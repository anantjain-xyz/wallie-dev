"use client";

import { CodexConnectionPanel } from "@/features/settings/codex-connection-panel";
import type { AgentProvider } from "@/lib/agent-config/contracts";

type ProviderAccessPanelProps = {
  connectFlash?: string | null;
  provider: AgentProvider;
  returnTo?: string;
  variant?: "card" | "embedded";
};

export function ProviderAccessPanel({
  connectFlash,
  provider,
  returnTo,
  variant = "card",
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
            <p className="mt-1 text-[12px] leading-5 text-muted">
              Sessions run with the Codex credential saved by the session creator.
            </p>
          </div>
          <CodexConnectionPanel connectFlash={connectFlash} returnTo={returnTo} />
        </div>
      );
    case "claude-code":
      return (
        <div className={className}>
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Provider access</h3>
            <p className="mt-1 text-[13px] leading-5 text-muted">
              Claude Code account connection is not managed in Wallie yet. Wallie validates the
              sandboxed Claude Code CLI when pipeline runs execute.
            </p>
          </div>
        </div>
      );
  }
}

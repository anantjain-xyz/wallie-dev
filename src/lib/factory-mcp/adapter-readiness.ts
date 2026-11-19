import type { AgentProvider } from "@/lib/agent-config/contracts";

/** Scope availability for a nonempty approved MCP manifest. */
export function unavailableMcpAdapterReason(provider: AgentProvider): string | undefined {
  return provider === "cursor"
    ? "Cursor MCP is unavailable because Wallie cannot isolate team marketplace tools in the Cursor CLI. Choose a supported agent or remove the MCP bindings."
    : undefined;
}

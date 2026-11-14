import type { AgentEvent, AgentEventToolResult, AgentEventToolUse } from "./types";

type ObservedTool = {
  tool?: string;
  finished: boolean;
};

/** Deduplicates provider snapshots and tracks the calls whose result was never observed. */
export class ToolEventTracker {
  private readonly observed = new Map<string, ObservedTool>();

  start(call: AgentEventToolUse): AgentEvent[] {
    if (!call.callId) return [call];
    const previous = this.observed.get(call.callId);
    if (previous?.tool) return [];
    this.observed.set(call.callId, { tool: call.tool, finished: previous?.finished ?? false });
    return [call];
  }

  finish(result: AgentEventToolResult): AgentEvent[] {
    const previous = result.callId ? this.observed.get(result.callId) : undefined;
    if (previous?.finished) return [];
    if (result.callId) {
      this.observed.set(result.callId, { tool: previous?.tool, finished: true });
    }
    if (previous?.tool) return [{ ...result, tool: previous.tool }];
    return [{ type: "capture_gap", reason: "missing_tool_call" }, result];
  }

  gaps(): AgentEvent[] {
    return Array.from(this.observed)
      .filter(([, { tool, finished }]) => tool && !finished)
      .map(([callId]) => ({ type: "capture_gap", reason: "missing_tool_result", callId }));
  }
}

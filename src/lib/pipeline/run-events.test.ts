import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { parseStreamJsonLine } from "@/lib/agent-runner/claude-code";
import { parseCodexStreamLine } from "@/lib/agent-runner/codex";
import { parseCursorStreamJsonLine } from "@/lib/agent-runner/cursor";
import { parseOpenCodeLine } from "@/lib/agent-runner/opencode";
import { ToolEventTracker } from "@/lib/agent-runner/tool-event-tracker";
import type { AgentEvent, AgentRunner } from "@/lib/agent-runner/types";
import type { Database } from "@/lib/supabase/database.types";

import { RunEventCapture } from "./run-events";

const runId = "21111111-1111-4111-8111-111111111111";
const path = `/tmp/wallie-memory-proposal-${runId}.md`;
const note = "PRIVATE-MEMORY-FIXTURE-CANARY";
const callId = "private-proposal-call";
const encode = JSON.stringify;

function capture(adapter: AgentRunner["provider"], enableProtection = true) {
  const recorded: Array<Record<string, unknown>> = [];
  const admin = createClient<Database>("https://supabase.example.test", "fixture", {
    global: {
      fetch: async (_url, request) => {
        recorded.push(JSON.parse(String(request?.body)));
        return Response.json(true);
      },
    },
  });
  const events = new RunEventCapture(admin, {
    jobId: "21111111-1111-4111-8111-111111111112",
    runId,
    attemptCount: 1,
  });
  if (enableProtection) events.protectPrivatePath(path);
  events.start(adapter);
  const tools = new ToolEventTracker();
  return {
    recorded,
    async record(eventsToRecord: AgentEvent[]) {
      for (const event of eventsToRecord) {
        const normalized =
          event.type === "tool_use"
            ? tools.start(event)
            : event.type === "tool_result"
              ? tools.finish(event)
              : [event];
        for (const item of normalized) await events.record(item);
      }
    },
  };
}

function claudeWrite() {
  return [
    ...parseStreamJsonLine(
      encode({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: callId,
              name: "Write",
              input: { file_path: path, content: note },
            },
          ],
        },
      }),
    ),
    ...parseStreamJsonLine(
      encode({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: callId, content: note }],
        },
      }),
    ),
  ];
}

function codexWrite() {
  return parseCodexStreamLine(
    encode({
      type: "item.completed",
      item: {
        type: "command_execution",
        id: callId,
        status: "completed",
        command: `printf '%s' '${note}' > '${path}'`,
        aggregated_output: note,
        exit_code: 0,
      },
    }),
  );
}

function cursorWrite() {
  return parseCursorStreamJsonLine(
    encode({
      type: "tool_call",
      subtype: "completed",
      call_id: callId,
      tool_call: {
        execToolCall: {
          args: { command: `printf '%s' '${note}' > '${path}'` },
          result: { success: { stdout: note, exitCode: 0 } },
        },
      },
    }),
  ).events;
}

function openCodeWrite() {
  return (
    parseOpenCodeLine(
      encode({
        type: "tool_use",
        part: {
          callID: callId,
          tool: "write",
          state: { status: "completed", input: { filePath: path, content: note }, output: note },
        },
      }),
    )?.events ?? []
  );
}

describe("private factory memory proposal tool activity", () => {
  it.each([
    ["claude-code", claudeWrite],
    ["codex", codexWrite],
    ["cursor", cursorWrite],
    ["opencode", openCodeWrite],
  ] as const)(
    "withholds the direct %s write and its correlated output before persistence",
    async (adapter, write) => {
      const { record, recorded } = capture(adapter);
      await record(write());
      const [call, result] = recorded;
      expect(recorded).toHaveLength(2);
      expect(call).toMatchObject({
        p_kind: "tool_call",
        p_payload: {
          tool: "Private memory proposal",
          input: "[Private memory proposal content withheld.]",
        },
      });
      expect(result).toMatchObject({
        p_kind: "tool_result",
        p_causation_sequence: call.p_sequence,
        p_payload: {
          tool: "Private memory proposal",
          output: "[Private memory proposal content withheld.]",
          status: "success",
        },
      });
      expect(encode(recorded)).not.toContain(note);
      expect(encode(recorded)).not.toContain(path);
    },
  );

  it("does not withhold normal matched tool activity while a proposal path is protected", async () => {
    const { record, recorded } = capture("claude-code");
    await record([
      { type: "tool_use", tool: "Bash", input: '{"command":"pnpm test"}', callId },
      {
        type: "tool_result",
        tool: "Bash",
        output: "All checks passed.",
        status: "success",
        callId,
      },
    ]);
    expect(recorded[0]).toMatchObject({
      p_payload: { tool: "Bash", input: '{"command":"pnpm test"}' },
    });
    expect(recorded[1]).toMatchObject({
      p_payload: { tool: "Bash", output: "All checks passed." },
    });
  });

  it("withholds output that arrives without attributable input only when protection is armed", async () => {
    const raw = encode({
      type: "tool_call",
      subtype: "completed",
      tool_call: { execToolCall: { result: { success: { stdout: note, exitCode: 0 } } } },
    });
    const unmatched = parseCursorStreamJsonLine(raw).events;
    const protectedCapture = capture("cursor");
    await protectedCapture.record(unmatched);
    expect(protectedCapture.recorded).toMatchObject([
      { p_kind: "capture_gap", p_payload: { reason: "missing_tool_call" } },
      { p_kind: "tool_result", p_payload: { output: "[Unmatched tool output withheld.]" } },
    ]);
    expect(encode(protectedCapture.recorded)).not.toContain(note);
    const normalCapture = capture("cursor", false);
    await normalCapture.record(unmatched);
    expect(encode(normalCapture.recorded)).toContain(note);
  });
});

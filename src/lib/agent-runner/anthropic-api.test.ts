import type { Message, RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages/messages";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnthropicApiRunner,
  type AnthropicClientLike,
  parseStreamEvent,
  resolveAnthropicModel,
} from "./anthropic-api";
import { DEFAULT_ANTHROPIC_MODEL } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
});

interface FakeStreamSpec {
  events: RawMessageStreamEvent[];
  finalMessage?: Message;
  streamThrows?: unknown;
  finalThrows?: unknown;
}

function fakeClient(spec: FakeStreamSpec): {
  client: AnthropicClientLike;
  calls: Array<{ model: string; max_tokens: number; messages: unknown }>;
} {
  const calls: Array<{ model: string; max_tokens: number; messages: unknown }> = [];
  const client: AnthropicClientLike = {
    messages: {
      stream(params) {
        calls.push(params);
        const events = spec.events;
        const streamThrows = spec.streamThrows;
        const finalThrows = spec.finalThrows;
        const finalMessage = spec.finalMessage;
        async function* iter() {
          if (streamThrows) throw streamThrows;
          for (const ev of events) yield ev;
        }
        const wrapper = iter();
        return Object.assign(wrapper, {
          finalMessage: async (): Promise<Message> => {
            if (finalThrows) throw finalThrows;
            if (!finalMessage) throw new Error("test: finalMessage not configured");
            return finalMessage;
          },
        });
      },
    },
  };
  return { client, calls };
}

const baseFinal = (overrides: Partial<Message> = {}): Message =>
  ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [],
    model: DEFAULT_ANTHROPIC_MODEL,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 12,
      output_tokens: 7,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
    ...overrides,
  }) as unknown as Message;

describe("AnthropicApiRunner", () => {
  it("has the correct provider name and does not require a sandbox", () => {
    const runner = new AnthropicApiRunner({
      apiKey: "k",
      client: fakeClient({ events: [] }).client,
    });
    expect(runner.provider).toBe("anthropic-api");
    expect(runner.requiresSandbox).toBe(false);
    expect(typeof runner.start).toBe("function");
  });

  it("throws when constructed without an apiKey", () => {
    expect(() => new AnthropicApiRunner({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("streams text deltas and yields a completion with usage", async () => {
    const { client, calls } = fakeClient({
      events: [
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: " world" },
        },
      ],
      finalMessage: baseFinal(),
    });

    const runner = new AnthropicApiRunner({ apiKey: "k", model: DEFAULT_ANTHROPIC_MODEL, client });

    const events = [];
    for await (const ev of runner.start({ sessionId: "s1", prompt: "Say hi" })) {
      events.push(ev);
    }

    expect(events).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
      {
        type: "completion",
        taskComplete: true,
        summary: "Anthropic API session completed (stop_reason: end_turn)",
        usage: { inputTokens: 12, outputTokens: 7 },
      },
    ]);

    expect(calls).toEqual([
      {
        model: DEFAULT_ANTHROPIC_MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: "Say hi" }],
      },
    ]);
  });

  it("emits an error event when the stream throws and stops iterating", async () => {
    const { client } = fakeClient({
      events: [],
      streamThrows: new Error("network down"),
    });
    const runner = new AnthropicApiRunner({ apiKey: "k", client });

    const events = [];
    for await (const ev of runner.start({ sessionId: "s", prompt: "p" })) {
      events.push(ev);
    }

    expect(events).toEqual([
      { type: "error", message: "Anthropic API stream failed: network down" },
    ]);
  });

  it("emits an error event when finalMessage throws", async () => {
    const { client } = fakeClient({
      events: [
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "partial" },
        },
      ],
      finalThrows: new Error("trailer parse failed"),
    });
    const runner = new AnthropicApiRunner({ apiKey: "k", client });

    const events = [];
    for await (const ev of runner.start({ sessionId: "s", prompt: "p" })) {
      events.push(ev);
    }

    expect(events.at(0)).toEqual({ type: "text", text: "partial" });
    expect(events.at(-1)).toEqual({
      type: "error",
      message: "Anthropic API finalMessage failed: trailer parse failed",
    });
  });

  it("marks completion as not done when stop_reason indicates token limit", async () => {
    const { client } = fakeClient({
      events: [],
      finalMessage: baseFinal({ stop_reason: "max_tokens" }),
    });
    const runner = new AnthropicApiRunner({ apiKey: "k", client });

    const events = [];
    for await (const ev of runner.start({ sessionId: "s", prompt: "p" })) {
      events.push(ev);
    }

    expect(events).toEqual([
      {
        type: "completion",
        taskComplete: false,
        summary: "Anthropic API session completed (stop_reason: max_tokens)",
        usage: { inputTokens: 12, outputTokens: 7 },
      },
    ]);
  });

  it("falls back to the default model when configured with a non-Anthropic model id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, calls } = fakeClient({ events: [], finalMessage: baseFinal() });
    const runner = new AnthropicApiRunner({ apiKey: "k", model: "gpt-5-codex", client });

    for await (const _ of runner.start({ sessionId: "s", prompt: "p" })) {
      void _;
    }

    expect(calls[0]?.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("forwards maxTokens override when supplied", async () => {
    const { client, calls } = fakeClient({ events: [], finalMessage: baseFinal() });
    const runner = new AnthropicApiRunner({ apiKey: "k", client });

    for await (const _ of runner.start({ sessionId: "s", prompt: "p", maxTokens: 256 })) {
      void _;
    }

    expect(calls[0]?.max_tokens).toBe(256);
  });
});

describe("resolveAnthropicModel", () => {
  it("passes through Anthropic model ids unchanged", () => {
    expect(resolveAnthropicModel(DEFAULT_ANTHROPIC_MODEL)).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(resolveAnthropicModel("claude-opus-4-1")).toBe("claude-opus-4-1");
  });

  it("falls back to the default when the model is undefined or empty", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveAnthropicModel(undefined)).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(resolveAnthropicModel("")).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and falls back to the default for non-Anthropic providers' model ids", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = `gpt-${"x".repeat(80)}`;

    expect(resolveAnthropicModel(model)).toBe(DEFAULT_ANTHROPIC_MODEL);

    expect(warn).toHaveBeenCalledWith(
      "Anthropic API model is not Claude-compatible; using default Anthropic model.",
      {
        configuredModel: expect.any(String),
        defaultModel: DEFAULT_ANTHROPIC_MODEL,
      },
    );
    const payload = warn.mock.calls[0]?.[1] as { configuredModel: string };
    expect(payload.configuredModel).toContain("...");
    expect(payload.configuredModel).not.toBe(model);
    expect(payload.configuredModel.length).toBeLessThan(model.length);
  });
});

describe("parseStreamEvent", () => {
  it("maps text_delta deltas to text events", () => {
    expect(
      parseStreamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hi" },
      }),
    ).toEqual({ type: "text", text: "hi" });
  });

  it("returns null for non-text deltas", () => {
    expect(
      parseStreamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{}" },
      }),
    ).toBeNull();
  });

  it("returns null for unrelated event types", () => {
    expect(
      parseStreamEvent({
        type: "content_block_stop",
        index: 0,
      } as RawMessageStreamEvent),
    ).toBeNull();
  });
});

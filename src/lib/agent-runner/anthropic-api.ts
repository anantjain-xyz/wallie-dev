import Anthropic from "@anthropic-ai/sdk";
import type { Message, RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages/messages";

import type { AgentEvent, AgentRunner, AgentRunnerStartInput } from "./types";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicApiRunnerOptions {
  /** Workspace-scoped Anthropic API key (decrypted from `workspace_secrets`). */
  apiKey: string;
  /** Model identifier (e.g. "claude-sonnet-4-5"). */
  model?: string;
  /**
   * Optional injection point for the Anthropic client. The factory builds one
   * from `apiKey` when omitted; tests pass a fake to script the stream.
   */
  client?: AnthropicClientLike;
}

/**
 * Minimal slice of the SDK we depend on. Lets unit tests script
 * `messages.stream(...)` without spinning up a real network client.
 */
export interface AnthropicClientLike {
  messages: {
    stream(params: {
      model: string;
      max_tokens: number;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }): AsyncIterable<RawMessageStreamEvent> & { finalMessage(): Promise<Message> };
  };
}

/**
 * Direct Anthropic Messages API runner.
 *
 * Streams text deltas as they arrive, emits a single completion event with the
 * final usage. Unlike the CLI-backed runners (codex, claude-code) this does
 * not require a sandbox — text-only stages (product spec, design, review)
 * skip sandbox provisioning entirely when this runner is selected.
 */
export class AnthropicApiRunner implements AgentRunner {
  readonly provider = "anthropic-api";
  readonly requiresSandbox = false;

  private readonly client: AnthropicClientLike;
  private readonly model: string;

  constructor(private readonly options: AnthropicApiRunnerOptions) {
    if (!options.apiKey) {
      throw new Error("AnthropicApiRunner requires an apiKey.");
    }
    this.client =
      options.client ?? (new Anthropic({ apiKey: options.apiKey }) as AnthropicClientLike);
    this.model = resolveAnthropicModel(options.model);
  }

  async *start(input: AgentRunnerStartInput): AsyncIterable<AgentEvent> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: "user", content: input.prompt }],
    });

    try {
      for await (const event of stream) {
        const parsed = parseStreamEvent(event);
        if (parsed) yield parsed;
      }
    } catch (error) {
      yield {
        type: "error",
        message: `Anthropic API stream failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
      return;
    }

    let finalMessage: Message;
    try {
      finalMessage = await stream.finalMessage();
    } catch (error) {
      yield {
        type: "error",
        message: `Anthropic API finalMessage failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
      return;
    }

    const usage = finalMessage.usage
      ? {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
        }
      : undefined;

    yield {
      type: "completion",
      taskComplete: finalMessage.stop_reason === "end_turn",
      summary: `Anthropic API session completed (stop_reason: ${finalMessage.stop_reason ?? "unknown"})`,
      ...(usage ? { usage } : {}),
    };
  }
}

/**
 * Pick a model id this runner can actually send to the Anthropic API.
 *
 * Workspaces store one `agent_model` setting that's shared across providers,
 * so a workspace previously configured for Codex (e.g. `gpt-5-codex`) will
 * forward that value here on switch. Anthropic rejects any non-`claude-*`
 * model, breaking every stage until the user manually fixes the setting.
 * Treat anything that isn't an Anthropic family id as "not configured" and
 * fall back to the default.
 */
export function resolveAnthropicModel(model: string | undefined): string {
  if (model && model.startsWith("claude-")) return model;
  return DEFAULT_ANTHROPIC_MODEL;
}

/**
 * Map a single Anthropic stream event to an AgentEvent. Returns null for
 * events we don't surface (message_start, content_block_start/stop, etc.).
 */
export function parseStreamEvent(event: RawMessageStreamEvent): AgentEvent | null {
  if (event.type === "content_block_delta") {
    const delta = event.delta;
    if (delta.type === "text_delta" && delta.text) {
      return { type: "text", text: delta.text };
    }
  }
  return null;
}

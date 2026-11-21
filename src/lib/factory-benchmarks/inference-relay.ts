import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProxyMeta } from "@vercel/sandbox";
import { z } from "zod";

import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";
import { decryptSecretValue } from "@/lib/secrets/crypto";

const bindUrl = "https://api.openai.com/.well-known/wallie-benchmark-bind";
const inferenceUrl = "https://api.openai.com/v1/responses";
const maxRequestBytes = 1024 * 1024;
const maxResponseBytes = 8 * 1024 * 1024;
const rpcTimeoutMs = 5_000;
const monitorIntervalMs = 1_000;
const maxRelayMs = 280_000;
const model = z
  .string()
  .max(200)
  .regex(/^gpt-[a-z0-9.-]+-\d{4}-\d{2}-\d{2}$/);
const name = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const text = z.string();
const itemId = z.string().max(256);
const nonceSchema = z.strictObject({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

const textContent = z.union([
  z.strictObject({ type: z.literal("input_text"), text }),
  z.strictObject({
    type: z.literal("output_text"),
    text,
    annotations: z.array(z.never()).optional(),
    logprobs: z.array(z.never()).nullable().optional(),
  }),
  z.strictObject({ type: z.literal("refusal"), refusal: text }),
]);
const message = z.strictObject({
  type: z.literal("message").optional(),
  id: itemId.optional(),
  status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
  role: z.enum(["user", "assistant", "system", "developer"]),
  content: z.union([text, z.array(textContent)]),
});
const callFields = {
  id: itemId.optional(),
  call_id: itemId,
  status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
};
const toolOutput = z.union([
  text,
  z.array(z.strictObject({ type: z.literal("input_text"), text })),
]);
const inputItem = z.union([
  message,
  z.strictObject({ ...callFields, type: z.literal("function_call"), name, arguments: text }),
  z.strictObject({ ...callFields, type: z.literal("function_call_output"), output: toolOutput }),
  z.strictObject({ ...callFields, type: z.literal("custom_tool_call"), name, input: text }),
  z.strictObject({ ...callFields, type: z.literal("custom_tool_call_output"), output: toolOutput }),
  z.strictObject({
    type: z.literal("reasoning"),
    id: itemId.optional(),
    status: callFields.status,
    summary: z.array(z.strictObject({ type: z.literal("summary_text"), text })),
    content: z.array(z.strictObject({ type: z.literal("reasoning_text"), text })).optional(),
    encrypted_content: text.nullable().optional(),
  }),
]);

function hasOnlyLocalSchemaReferences(schema: Record<string, unknown>) {
  const pending: unknown[] = [schema];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === "$id" || key === "$anchor" || key === "$dynamicAnchor") return false;
      if (
        ["$ref", "$dynamicRef", "$recursiveRef"].includes(key) &&
        (typeof child !== "string" || !child.startsWith("#"))
      )
        return false;
      pending.push(child);
    }
  }
  return true;
}

const localSchema = z.record(z.unknown()).refine(hasOnlyLocalSchemaReferences);
const localTool = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("function"),
    name,
    description: text.optional(),
    parameters: localSchema.nullable().optional(),
    strict: z.boolean().nullable().optional(),
  }),
  z.strictObject({
    type: z.literal("custom"),
    name,
    description: text.optional(),
    format: z
      .discriminatedUnion("type", [
        z.strictObject({ type: z.literal("text") }),
        z.strictObject({
          type: z.literal("grammar"),
          syntax: z.enum(["lark", "regex"]),
          definition: text,
        }),
      ])
      .optional(),
  }),
]);
const responseFormat = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text") }),
  z.strictObject({ type: z.literal("json_object") }),
  z.strictObject({
    type: z.literal("json_schema"),
    name,
    schema: localSchema,
    description: text.optional(),
    strict: z.boolean().nullable().optional(),
  }),
]);

const forwardedRequestSchema = z.object({
  model,
  input: z.union([text, z.array(inputItem)]),
  instructions: text.nullable().optional(),
  tools: z.array(localTool).max(128).optional(),
  tool_choice: z
    .union([
      z.enum(["none", "auto", "required"]),
      z.strictObject({ type: z.enum(["function", "custom"]), name }),
    ])
    .optional(),
  parallel_tool_calls: z.boolean().optional(),
  reasoning: z
    .strictObject({
      effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
      summary: z.enum(["auto", "concise", "detailed"]).nullable().optional(),
    })
    .nullable()
    .optional(),
  include: z.array(z.literal("reasoning.encrypted_content")).max(1).optional(),
  text: z
    .strictObject({
      format: responseFormat.optional(),
      verbosity: z.enum(["low", "medium", "high"]).optional(),
    })
    .optional(),
  max_output_tokens: z.number().int().positive().safe().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
});
const requestSchema = forwardedRequestSchema
  .extend({
    store: z.boolean().nullable().optional(),
    // These harmless SDK hints stay local to the relay.
    background: z.literal(false).nullable().optional(),
    prompt_cache_key: z.string().max(256).nullable().optional(),
    prompt_cache_options: z
      .strictObject({ ttl: z.string().max(40) })
      .nullable()
      .optional(),
    service_tier: z.enum(["auto", "default"]).nullable().optional(),
    stream_options: z
      .strictObject({ include_obfuscation: z.boolean().optional() })
      .nullable()
      .optional(),
    client_metadata: z.record(z.string().max(512)).nullable().optional(),
  })
  .strict()
  .transform((payload) => forwardedRequestSchema.parse(payload));

const permitSchema = z.object({
  requestId: z.string().uuid(),
  deadlineAt: z.string().datetime({ offset: true }),
  model,
  encryptedApiKey: z.string().min(1).max(8192),
});
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().max(2_147_483_647),
  output_tokens: z.number().int().nonnegative().max(2_147_483_647),
});
const responseSchema = z.object({
  model: z.string().min(1).max(200),
  status: z.string().optional(),
  usage: z.unknown().optional(),
});
const eventSchema = z.object({
  type: z
    .string()
    .max(128)
    .regex(/^[a-z][a-z0-9_.]*$/),
  response: responseSchema.optional(),
});

type Identity = Pick<ProxyMeta, "teamId" | "projectId" | "sandboxId">;
type Settlement = {
  status: "completed" | "failed" | "unavailable";
  observedModel?: string;
  inputTokens?: number;
  outputTokens?: number;
};

export type BenchmarkInferenceRelayStore = {
  bind: (identity: Identity, nonceDigest: string, signal: AbortSignal) => Promise<boolean>;
  begin: (identity: Identity, requestDigest: string, signal: AbortSignal) => Promise<unknown>;
  isOpen: (requestId: string, signal: AbortSignal) => Promise<boolean>;
  finish: (requestId: string, settlement: Settlement, signal: AbortSignal) => Promise<boolean>;
};

function scope({ teamId, projectId, sandboxId }: Identity) {
  return { p_team_id: teamId, p_project_id: projectId, p_signed_sandbox_id: sandboxId };
}

export function createBenchmarkInferenceRelayStore(
  client: SupabaseClient,
): BenchmarkInferenceRelayStore {
  return {
    async bind(identity, nonceDigest, signal) {
      const { data, error } = await client
        .rpc("consume_factory_benchmark_live_sandbox_binding", {
          ...scope(identity),
          p_nonce_sha256: nonceDigest,
        })
        .abortSignal(signal);
      if (error) throw new Error("Benchmark binding failed.");
      return data === true;
    },
    async begin(identity, requestDigest, signal) {
      const { data, error } = await client
        .rpc("begin_factory_benchmark_inference_request", {
          ...scope(identity),
          p_request_digest: requestDigest,
        })
        .abortSignal(signal);
      if (error) throw new Error("Benchmark inference reservation failed.");
      return data;
    },
    async isOpen(requestId, signal) {
      const { data, error } = await client
        .rpc("is_factory_benchmark_inference_request_open", {
          p_request_id: requestId,
        })
        .abortSignal(signal);
      if (error) throw new Error("Benchmark inference authority is unavailable.");
      return data === true;
    },
    async finish(requestId, result, signal) {
      const { data, error } = await client
        .rpc("finish_factory_benchmark_inference_request", {
          p_request_id: requestId,
          p_status: result.status,
          ...(result.observedModel ? { p_observed_model: result.observedModel } : {}),
          ...(result.inputTokens !== undefined ? { p_input_tokens: result.inputTokens } : {}),
          ...(result.outputTokens !== undefined ? { p_output_tokens: result.outputTokens } : {}),
        })
        .abortSignal(signal);
      if (error) throw new Error("Benchmark inference settlement failed.");
      return data === true;
    },
  };
}

function reply(status: number) {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function startInferenceScope(
  store: BenchmarkInferenceRelayStore,
  permit: z.infer<typeof permitSchema>,
  clientSignal: AbortSignal,
) {
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, clientSignal]);
  const deadlineMs = Math.min(maxRelayMs, Date.parse(permit.deadlineAt) - Date.now());
  const deadline = setTimeout(() => abort.abort(), Math.max(0, deadlineMs));
  let monitor: ReturnType<typeof setTimeout> | undefined;
  let settled: Promise<boolean> | undefined;
  function settle(result: Settlement) {
    if (!settled) {
      clearTimeout(deadline);
      clearTimeout(monitor);
      signal.removeEventListener("abort", settleUnavailable);
      settled = store
        .finish(permit.requestId, result, AbortSignal.timeout(rpcTimeoutMs))
        .catch(() => false);
    }
    return settled;
  }
  function settleUnavailable() {
    void settle({ status: "unavailable" });
  }
  async function poll() {
    try {
      if (
        !settled &&
        !signal.aborted &&
        !(await store.isOpen(
          permit.requestId,
          AbortSignal.any([signal, AbortSignal.timeout(rpcTimeoutMs)]),
        ))
      ) {
        abort.abort();
      }
    } catch {
      abort.abort();
    }
    if (!settled && !signal.aborted) monitor = setTimeout(() => void poll(), monitorIntervalMs);
  }
  signal.addEventListener("abort", settleUnavailable, { once: true });
  if (deadlineMs <= 0 || signal.aborted) {
    abort.abort();
    settleUnavailable();
  } else {
    monitor = setTimeout(() => void poll(), monitorIntervalMs);
  }
  return { signal, abort, settle };
}
type InferenceScope = ReturnType<typeof startInferenceScope>;

async function* responseText(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  function cancelReader() {
    void reader.cancel().catch(() => undefined);
  }
  signal.addEventListener("abort", cancelReader, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) throw new Error("Benchmark inference response is too large.");
      yield decoder.decode(value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancelReader);
    cancelReader();
    reader.releaseLock();
  }
}

async function* responseFrames(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  let pending = "";
  for await (const chunk of responseText(body, signal)) {
    pending += chunk;
    for (;;) {
      const separator = /\r?\n\r?\n/.exec(pending);
      if (!separator) break;
      const frame = pending.slice(0, separator.index);
      pending = pending.slice(separator.index + separator[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data || data === "[DONE]") continue;
      const event = eventSchema.parse(JSON.parse(data));
      yield { data, event };
    }
  }
  if (pending.trim()) throw new Error("Benchmark inference SSE frame was incomplete.");
}

function observedSettlement(
  status: "completed" | "failed",
  response: z.infer<typeof responseSchema>,
) {
  const usage = usageSchema.safeParse(response.usage);
  return {
    status,
    observedModel: response.model,
    ...(usage.success
      ? { inputTokens: usage.data.input_tokens, outputTokens: usage.data.output_tokens }
      : {}),
  } satisfies Settlement;
}

function relayStream(
  upstream: ReadableStream<Uint8Array>,
  runtime: InferenceScope,
  expectedModel: string,
) {
  const frames = responseFrames(upstream, runtime.signal);
  const encoder = new TextEncoder();
  let confirmedModel = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await frames.next();
        if (next.done) throw new Error("Missing terminal benchmark inference event.");
        const { data, event } = next.value;
        const response = event.response;
        if (response && response.model !== expectedModel) {
          await runtime.settle({ status: "failed" });
          throw new Error("Unexpected benchmark inference model.");
        }
        confirmedModel ||= Boolean(response);
        if (
          event.type === "response.failed" ||
          event.type === "response.incomplete" ||
          event.type === "error"
        ) {
          await runtime.settle(
            response ? observedSettlement("failed", response) : { status: "failed" },
          );
          throw new Error("Benchmark inference failed.");
        }
        if (!confirmedModel) throw new Error("Missing benchmark inference model.");
        const frame = encoder.encode(
          "event: " + event.type + "\ndata: " + data.split("\n").join("\ndata: ") + "\n\n",
        );
        if (event.type === "response.completed") {
          if (
            !response ||
            response.status !== "completed" ||
            !(await runtime.settle(observedSettlement("completed", response))) ||
            runtime.signal.aborted
          )
            throw new Error("Benchmark inference could not be settled.");
          controller.enqueue(frame);
          controller.close();
          await frames.return(undefined);
          return;
        }
        // Preserve verified event data without forwarding upstream control fields.
        controller.enqueue(frame);
      } catch {
        await runtime.settle({ status: "unavailable" });
        await frames.return(undefined).catch(() => undefined);
        controller.error(new Error("Benchmark inference stream did not complete."));
      }
    },
    async cancel() {
      runtime.abort.abort();
      await runtime.settle({ status: "unavailable" });
      await frames.return(undefined).catch(() => undefined);
    },
  });
}

export async function relayBenchmarkInference(
  request: Request,
  identity: Identity,
  input: {
    store: BenchmarkInferenceRelayStore;
    signal?: AbortSignal;
    fetch?: typeof fetch;
    decrypt?: (encrypted: string) => string;
  },
) {
  const {
    store,
    signal = request.signal,
    fetch: send = fetch,
    decrypt = decryptSecretValue,
  } = input;
  if (request.method !== "POST" || (request.url !== bindUrl && request.url !== inferenceUrl)) {
    return reply(403);
  }
  const isBinding = request.url === bindUrl;
  const body = await readBoundedJsonBody(request, isBinding ? 256 : maxRequestBytes);
  if (!body.ok) {
    return reply(
      body.code === "request_too_large" ? 413 : body.code === "unsupported_media_type" ? 415 : 400,
    );
  }

  if (isBinding) {
    const parsed = nonceSchema.safeParse(body.body);
    if (!parsed.success) return reply(400);
    try {
      const bound = await store.bind(
        identity,
        sha256(parsed.data.nonce),
        AbortSignal.any([signal, AbortSignal.timeout(rpcTimeoutMs)]),
      );
      return reply(bound ? 204 : 403);
    } catch {
      return reply(503);
    }
  }

  const parsed = requestSchema.safeParse(body.body);
  if (!parsed.success) return reply(400);
  const forwarded = parsed.data;
  const upstreamBody = JSON.stringify({ ...forwarded, store: false });
  let permit: z.infer<typeof permitSchema>;
  try {
    const permission = await store.begin(
      identity,
      sha256(upstreamBody),
      AbortSignal.any([signal, AbortSignal.timeout(rpcTimeoutMs)]),
    );
    if (permission === null) return reply(403);
    permit = permitSchema.parse(permission);
  } catch {
    return reply(503);
  }

  const runtime = startInferenceScope(store, permit, signal);
  if (forwarded.model !== permit.model) {
    await runtime.settle({ status: "failed" });
    return reply(403);
  }

  try {
    runtime.signal.throwIfAborted();
    const upstream = await send(inferenceUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + decrypt(permit.encryptedApiKey),
        "Content-Type": "application/json",
        Accept: forwarded.stream ? "text/event-stream" : "application/json",
      },
      body: upstreamBody,
      redirect: "error",
      cache: "no-store",
      signal: runtime.signal,
    });
    if (!upstream.ok) {
      void upstream.body?.cancel().catch(() => undefined);
      await runtime.settle({ status: "failed" });
      return reply(502);
    }
    const contentType = upstream.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
    const expectedContent = forwarded.stream ? "text/event-stream" : "application/json";
    if (!upstream.body || contentType !== expectedContent) {
      void upstream.body?.cancel().catch(() => undefined);
      await runtime.settle({ status: "unavailable" });
      return reply(502);
    }
    const headers = { "Content-Type": expectedContent, "Cache-Control": "no-store" };
    if (forwarded.stream)
      return new Response(relayStream(upstream.body, runtime, permit.model), { headers });

    const chunks = [];
    for await (const chunk of responseText(upstream.body, runtime.signal)) chunks.push(chunk);
    const data = chunks.join("");
    const outcome = responseSchema.parse(JSON.parse(data));
    if (outcome.model !== permit.model) {
      await runtime.settle({ status: "failed" });
      return reply(502);
    }
    const completed = outcome.status === "completed";
    const settled = await runtime.settle(
      observedSettlement(completed ? "completed" : "failed", outcome),
    );
    return completed && settled && !runtime.signal.aborted
      ? new Response(data, { headers })
      : reply(502);
  } catch {
    await runtime.settle({ status: "unavailable" });
    return reply(502);
  }
}

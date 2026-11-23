import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";

import { redactRunSensitiveText } from "@/lib/agent-runner/redact-sensitive-text";
import { AgentOutputSafety } from "@/lib/agent-runner/safety";
import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";
import { isFactoryDefinitionText } from "@/lib/factory-definitions/text";
import { workflowNodeIdSchema } from "@/lib/factory-definitions/workflow-schema";
import { untrustedPromptValue, verifyPromptBoundary } from "@/lib/pipeline/prompt-safety";
import { decryptSecretValue } from "@/lib/secrets/crypto";

import type { WorkflowOccurrencePin } from "./deterministic-command";
import type { ForemanInferenceProvider, ForemanUsage } from "./foreman-runtime";

const responsesUrl = "https://api.openai.com/v1/responses";
const responseMaxBytes = 128 * 1024;
const inferenceMaxMs = 30_000;
const minOutputTokens = 16;
const maxStandardInputTokens = 272_000;
const nanoDollarsPerDollar = 1_000_000_000;
const encoder = new TextEncoder();
const unavailableUsage: ForemanUsage = { inputTokens: null, outputTokens: null, costUsd: null };
const platformApiKey = /^sk-(?:(?:proj|svcacct)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20,})$/;

const miniRate = { snapshot: "gpt-5.4-mini-2026-03-17", input: 750, output: 4500 };
const flagshipRate = { snapshot: "gpt-5.5-2026-04-23", input: 5000, output: 30_000 };
const modelRates = new Map([
  ["gpt-5.4-mini", miniRate],
  [miniRate.snapshot, miniRate],
  ["gpt-5.5", flagshipRate],
  [flagshipRate.snapshot, flagshipRate],
]);

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const boundedText = (max: number) => z.string().max(max).refine(isFactoryDefinitionText);

export const openAiForemanIssuanceSchema = z.strictObject({
  status: z.literal("issued"),
  foremanRunId: z.string().uuid(),
  issueId: z.string().uuid(),
  rootSessionId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  factoryId: z.string().uuid(),
  routeOccurrenceId: z.string().uuid(),
  routeNodeId: workflowNodeIdSchema,
  workflowDigest: sha256,
  executionGeneration: z.number().int().safe().positive(),
  model: z.string().regex(/^[a-z][a-z0-9._-]{0,199}$/),
  promptRevisionId: z.string().uuid(),
  promptSha256: sha256,
  promptMd: boundedText(40_000),
  encryptedCredential: z.string().min(1).max(8192),
  reservedTokens: z.number().int().safe().positive(),
  reservedCostUsd: z.number().finite().positive(),
  maxInputBytes: z.number().int().safe().positive().max(49_152),
  maxOutputTokens: z.number().int().safe().positive().max(4096),
  deadlineAt: z.string().datetime({ offset: true }),
  parentSessionId: z.string().uuid(),
  sourceCheckpointRunId: z.string().uuid().nullable(),
  title: boundedText(400),
  taskPromptMd: boundedText(24_000),
  allowedDestinationIds: z.array(workflowNodeIdSchema).max(128),
  offeredChildren: z
    .array(
      z.strictObject({
        childRef: z.string().regex(/^child-[a-f0-9-]{36}$/),
        childSessionId: z.string().uuid(),
        targetOccurrenceId: z.string().uuid(),
        phaseStatus: z.string().min(1).max(64),
      }),
    )
    .max(16),
});

const responseEnvelope = z.object({
  object: z.literal("response"),
  id: z.string().regex(/^resp_[A-Za-z0-9_-]{1,155}$/),
  model: z.string(),
  status: z.string(),
  output: z.unknown().optional(),
  usage: z.unknown().optional(),
});

const responseOutput = z
  .array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("reasoning") }),
      z.object({
        type: z.literal("message"),
        role: z.literal("assistant"),
        status: z.literal("completed"),
        content: z.tuple([z.object({ type: z.literal("output_text"), text: z.string().min(1) })]),
      }),
    ]),
  )
  .max(16);

const tokenCount = z.number().int().safe().nonnegative();
const inputTokenReceipt = z.object({
  object: z.literal("response.input_tokens"),
  input_tokens: tokenCount.positive(),
});
const usageFields = z.object({
  input_tokens: z.unknown(),
  output_tokens: z.unknown(),
  total_tokens: z.unknown(),
});

type ProviderOutcome = Awaited<ReturnType<ForemanInferenceProvider>>;

function blocked(
  code: "provider_unavailable" | "timeout" | "budget_exhausted" = "provider_unavailable",
  usage = unavailableUsage,
  providerReceiptId?: string,
): ProviderOutcome {
  return { status: "blocked", code, usage, ...(providerReceiptId ? { providerReceiptId } : {}) };
}

function readUsage(value: unknown, rate: typeof miniRate): ForemanUsage {
  const parsed = usageFields.safeParse(value);
  if (!parsed.success) return { ...unavailableUsage };

  const inputTokens = tokenCount.safeParse(parsed.data.input_tokens).data ?? null;
  const outputTokens = tokenCount.safeParse(parsed.data.output_tokens).data ?? null;
  const totalTokens = tokenCount.safeParse(parsed.data.total_tokens).data ?? null;
  if (
    inputTokens !== null &&
    outputTokens !== null &&
    totalTokens !== null &&
    inputTokens + outputTokens !== totalTokens
  ) {
    return { ...unavailableUsage };
  }
  const nanoDollars =
    inputTokens === null || outputTokens === null
      ? null
      : inputTokens * rate.input + outputTokens * rate.output;
  return {
    inputTokens,
    outputTokens,
    costUsd:
      nanoDollars !== null && Number.isSafeInteger(nanoDollars)
        ? nanoDollars / nanoDollarsPerDollar
        : null,
  };
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const length = response.headers.get("content-length");
  if (
    signal.aborted ||
    !response.ok ||
    contentType !== "application/json" ||
    !response.body ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > responseMaxBytes))
  ) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }

  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let text = "";
  let bytes = 0;
  let complete = false;
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done && !signal.aborted) {
        complete = true;
        const parsed = parseFactoryDefinitionJson(text + decoder.decode());
        return parsed.ok ? parsed.value : null;
      }
      if (chunk.done) return null;
      bytes += chunk.value.byteLength;
      if (bytes > responseMaxBytes) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return null;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

function readOutcome(
  data: unknown,
  rate: typeof miniRate,
  limits: { input: number; output: number },
  secrets: AgentOutputSafety,
): ProviderOutcome {
  const parsed = responseEnvelope.safeParse(data);
  if (
    !parsed.success ||
    parsed.data.model !== rate.snapshot ||
    secrets.redact(parsed.data.id) !== parsed.data.id
  )
    return blocked();

  const { id, output, status } = parsed.data;
  const usage = readUsage(parsed.data.usage, rate);
  if ((usage.inputTokens ?? 0) > limits.input || (usage.outputTokens ?? 0) > limits.output)
    return blocked("budget_exhausted", usage, id);
  if (usage.inputTokens === null || usage.outputTokens === null)
    return blocked("provider_unavailable", usage, id);
  if (status !== "completed") return blocked("provider_unavailable", usage, id);
  const items = responseOutput.safeParse(output);
  if (!items.success) return blocked("provider_unavailable", usage, id);
  const messages = items.data.filter((item) => item.type === "message");
  if (messages.length !== 1) return blocked("provider_unavailable", usage, id);

  const { text } = messages[0].content[0];
  const plan = parseFactoryDefinitionJson(text);
  if (!plan.ok || secrets.redact(text) !== text) return blocked("provider_unavailable", usage, id);
  const decodedPlan = JSON.stringify(plan.value);
  if (
    secrets.redact(decodedPlan) !== decodedPlan ||
    redactRunSensitiveText(decodedPlan) !== decodedPlan
  )
    return blocked("provider_unavailable", usage, id);

  return { status: "completed", output: text, usage, providerReceiptId: id };
}

/** Bind one provider invocation to the fresh ticket returned by the service-only begin RPC. */
export function createOpenAiForemanProvider({
  issued,
  pin,
  fetcher = fetch,
  decrypt = decryptSecretValue,
}: {
  issued: unknown;
  pin: WorkflowOccurrencePin;
  fetcher?: typeof fetch;
  decrypt?: (ciphertext: string) => string;
}): ForemanInferenceProvider {
  const parsed = openAiForemanIssuanceSchema.safeParse(issued);
  if (!parsed.success) return async () => blocked();
  const ticket = parsed.data;
  const rate = modelRates.get(ticket.model);
  if (
    !rate ||
    ticket.rootSessionId !== pin.p_root_session_id ||
    ticket.workspaceId !== pin.p_workspace_id ||
    ticket.factoryId !== pin.p_factory_id ||
    ticket.routeOccurrenceId !== pin.occurrenceId ||
    ticket.routeNodeId !== pin.nodeId ||
    ticket.workflowDigest !== pin.workflowDigest ||
    ticket.executionGeneration !== pin.p_expected_generation ||
    ticket.maxOutputTokens > ticket.reservedTokens ||
    createHash("sha256").update(ticket.promptMd, "utf8").digest("hex") !== ticket.promptSha256
  ) {
    return async () => blocked();
  }

  const userMessage = [
    verifyPromptBoundary(untrustedPromptValue("session.title", ticket.title)),
    verifyPromptBoundary(untrustedPromptValue("session.prompt", ticket.taskPromptMd)),
    verifyPromptBoundary(
      untrustedPromptValue(
        "foreman.context",
        JSON.stringify({
          destinations: ticket.allowedDestinationIds,
          children: ticket.offeredChildren.map(({ childRef, phaseStatus }) => ({
            ref: childRef,
            progress: phaseStatus,
          })),
        }),
      ),
    ),
  ].join("\n\n");

  let used = false;
  return async (request) => {
    const [system, user] = request.messages;
    if (
      used ||
      request.profile.providerRoute !== "openai" ||
      request.profile.modelId !== ticket.model ||
      request.profile.encryptedCredential !== ticket.encryptedCredential ||
      request.toolChoice !== "none" ||
      !Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens <= 0 ||
      request.maxOutputTokens > ticket.maxOutputTokens ||
      request.messages.length !== 2 ||
      system?.role !== "system" ||
      // The runtime adds Wallie’s trusted protocol before the frozen approved prompt.
      !system.content.endsWith(`\n\n${ticket.promptMd}`) ||
      user?.role !== "user" ||
      user.content !== userMessage
    ) {
      return blocked();
    }
    const remainingMs = Date.parse(ticket.deadlineAt) - Date.now();
    if (remainingMs <= 0 || request.signal.aborted) return blocked("timeout");

    const input = {
      model: rate.snapshot,
      input: [
        { role: system.role, content: system.content },
        { role: user.role, content: user.content },
      ],
      text: { format: { type: "json_object" } },
      tool_choice: "none",
      tools: [],
      parallel_tool_calls: false,
      truncation: "disabled",
    };
    const countBody = JSON.stringify(input);
    if (encoder.encode(countBody).byteLength > ticket.maxInputBytes) return blocked();

    used = true;
    const signal = AbortSignal.timeout(Math.min(remainingMs, inferenceMaxMs));
    const preflightSignal = AbortSignal.any([request.signal, signal]);
    let startedInference = false;
    let cancel = () => {};
    const canceled = new Promise<ProviderOutcome>((resolve) => {
      cancel = () => {
        if (signal.aborted || !startedInference) resolve(blocked("timeout"));
      };
      signal.addEventListener("abort", cancel, { once: true });
      request.signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      const send = async () => {
        if (preflightSignal.aborted) return blocked("timeout");
        const apiKey = decrypt(ticket.encryptedCredential);
        if (apiKey.length > 4096 || !platformApiKey.test(apiKey)) return blocked();
        const secrets = new AgentOutputSafety([apiKey, ticket.encryptedCredential]);
        if (secrets.redact(countBody) !== countBody) return blocked();

        const post = async (url: string, body: string, signal: AbortSignal) =>
          readResponse(
            await fetcher(url, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body,
              signal,
              redirect: "error",
              cache: "no-store",
            }),
            signal,
          );
        const count = inputTokenReceipt.safeParse(
          await post(`${responsesUrl}/input_tokens`, countBody, preflightSignal),
        );
        if (preflightSignal.aborted) return blocked("timeout");
        if (!count.success) return blocked();
        const inputTokens = count.data.input_tokens;
        const spendRemaining =
          Math.floor(ticket.reservedCostUsd * nanoDollarsPerDollar) - inputTokens * rate.input;
        const outputTokens = Math.min(
          request.maxOutputTokens,
          ticket.reservedTokens - inputTokens,
          Math.floor(spendRemaining / rate.output),
        );
        if (inputTokens > maxStandardInputTokens || outputTokens < minOutputTokens)
          return blocked("budget_exhausted");

        const body = JSON.stringify({
          ...input,
          max_output_tokens: outputTokens,
          stream: false,
          store: false,
          service_tier: "default",
        });
        if (encoder.encode(body).byteLength > ticket.maxInputBytes) return blocked();
        startedInference = true;
        const outcome = await post(responsesUrl, body, signal);
        return signal.aborted
          ? blocked("timeout")
          : readOutcome(outcome, rate, { input: inputTokens, output: outputTokens }, secrets);
      };
      return await Promise.race([send(), canceled]);
    } catch {
      return blocked(preflightSignal.aborted ? "timeout" : "provider_unavailable");
    } finally {
      signal.removeEventListener("abort", cancel);
      request.signal.removeEventListener("abort", cancel);
    }
  };
}

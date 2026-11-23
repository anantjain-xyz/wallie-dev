import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { untrustedPromptValue, verifyPromptBoundary } from "@/lib/pipeline/prompt-safety";
import { decryptSecretValue, encryptSecretValue } from "@/lib/secrets/crypto";

import type { WorkflowOccurrencePin } from "./deterministic-command";
import { createOpenAiForemanProvider } from "./foreman-openai";
import type { ForemanInferenceProvider } from "./foreman-runtime";

type ProviderRequest = Parameters<ForemanInferenceProvider>[0];

const id = (suffix: number) => `a1000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const pin: WorkflowOccurrencePin = {
  p_root_session_id: id(1),
  p_workspace_id: id(2),
  p_factory_id: id(3),
  p_ownership_token: id(4),
  p_expected_generation: 7,
  occurrenceId: id(5),
  nodeId: "route",
  workflowDigest: "a".repeat(64),
};
const environment = { WALLIE_ENCRYPTION_KEY: "fixture-only-local-encryption-key" };
const apiKey = "sk-proj-foreman_minted_key_fixture_only";
const providerReceiptId = "resp_native_foreman";
const plan = JSON.stringify({
  version: 1,
  commands: [
    { kind: "route", decision: { kind: "unresolved", reason: "Confirm the next task." } },
    { kind: "read_child", childRef: "child-existing" },
  ],
});

function setup() {
  const promptMd = "Inspect and route the scoped Factory work.";
  const issue = {
    status: "issued",
    foremanRunId: id(6),
    issueId: id(7),
    rootSessionId: pin.p_root_session_id,
    workspaceId: pin.p_workspace_id,
    factoryId: pin.p_factory_id,
    routeOccurrenceId: pin.occurrenceId,
    routeNodeId: pin.nodeId,
    workflowDigest: pin.workflowDigest,
    executionGeneration: pin.p_expected_generation,
    model: "gpt-5.4-mini-2026-03-17",
    promptRevisionId: id(8),
    promptSha256: createHash("sha256").update(promptMd).digest("hex"),
    promptMd,
    encryptedCredential: encryptSecretValue(apiKey, environment),
    reservedTokens: 6000,
    reservedCostUsd: 0.2,
    maxInputBytes: 49_152,
    maxOutputTokens: 4096,
    deadlineAt: new Date(Date.now() + 15_000).toISOString().replace("Z", "+00:00"),
    parentSessionId: id(1),
    sourceCheckpointRunId: null,
    title: "Frozen task",
    taskPromptMd: "Summarize the exact child progress.",
    allowedDestinationIds: ["child-task"],
    offeredChildren: [
      {
        childRef: `child-${id(9)}`,
        childSessionId: id(9),
        targetOccurrenceId: id(10),
        phaseStatus: "awaiting_review",
      },
    ],
  };
  const request: ProviderRequest = {
    profile: {
      modelId: issue.model,
      providerRoute: "openai",
      encryptedCredential: issue.encryptedCredential,
    },
    messages: [
      { role: "system", content: `Return a JSON foreman plan.\n\n${promptMd}` },
      {
        role: "user",
        content: [
          verifyPromptBoundary(untrustedPromptValue("session.title", issue.title)),
          verifyPromptBoundary(untrustedPromptValue("session.prompt", issue.taskPromptMd)),
          verifyPromptBoundary(
            untrustedPromptValue(
              "foreman.context",
              JSON.stringify({
                destinations: issue.allowedDestinationIds,
                children: [{ ref: issue.offeredChildren[0].childRef, progress: "awaiting_review" }],
              }),
            ),
          ),
        ].join("\n\n"),
      },
    ],
    toolChoice: "none",
    maxOutputTokens: issue.maxOutputTokens,
    signal: new AbortController().signal,
  };
  const infer = vi.fn<typeof fetch>();
  const countTokens = vi.fn<typeof fetch>(async () =>
    Response.json({ object: "response.input_tokens", input_tokens: 400 }),
  );
  const fetcher = vi.fn<typeof fetch>((url, init) =>
    String(url).endsWith("/input_tokens") ? countTokens(url, init) : infer(url, init),
  );
  const decrypt = vi.fn((ciphertext: string) => decryptSecretValue(ciphertext, environment));
  const bind = (issued: unknown = issue) =>
    createOpenAiForemanProvider({ issued, pin, fetcher, decrypt });
  return { issue, request, fetcher, infer, countTokens, decrypt, bind };
}

function assistantMessage(text = plan) {
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return Response.json({
    object: "response",
    id: providerReceiptId,
    model: "gpt-5.4-mini-2026-03-17",
    status: "completed",
    output: [{ type: "reasoning", summary: [] }, assistantMessage()],
    usage: { input_tokens: 400, output_tokens: 100, total_tokens: 500 },
    ...overrides,
  });
}

const measured = { inputTokens: 400, outputTokens: 100, costUsd: 0.00075 };
const unknownUsage = { inputTokens: null, outputTokens: null, costUsd: null };

describe("issued foreman OpenAI transport", () => {
  it("posts one pinned tool-free Responses request and only returns attributable usage and output", async () => {
    const { issue, request, fetcher, infer, decrypt, bind } = setup();
    infer.mockResolvedValue(response());
    const invoke = bind();

    await expect(invoke(request)).resolves.toEqual({
      status: "completed",
      output: plan,
      providerReceiptId,
      usage: measured,
    });
    await expect(invoke(request)).resolves.toMatchObject({
      status: "blocked",
      code: "provider_unavailable",
    });
    expect(decrypt.mock.calls).toEqual([[issue.encryptedCredential]]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [countUrl, countInit] = fetcher.mock.calls[0];
    expect(countUrl).toBe("https://api.openai.com/v1/responses/input_tokens");
    expect(countInit?.body).toEqual(
      JSON.stringify({
        model: issue.model,
        input: request.messages,
        text: { format: { type: "json_object" } },
        tool_choice: "none",
        tools: [],
        parallel_tool_calls: false,
        truncation: "disabled",
      }),
    );
    const [url, init] = fetcher.mock.calls[1];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      redirect: "error",
      cache: "no-store",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: issue.model,
      input: request.messages,
      max_output_tokens: issue.maxOutputTokens,
      text: { format: { type: "json_object" } },
      tool_choice: "none",
      tools: [],
      stream: false,
      store: false,
      service_tier: "default",
      parallel_tool_calls: false,
      truncation: "disabled",
    });
    expect(init?.body).not.toContain(apiKey);
    expect(init?.body).not.toContain(issue.encryptedCredential);
    expect(init?.body).not.toContain(issue.issueId);
  });

  it("checks the scoped issuance, frozen inputs and requested cap before decrypting", async () => {
    const { issue, request, fetcher, decrypt, bind } = setup();
    const invalid = [
      { ...issue, status: "existing" },
      { ...issue, workspaceId: id(99) },
      { ...issue, routeOccurrenceId: id(99) },
      { ...issue, executionGeneration: issue.executionGeneration + 1 },
      { ...issue, promptMd: "Different instructions." },
      { ...issue, model: "gpt-unsupported" },
      { ...issue, reservedTokens: issue.maxOutputTokens - 1 },
      { ...issue, maxInputBytes: 1 },
    ];
    for (const ticket of invalid) {
      await expect(bind(ticket)(request)).resolves.toMatchObject({
        status: "blocked",
        code: "provider_unavailable",
      });
    }

    const wrongRequest = [
      { ...request, profile: { ...request.profile, providerRoute: "elsewhere" } },
      { ...request, profile: { ...request.profile, modelId: "gpt-5" } },
      { ...request, profile: { ...request.profile, encryptedCredential: "wrong-key" } },
      { ...request, maxOutputTokens: issue.maxOutputTokens + 1 },
      {
        ...request,
        messages: [{ role: "system", content: "Unpinned prompt." }, request.messages[1]],
      },
      {
        ...request,
        messages: [request.messages[0], { role: "user", content: "Unpinned context." }],
      },
    ] satisfies ProviderRequest[];
    for (const invalidRequest of wrongRequest) {
      await expect(bind()(invalidRequest)).resolves.toMatchObject({ status: "blocked" });
    }

    expect(decrypt).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { reservedTokens: 418, reservedCostUsd: 0.2, maxOutput: 18 },
    { reservedTokens: 500, reservedCostUsd: 0.00039, maxOutput: 20 },
  ])(
    "caps generated tokens before inference using the exact input count and reserve",
    async ({ reservedTokens, reservedCostUsd, maxOutput }) => {
      const { issue, request, infer, bind } = setup();
      infer.mockResolvedValueOnce(
        response({ usage: { input_tokens: 400, output_tokens: 16, total_tokens: 416 } }),
      );
      const invoke = bind({
        ...issue,
        reservedTokens,
        reservedCostUsd,
        maxOutputTokens: reservedTokens,
      });
      await expect(invoke({ ...request, maxOutputTokens: reservedTokens })).resolves.toMatchObject({
        status: "completed",
        usage: { inputTokens: 400, outputTokens: 16, costUsd: 0.000372 },
      });
      expect(JSON.parse(String(infer.mock.calls[0][1]?.body))).toMatchObject({
        max_output_tokens: maxOutput,
      });
    },
  );

  it.each([
    { reservedTokens: 415, reservedCostUsd: 0.2 },
    { reservedTokens: 500, reservedCostUsd: 0.00031 },
  ])("stops before paid inference when the remaining budget is too small", async (reservation) => {
    const { issue, request, infer, countTokens, bind } = setup();
    const invoke = bind({ ...issue, ...reservation, maxOutputTokens: reservation.reservedTokens });
    await expect(
      invoke({ ...request, maxOutputTokens: reservation.reservedTokens }),
    ).resolves.toMatchObject({
      status: "blocked",
      code: "budget_exhausted",
    });
    expect(countTokens).toHaveBeenCalledOnce();
    expect(infer).not.toHaveBeenCalled();
  });

  it("does not infer with a missing or malformed token count", async () => {
    const { request, infer, countTokens, bind } = setup();
    countTokens.mockResolvedValueOnce(Response.json({ object: "response.input_tokens" }));
    await expect(bind()(request)).resolves.toMatchObject({ status: "blocked" });
    expect(infer).not.toHaveBeenCalled();
  });

  it("reports measured usage but discards output when the upstream exceeds the count", async () => {
    const { request, infer, bind } = setup();
    infer.mockResolvedValueOnce(
      response({ usage: { input_tokens: 401, output_tokens: 100, total_tokens: 501 } }),
    );
    await expect(bind()(request)).resolves.toMatchObject({
      status: "blocked",
      code: "budget_exhausted",
      usage: { inputTokens: 401, outputTokens: 100, costUsd: 0.00075075 },
      providerReceiptId,
    });
  });

  it("keeps unrelated vault material off the provider connection", async () => {
    const { request, fetcher, decrypt, bind } = setup();
    for (const secret of [
      '{"access_token":"unrelated_subscription_token"}',
      "eyJhbGciOiJub25lIn0.unrelated.jwt",
      "sk-ant-unrelated-provider-key-fixture",
      "sk-or-v1-unrelated-provider-key-fixture",
    ]) {
      decrypt.mockReturnValueOnce(secret);
      await expect(bind()(request)).resolves.toMatchObject({ status: "blocked" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains known usage while blocking a completed output with unavailable usage", async () => {
    const { request, infer, bind } = setup();
    infer.mockResolvedValueOnce(
      response({
        usage: { input_tokens: 23, output_tokens: "100", total_tokens: 30_000, cost_usd: 0.001 },
      }),
    );
    await expect(bind()(request)).resolves.toMatchObject({
      status: "blocked",
      code: "provider_unavailable",
      usage: { inputTokens: 23, outputTokens: null, costUsd: null },
    });

    infer.mockResolvedValueOnce(
      response({ usage: { input_tokens: 1, output_tokens: 1, total_tokens: 99 } }),
    );
    await expect(bind()(request)).resolves.toMatchObject({ usage: unknownUsage });
  });

  it.each([
    ["incomplete inference", { status: "incomplete" }],
    ["a provider refusal", { output: [{ ...assistantMessage(), content: [{ type: "refusal" }] }] }],
    ["a tool call", { output: [assistantMessage(), { type: "function_call", name: "delegate" }] }],
    ["multiple assistant messages", { output: [assistantMessage(), assistantMessage()] }],
  ])("blocks %s while preserving attributable usage", async (_, overrides) => {
    const { request, infer, bind } = setup();
    infer.mockResolvedValueOnce(response(overrides));

    await expect(bind()(request)).resolves.toEqual({
      status: "blocked",
      code: "provider_unavailable",
      usage: measured,
      providerReceiptId,
    });
  });

  it("discards a different model or unsafe receipt without attributing provider usage", async () => {
    const { request, infer, bind } = setup();
    infer.mockResolvedValueOnce(response({ model: "gpt-5" }));
    infer.mockResolvedValueOnce(response({ id: `resp_${apiKey}` }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(bind()(request)).resolves.toEqual({
        status: "blocked",
        code: "provider_unavailable",
        usage: unknownUsage,
      });
    }
  });

  it("discards decoded and escaped known credentials from the provider transcript", async () => {
    const { request, infer, bind } = setup();
    const escapedKey = apiKey.replace("s", "\\u0073");
    infer.mockResolvedValueOnce(
      response({ output: [assistantMessage(`{"result":"${escapedKey}"}`)] }),
    );

    await expect(bind()(request)).resolves.toEqual({
      status: "blocked",
      code: "provider_unavailable",
      usage: measured,
      providerReceiptId,
    });
  });

  it("cancels an oversized body even when the server reports a small length", async () => {
    const { request, infer, bind } = setup();
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(128 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    infer.mockResolvedValueOnce(
      new Response(stream, {
        headers: { "Content-Type": "application/json", "Content-Length": "1" },
      }),
    );

    await expect(bind()(request)).resolves.toEqual({
      status: "blocked",
      code: "provider_unavailable",
      usage: unknownUsage,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("blocks before credential access at an expired or canceled issuance", async () => {
    const { issue, request, fetcher, decrypt, bind } = setup();
    const expired = { ...issue, deadlineAt: new Date(Date.now() - 1).toISOString() };
    await expect(bind(expired)(request)).resolves.toMatchObject({ code: "timeout" });

    const signal = AbortSignal.abort();
    await expect(bind()({ ...request, signal })).resolves.toMatchObject({ code: "timeout" });
    expect(decrypt).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("settles an aborted stalled fetch once without retrying", async () => {
    const { request, fetcher, bind } = setup();
    const cancel = new AbortController();
    fetcher.mockReturnValueOnce(new Promise(() => {}));
    const invoke = bind();

    const running = invoke({ ...request, signal: cancel.signal });
    expect(fetcher).toHaveBeenCalledOnce();
    cancel.abort();
    await expect(running).resolves.toEqual({
      status: "blocked",
      code: "timeout",
      usage: unknownUsage,
    });
    await expect(invoke(request)).resolves.toMatchObject({ status: "blocked" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("returns a generic status when the upstream error includes its credential", async () => {
    const { request, fetcher, bind } = setup();
    fetcher.mockRejectedValueOnce(new Error(`Upstream error: ${apiKey}`));
    await expect(bind()(request)).resolves.toEqual({
      status: "blocked",
      code: "provider_unavailable",
      usage: unknownUsage,
    });
  });
});

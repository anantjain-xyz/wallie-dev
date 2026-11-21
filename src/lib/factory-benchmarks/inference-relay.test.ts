import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { runInNewContext } from "node:vm";

import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/internal/benchmark-openai/[...path]/route";
import { FakeSandbox } from "@/lib/sandbox/fake";
import type { Database } from "@/lib/supabase/database.types";

import { relayBenchmarkInference, type BenchmarkInferenceRelayStore } from "./inference-relay";
import { bindQualifiedSandbox } from "./qualified-sandbox-binding";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.admin,
}));

const bindUrl = "https://api.openai.com/.well-known/wallie-benchmark-bind";
const responsesUrl = "https://api.openai.com/v1/responses";
const model = "gpt-4.1-2025-04-14";
const requestId = "73500000-0000-4000-8000-000000000001";
const identity = { teamId: "team_fixture", projectId: "prj_fixture", sandboxId: "sbx_fixture" };

function request(body: unknown, url = responsesUrl) {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer sandbox-placeholder",
      Cookie: "private=fixture",
      "OpenAI-Organization": "org-untrusted",
    },
    body: JSON.stringify(body),
  });
}

function fixture() {
  const store = {
    bind: vi.fn<BenchmarkInferenceRelayStore["bind"]>().mockResolvedValue(true),
    begin: vi.fn<BenchmarkInferenceRelayStore["begin"]>().mockImplementation(async () => ({
      requestId,
      model,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      encryptedApiKey: "sealed-fixture",
    })),
    finish: vi.fn<BenchmarkInferenceRelayStore["finish"]>().mockResolvedValue(true),
    isOpen: vi.fn<BenchmarkInferenceRelayStore["isOpen"]>().mockResolvedValue(true),
  };
  const fetch = vi.fn<typeof globalThis.fetch>();
  const decrypt = vi.fn<(value: string) => string>().mockReturnValue("provider-fixture");
  const relay = (request: Request, signal?: AbortSignal) =>
    relayBenchmarkInference(request, identity, { store, fetch, decrypt, signal });
  return { relay, store, fetch, decrypt };
}

function event(type: string, fields: Record<string, unknown>, separator = "\n") {
  return ["event: " + type, "data: " + JSON.stringify({ type, ...fields }), "", ""].join(separator);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mocks.admin.mockReset();
  mocks.rpc.mockReset();
});

describe("benchmark inference relay", () => {
  it("requires Vercel proxy authentication before reading secrets", async () => {
    const response = await POST(
      request(
        { model, input: "task" },
        "https://wallie.test/api/internal/benchmark-openai/v1/responses",
      ),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("binds the signed sandbox and denies its actual files probe through the POST route", async () => {
    const issuer = "https://oidc.vercel.com/benchmark-relay-test";
    const audience = "https://wallie.test/api/internal/benchmark-openai";
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const claims = {
      iss: issuer,
      aud: audience,
      exp: Math.floor(Date.now() / 1_000) + 60,
      team_id: identity.teamId,
      project_id: identity.projectId,
      sandbox_id: identity.sandboxId,
    };
    const signed = [{ alg: "RS256", kid: "relay-fixture" }, claims]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    const token =
      signed + "." + sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url");
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "relay-fixture", alg: "RS256" };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => {
      expect(String(url)).toBe(issuer + "/.well-known/jwks");
      return Response.json({ keys: [jwk] });
    });
    vi.stubGlobal("fetch", fetch);
    mocks.admin.mockReturnValue({ rpc: mocks.rpc });
    mocks.rpc.mockReturnValue({ abortSignal: async () => ({ data: true, error: null }) });

    let nonceDigest: unknown;
    const admin = createClient<Database>("https://db.example.test", "test-key", {
      auth: { persistSession: false },
      global: {
        fetch: async (url, init) => {
          const rpcName = new URL(String(url)).pathname.split("/").at(-1);
          if (rpcName === "arm_factory_benchmark_live_sandbox_binding") {
            nonceDigest = JSON.parse(String(init?.body)).p_nonce_sha256;
            return Response.json(true);
          }
          expect(rpcName).toBe("read_factory_benchmark_live_sandbox_binding");
          return Response.json({ signedSandboxId: identity.sandboxId });
        },
      },
    });
    const forwarded: Array<{ path: string; method: string; status: number }> = [];
    const fetchInSandbox = async (url: string, init: RequestInit) => {
      const target = new URL(url);
      if (target.hostname !== "api.openai.com") {
        expect(init.method).toBe("HEAD");
        throw new TypeError("Blocked by sandbox firewall");
      }
      const headers = new Headers(init.headers);
      if (target.pathname === "/v1/files") {
        expect(headers.has("authorization")).toBe(false);
        expect(init.body).toBeUndefined();
      }
      headers.set("vercel-forwarded-host", target.hostname);
      headers.set("vercel-forwarded-scheme", "https");
      headers.set("vercel-forwarded-port", "443");
      headers.set("vercel-forwarded-path", target.pathname);
      headers.set("vercel-sandbox-oidc-token", token);
      const method = init.method ?? "GET";
      // The Next route exports only POST. Non-POST requests never reach the SDK.
      const response =
        method === "POST"
          ? await POST(
              new Request(audience + target.pathname, { method, headers, body: init.body }),
            )
          : new Response(null, { status: 405 });
      forwarded.push({ path: target.pathname, method, status: response.status });
      return response;
    };
    const sandbox = new FakeSandbox();
    const exec = sandbox.exec.bind(sandbox);
    vi.spyOn(sandbox, "exec").mockImplementation(async (command, args = [], options) => {
      if (command !== "node") return exec(command, args, options);
      const program = { argv: [command, ...args.slice(3)], exitCode: 1 };
      await runInNewContext(args[1], {
        AbortSignal,
        fetch: fetchInSandbox,
        process: program,
        require: () => ({
          readFileSync: (file: string) => sandbox.files.get(file)?.data.toString("utf8"),
          unlinkSync: (file: string) => sandbox.files.delete(file),
        }),
      });
      sandbox.scriptExec(command, [], { exitCode: program.exitCode });
      return exec(command, args, options);
    });

    await expect(
      bindQualifiedSandbox({
        admin,
        sandbox,
        identity: {
          trialId: requestId,
          jobId: requestId,
          runId: requestId,
          attemptCount: 1,
          workspaceId: requestId,
          factoryId: requestId,
          sessionId: requestId,
          actorUserId: requestId,
        },
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(identity.sandboxId);
    expect(forwarded).toEqual([
      { path: "/.well-known/wallie-benchmark-bind", method: "POST", status: 204 },
      { path: "/v1/files", method: "POST", status: 403 },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.admin).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
      "consume_factory_benchmark_live_sandbox_binding",
      {
        p_team_id: identity.teamId,
        p_project_id: identity.projectId,
        p_signed_sandbox_id: identity.sandboxId,
        p_nonce_sha256: nonceDigest,
      },
    );
  });

  it("consumes only a hashed nonce with the signed sandbox identity", async () => {
    const proof = fixture();
    const nonce = "n".repeat(43);
    const response = await proof.relay(request({ nonce }, bindUrl));
    expect(response.status).toBe(204);
    expect(proof.store.bind).toHaveBeenCalledExactlyOnceWith(
      identity,
      createHash("sha256").update(nonce).digest("hex"),
      expect.any(AbortSignal),
    );
    expect(proof.store.begin).not.toHaveBeenCalled();
    expect(proof.fetch).not.toHaveBeenCalled();

    proof.store.bind.mockResolvedValueOnce(false);
    expect((await proof.relay(request({ nonce }, bindUrl))).status).toBe(403);
  });

  it.each([
    "https://api.openai.com/v1/responses?stream=true",
    "https://api.openai.com/v1/files",
    "https://api.openai.com:444/v1/responses",
    "http://api.openai.com/v1/responses",
    "https://sub.api.openai.com/v1/responses",
    "https://api.openai.com/v1/responses/",
  ])("rejects a proxied URL outside the exact surface", async (url) => {
    const proof = fixture();
    expect((await proof.relay(request({ model, input: "task" }, url))).status).toBe(403);
    expect(proof.store.begin).not.toHaveBeenCalled();
    expect(proof.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { previous_response_id: "resp_external" },
    { conversation: "conv_cached" },
    { prompt: { id: "pmpt_external" } },
    { background: true },
    { tools: [{ type: "web_search" }] },
    { tools: [{ type: "mcp", server_url: "https://tools.test" }] },
    {
      tools: [
        {
          type: "function",
          name: "read",
          parameters: { $ref: "https://tools.test/remote-schema" },
        },
      ],
    },
    { input: [{ role: "user", content: [{ type: "input_file", file_id: "file_fixture" }] }] },
    {
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "https://assets.test/image" }],
        },
      ],
    },
    { input: [{ type: "item_reference", id: "msg_existing" }] },
  ])("rejects requests with remote or server-stored context", async (extra) => {
    const proof = fixture();
    const response = await proof.relay(request({ model, input: "task", ...extra }));
    expect(response.status).toBe(400);
    expect(proof.store.begin).not.toHaveBeenCalled();
    expect(proof.fetch).not.toHaveBeenCalled();
  });

  it("bounds the request before allocating inference authority", async () => {
    const proof = fixture();
    const response = await proof.relay(request({ model, input: "x".repeat(1024 * 1024) }));
    expect(response.status).toBe(413);
    expect(proof.store.begin).not.toHaveBeenCalled();
  });

  it("uses only the fixed endpoint and relay credential and settles exact measured usage", async () => {
    const proof = fixture();
    const payload = { model, status: "completed", usage: { input_tokens: 5, output_tokens: 3 } };
    proof.fetch.mockResolvedValueOnce(
      Response.json(payload, { headers: { "set-cookie": "secret=upstream" } }),
    );
    const response = await proof.relay(
      request({
        model,
        input: [{ role: "user", content: [{ type: "input_text", text: "task" }] }],
        parallel_tool_calls: true,
        tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
        store: true,
        prompt_cache_key: "local-thread",
        prompt_cache_options: { ttl: "5m" },
        client_metadata: { threadId: "local-thread" },
        stream_options: { include_obfuscation: true },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(response.headers.get("set-cookie")).toBeNull();
    const [url, sent] = proof.fetch.mock.calls[0];
    expect(url).toBe(responsesUrl);
    expect(sent?.redirect).toBe("error");
    expect(Object.fromEntries(new Headers(sent?.headers))).toEqual({
      accept: "application/json",
      authorization: "Bearer provider-fixture",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(sent?.body))).toMatchObject({ model, store: false });
    const sentBody = JSON.parse(String(sent?.body));
    expect(sentBody).not.toHaveProperty("prompt_cache_key");
    expect(sentBody).not.toHaveProperty("prompt_cache_options");
    expect(sentBody).not.toHaveProperty("client_metadata");
    expect(sentBody).not.toHaveProperty("stream_options");
    expect(proof.store.begin).toHaveBeenCalledWith(
      identity,
      createHash("sha256").update(String(sent?.body)).digest("hex"),
      expect.any(AbortSignal),
    );
    expect(proof.decrypt).toHaveBeenCalledWith("sealed-fixture");
    expect(proof.store.finish).toHaveBeenCalledExactlyOnceWith(
      requestId,
      { status: "completed", observedModel: model, inputTokens: 5, outputTokens: 3 },
      expect.any(AbortSignal),
    );
  });

  it("does not dispatch an unauthorized attempt or a different requested model", async () => {
    const proof = fixture();
    proof.store.begin.mockResolvedValueOnce(null);
    expect((await proof.relay(request({ model, input: "task" }))).status).toBe(403);
    expect((await proof.relay(request({ model: "gpt-4o-2024-11-20", input: "task" }))).status).toBe(
      403,
    );
    expect(proof.fetch).not.toHaveBeenCalled();
    expect(proof.store.finish).toHaveBeenCalledExactlyOnceWith(
      requestId,
      { status: "failed" },
      expect.any(AbortSignal),
    );
  });

  it("discards mismatched model output and retains exact completion with unknown usage", async () => {
    const proof = fixture();
    proof.fetch.mockResolvedValueOnce(
      Response.json({ model: "gpt-4o-2024-11-20", status: "completed", output: ["private"] }),
    );
    const mismatch = await proof.relay(request({ model, input: "task" }));
    expect(mismatch.status).toBe(502);
    expect(await mismatch.text()).toBe("");
    proof.fetch.mockResolvedValueOnce(Response.json({ model, status: "completed", usage: null }));
    expect((await proof.relay(request({ model, input: "task" }))).status).toBe(200);
    expect(proof.store.finish.mock.calls.map((call) => call[1])).toEqual([
      { status: "failed" },
      { status: "completed", observedModel: model },
    ]);
  });

  it("streams verified split events and settles before forwarding the terminal result", async () => {
    const proof = fixture();
    const allowSettlement = Promise.withResolvers<boolean>();
    const settlementStarted = Promise.withResolvers<void>();
    proof.store.finish.mockImplementationOnce(() => {
      settlementStarted.resolve();
      return allowSettlement.promise;
    });
    const created = event(
      "response.created",
      { response: { model, status: "in_progress" } },
      "\r\n",
    );
    const delta = event("response.output_text.delta", { delta: "draft" });
    const complete = event("response.completed", {
      response: { model, status: "completed", usage: { input_tokens: 0, output_tokens: 6 } },
    });
    const payload = created + delta + complete;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload.slice(0, 27)));
        controller.enqueue(new TextEncoder().encode(payload.slice(27)));
        controller.close();
      },
    });
    proof.fetch.mockResolvedValueOnce(
      new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    );
    const result = await proof.relay(request({ model, input: "task", stream: true }));
    expect(result.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = result.body?.getReader();
    if (!reader) throw new Error("Missing inference stream.");
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain("event: response.created");
    expect(decoder.decode((await reader.read()).value)).toContain(
      "event: response.output_text.delta",
    );
    const terminal = reader.read();
    let terminalSent = false;
    void terminal.then(() => {
      terminalSent = true;
    });
    await settlementStarted.promise;
    expect(terminalSent).toBe(false);
    allowSettlement.resolve(true);
    expect(decoder.decode((await terminal).value)).toContain("event: response.completed");
    expect((await reader.read()).done).toBe(true);
    expect(proof.store.finish).toHaveBeenCalledExactlyOnceWith(
      requestId,
      { status: "completed", observedModel: model, inputTokens: 0, outputTokens: 6 },
      expect.any(AbortSignal),
    );
  });

  it("drops unverified stream content and handles a missing terminal frame", async () => {
    const proof = fixture();
    proof.fetch
      .mockResolvedValueOnce(
        new Response(event("response.output_text.delta", { delta: "unverified" }), {
          headers: { "Content-Type": "text/event-stream" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(event("response.created", { response: { model, status: "in_progress" } }), {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    for (let index = 0; index < 2; index++) {
      const response = await proof.relay(request({ model, input: "task", stream: true }));
      await expect(response.text()).rejects.toThrow("stream did not complete");
    }
    expect(proof.store.finish.mock.calls.map((call) => call[1])).toEqual([
      { status: "unavailable" },
      { status: "unavailable" },
    ]);
  });

  it("polls scope and aborts an in-flight request when the exact lease closes", async () => {
    vi.useFakeTimers();
    const proof = fixture();
    proof.store.isOpen.mockResolvedValueOnce(false);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    proof.fetch.mockImplementationOnce(async (_url, init) => {
      ready();
      const signal = init?.signal;
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("canceled")), { once: true });
      });
    });
    const pending = proof.relay(request({ model, input: "task" }));
    await started;
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).status).toBe(502);
    expect(proof.store.isOpen).toHaveBeenCalledExactlyOnceWith(requestId, expect.any(AbortSignal));
    expect(proof.store.finish).toHaveBeenCalledExactlyOnceWith(
      requestId,
      { status: "unavailable" },
      expect.any(AbortSignal),
    );
  });
});

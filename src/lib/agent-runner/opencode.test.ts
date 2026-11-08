import { describe, expect, it, vi } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";
import { harnessPath, runnerCalls } from "./test-helpers";

import { OpenCodeRunner, parseOpenCodeLine } from "./opencode";

const credential = { secret: "zen-secret-key-1234567890" };

describe("OpenCodeRunner", () => {
  it.each([
    { progress: [] },
    { progress: ["Inspecting the implementation", "Tests are still running"] },
  ])(
    "publishes every text part in the final stop step and retains prior activity (%j)",
    async ({ progress }) => {
      const finalParts = [
        `\n# Delivered\n\n${"Validation passed. ".repeat(1_000)}`,
        "Blocker: publication requires credentials.  \n\n",
      ];
      const records = [
        ...progress.flatMap((text, index) => [
          { type: "step_start", part: { messageID: `progress-${index}` } },
          { type: "text", part: { id: `text-${index}`, messageID: `progress-${index}`, text } },
          {
            type: "step_finish",
            part: {
              messageID: `progress-${index}`,
              reason: "tool-calls",
              tokens: { input: 10, output: 4 },
            },
          },
        ]),
        { type: "step_start", part: { messageID: "final" } },
        ...finalParts.map((text, index) => ({
          type: "text",
          part: { id: `final-${index}`, messageID: "final", text },
        })),
        // Repeated part updates must not duplicate the final response.
        { type: "text", part: { id: "final-1", messageID: "final", text: finalParts[1] } },
        {
          type: "step_finish",
          part: { messageID: "final", reason: "stop", tokens: { input: 10, output: 4 } },
        },
      ];
      const sandbox = new FakeSandbox();
      sandbox.scriptExec("bash", [
        { stream: "stdout", data: records.map((record) => JSON.stringify(record)).join("\n") },
      ]);
      const events = [];
      for await (const event of new OpenCodeRunner({ credential }).start({
        sandbox,
        sessionId: "final-output",
        prompt: "p",
      }))
        events.push(event);

      expect(events.filter((event) => event.type === "progress")).toEqual([
        ...progress.map((text) => ({ type: "progress", text })),
        ...[...finalParts, finalParts[1]].map((text) => ({ type: "progress", text })),
      ]);
      expect(events.at(-1)).toEqual({
        type: "completion",
        taskComplete: true,
        summary: "OpenCode session completed",
        finalOutput: finalParts.join("\n"),
        usage: {
          inputTokens: 10 * (progress.length + 1),
          outputTokens: 4 * (progress.length + 1),
          provenance: "measured",
        },
      });
    },
  );

  it.each([
    { reason: "tool-calls", messageID: "message", hasText: true, beginsAnotherStep: false },
    { reason: "stop", messageID: undefined, hasText: true, beginsAnotherStep: false },
    { reason: "stop", messageID: "message", hasText: false, beginsAnotherStep: false },
    { reason: "stop", messageID: "message", hasText: true, beginsAnotherStep: true },
  ])(
    "does not promote partial or unidentified output to a final deliverable (%j)",
    async ({ reason, messageID, hasText, beginsAnotherStep }) => {
      const sandbox = new FakeSandbox();
      const records = [
        ...(hasText
          ? [{ type: "text", part: { id: "text", messageID, text: "Tests are still running" } }]
          : []),
        { type: "step_finish", part: { messageID, reason, tokens: { input: 3, output: 2 } } },
        ...(beginsAnotherStep ? [{ type: "step_start", part: { messageID: "next" } }] : []),
      ];
      sandbox.scriptExec("bash", [
        { stream: "stdout", data: records.map((record) => JSON.stringify(record)).join("\n") },
      ]);
      const events = [];
      for await (const event of new OpenCodeRunner({ credential }).start({
        sandbox,
        sessionId: "missing-final",
        prompt: "p",
      }))
        events.push(event);
      expect(events.at(-1)).toMatchObject({
        type: "completion",
        usage: { inputTokens: 3, outputTokens: 2 },
      });
      expect(events.at(-1)).not.toHaveProperty("finalOutput");
      if (hasText) expect(events[0]).toEqual({ type: "progress", text: "Tests are still running" });
    },
  );

  it.each([0, 7])(
    "retains usage and activity when an error follows final text (exit %i)",
    async (exitCode) => {
      const sandbox = new FakeSandbox();
      const records = [
        {
          type: "text",
          part: { id: "text", messageID: "final", text: "Delivered; blocker remains" },
        },
        {
          type: "step_finish",
          part: { messageID: "final", reason: "stop", tokens: { input: 3, output: 2 } },
        },
        { type: "error", message: "Provider stopped" },
      ];
      sandbox.scriptExec(
        "bash",
        [{ stream: "stdout", data: records.map((record) => JSON.stringify(record)).join("\n") }],
        { exitCode },
      );
      const events = [];
      for await (const event of new OpenCodeRunner({ credential }).start({
        sandbox,
        sessionId: "error-final",
        prompt: "p",
      }))
        events.push(event);
      expect(events[0]).toEqual({ type: "progress", text: "Delivered; blocker remains" });
      expect(events[1]).toMatchObject({
        type: "completion",
        taskComplete: false,
        usage: { inputTokens: 3, outputTokens: 2 },
      });
      expect(events[1]).not.toHaveProperty("finalOutput");
      expect(events.some((event) => event.type === "completion" && event.taskComplete)).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "error" });
    },
  );

  it("requires a matching credential for the configured model provider", async () => {
    expect(() => new OpenCodeRunner({ credential: { secret: "" } })).toThrow(
      /OpenCode Zen API key/,
    );
    expect(
      () =>
        new OpenCodeRunner({
          model: "opencode-go/glm-5.3",
          credential: { secret: "zen-secret-key-1234567890" },
        }),
    ).toThrow(/API key for provider "opencode-go"/);
    expect(() => new OpenCodeRunner({ model: "gpt-5.6-sol" })).toThrow(
      /"<provider-id>\/<model-id>"/,
    );

    const runner = new OpenCodeRunner({ credential });
    expect(runner.provider).toBe("opencode");
    expect(runner.requiresSandbox).toBe(true);
    await expect(
      (async () => {
        for await (const event of runner.start({ prompt: "p", sessionId: "s" })) {
          void event;
        }
      })(),
    ).rejects.toThrow(/requires a sandbox/);
  });

  it.each(["opencode/gpt-5.6-sol", "opencode-go/glm-5.3"])(
    "blocks %s authentication when the creator is removed during prompt setup",
    async (model) => {
      const sandbox = new FakeSandbox();
      let activeMember = true;
      let beginPromptWrite!: () => void;
      const promptWriteStarted = new Promise<void>((resolve) => {
        beginPromptWrite = resolve;
      });
      let finishPromptWrite!: () => void;
      const promptWriteFinished = new Promise<void>((resolve) => {
        finishPromptWrite = resolve;
      });
      const writeFile = sandbox.writeFile.bind(sandbox);
      const write = vi.spyOn(sandbox, "writeFile").mockImplementation(async (path, data, opts) => {
        if (path.endsWith("/prompt.txt")) {
          beginPromptWrite();
          await promptWriteFinished;
        }
        await writeFile(path, data, opts);
      });
      const loadAuth = vi.fn(async () => {
        if (!activeMember) throw new Error("Session creator is no longer an active member");
        return { credential, providerCredentials: { "opencode-go": credential } };
      });
      const runner = new OpenCodeRunner({ model, loadAuth });
      const running = (async () => {
        for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "revoked" })) {
          void event;
        }
      })();

      await promptWriteStarted;
      expect(loadAuth).not.toHaveBeenCalled();
      expect(runnerCalls(sandbox)).toHaveLength(0);
      activeMember = false;
      finishPromptWrite();

      await expect(running).rejects.toThrow("Session creator is no longer an active member");
      expect(loadAuth).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledTimes(1);
      expect(sandbox.files.has(harnessPath(sandbox, "data/opencode/auth.json"))).toBe(false);
      expect(runnerCalls(sandbox)).toHaveLength(0);
    },
  );

  it.each(["opencode/gpt-5.6-sol", "opencode-go/glm-5.3"])(
    "does not fall back to eager credentials when current %s authentication is unavailable",
    async (model) => {
      const sandbox = new FakeSandbox();
      const runner = new OpenCodeRunner({
        model,
        credential,
        providerCredentials: { "opencode-go": credential },
        loadAuth: async () => ({}),
      });

      await expect(
        (async () => {
          for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "missing" })) {
            void event;
          }
        })(),
      ).rejects.toThrow(/requires an .*API key/);

      expect(sandbox.files.has(harnessPath(sandbox, "data/opencode/auth.json"))).toBe(false);
      expect(runnerCalls(sandbox)).toHaveLength(0);
    },
  );

  it("loads refreshed custom and optional Zen credentials after setup and redacts both", async () => {
    const sandbox = new FakeSandbox();
    const freshZenSecret = "fresh-zen-key-1234567890";
    const freshProviderSecret = "fresh-provider-key-1234567890";
    let currentAuth = {
      credential,
      providerCredentials: { "opencode-go": { secret: "old-provider-key-1234567890" } },
    };
    const writeFile = sandbox.writeFile.bind(sandbox);
    vi.spyOn(sandbox, "writeFile").mockImplementation(async (path, data, opts) => {
      if (path.endsWith("/prompt.txt")) {
        currentAuth = {
          credential: { secret: freshZenSecret },
          providerCredentials: { "opencode-go": { secret: freshProviderSecret } },
        };
      }
      await writeFile(path, data, opts);
    });
    sandbox.scriptExec("bash", [
      {
        data: `${JSON.stringify({ type: "text", part: { text: `${freshZenSecret} ${freshProviderSecret}` } })}\n`,
        stream: "stdout",
      },
    ]);
    const loadAuth = vi.fn(async () => currentAuth);
    const runner = new OpenCodeRunner({
      ...currentAuth,
      model: "opencode-go/glm-5.3",
      loadAuth,
    });
    const events = [];
    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "refreshed" })) {
      events.push(event);
    }

    const authPath = harnessPath(sandbox, "data/opencode/auth.json");
    expect(await sandbox.readFile(authPath)).toBe(
      `${JSON.stringify({
        opencode: { type: "api", key: freshZenSecret },
        "opencode-go": { type: "api", key: freshProviderSecret },
      })}\n`,
    );
    expect(sandbox.files.get(authPath)?.mode).toBe(0o600);
    expect(loadAuth).toHaveBeenCalledOnce();
    expect(runnerCalls(sandbox)).toHaveLength(1);
    expect(JSON.stringify(runnerCalls(sandbox))).not.toContain(freshZenSecret);
    expect(JSON.stringify(runnerCalls(sandbox))).not.toContain(freshProviderSecret);
    expect(events).toContainEqual({ type: "progress", text: "[REDACTED] [REDACTED]" });
    expect(JSON.stringify(events)).not.toContain(freshZenSecret);
    expect(JSON.stringify(events)).not.toContain(freshProviderSecret);
  });

  it("uses isolated auth, parses partial NDJSON, totals usage, and captures continuation", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data: `{"type":"text","sessionID":"native-42","part":{"text":"work`,
        stream: "stdout",
      },
      { data: `ing"}}\n{"type":"tool_use","sessionID":"native-42",`, stream: "stdout" },
      {
        data:
          `"part":{"tool":"bash","state":{"status":"completed",` +
          `"input":{"command":"ls"}}}}\n` +
          `{"type":"step_finish","sessionID":"native-42","part":{"tokens":{"input":10,"output":4}}}\n` +
          `{"type":"step_finish","sessionID":"native-42","part":{"tokens":{"input":7,"output":3}}}`,
        stream: "stdout",
      },
    ]);

    const runner = new OpenCodeRunner({
      credential,
      model: "opencode/gpt-5.6-sol",
    });
    const events = [];
    for await (const event of runner.start({
      continueSessionId: "native-previous",
      prompt: "Implement it",
      runId: "run/1",
      sandbox,
      sessionId: "session-1",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "progress", text: "working" },
      { type: "tool_use", tool: "bash", input: `{"command":"ls"}` },
      {
        type: "completion",
        taskComplete: true,
        summary: "OpenCode session: native-42",
        usage: { inputTokens: 17, outputTokens: 7, provenance: "measured" },
      },
    ]);

    const authPath = harnessPath(sandbox, "data/opencode/auth.json");
    const promptPath = harnessPath(sandbox, "prompt.txt");
    expect(await sandbox.readFile(authPath)).toBe(
      `${JSON.stringify({ opencode: { type: "api", key: credential.secret } })}\n`,
    );
    expect(sandbox.files.get(authPath)?.mode).toBe(0o600);
    expect(await sandbox.readFile(promptPath)).toBe("Implement it");
    expect(sandbox.files.get(promptPath)?.mode).toBe(0o600);

    const [call] = runnerCalls(sandbox);
    expect(call.cmd).toBe("bash");
    expect(call.args[1]).toContain(
      "opencode 'run' '--format' 'json' '--model' 'opencode/gpt-5.6-sol'",
    );
    expect(call.args[1]).not.toContain("'--auto'");
    expect(call.args[1]).toContain("'--session' 'native-previous'");
    expect(call.args[1]).toContain(`< '${promptPath}'`);
    expect(call.args.join(" ")).not.toContain(credential.secret);
    expect(call.opts.env).toMatchObject({
      CI: "1",
      XDG_DATA_HOME: harnessPath(sandbox, "data"),
    });
    expect(JSON.stringify(call.opts)).not.toContain(credential.secret);
  });

  it("includes cache reads and writes in normalized input usage", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data:
          `${JSON.stringify({ type: "step_finish", part: { tokens: { input: 10, output: 4, cache: { read: 800, write: 100 } } } })}\n` +
          JSON.stringify({
            type: "step_finish",
            part: { tokens: { input: 7, output: 3, cache: { read: 0, write: 100 } } },
          }),
        stream: "stdout",
      },
    ]);

    const runner = new OpenCodeRunner({ credential, model: "opencode/gpt-5.6-sol" });
    const events = [];
    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "completion",
        taskComplete: true,
        summary: "OpenCode session completed",
        usage: { inputTokens: 1_017, outputTokens: 7, provenance: "measured" },
      },
    ]);
  });

  it("marks aggregate cache/token overflow unavailable", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data:
          `${JSON.stringify({ type: "step_finish", part: { tokens: { input: Number.MAX_SAFE_INTEGER, output: 1, cache: { read: 0, write: 0 } } } })}\n` +
          JSON.stringify({ type: "step_finish", part: { tokens: { input: 1, output: 1 } } }),
        stream: "stdout",
      },
    ]);

    const runner = new OpenCodeRunner({ credential, model: "opencode/gpt-5.6-sol" });
    const events = [];
    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" })) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({ type: "completion", taskComplete: true });
    expect(events[0]).not.toHaveProperty("usage");
  });

  it("aggregates multi-step provider costs, including an explicit zero", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data:
          `${JSON.stringify({ type: "step_finish", part: { cost: 0, tokens: { input: 0, output: 0 } } })}\n` +
          JSON.stringify({
            type: "step_finish",
            part: { cost: 0.125, tokens: { input: 5, output: 2 } },
          }),
        stream: "stdout",
      },
    ]);

    const events = [];
    for await (const event of new OpenCodeRunner({ credential }).start({
      prompt: "p",
      sandbox,
      sessionId: "s",
    }))
      events.push(event);

    expect(events).toEqual([
      {
        type: "completion",
        taskComplete: true,
        summary: "OpenCode session completed",
        usage: {
          inputTokens: 5,
          outputTokens: 2,
          provenance: "measured",
          costUsd: 0.125,
          costProvenance: "measured",
        },
      },
    ]);
  });

  it("omits total cost when any usage-bearing step has missing or invalid cost", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data: [
          { cost: 0.1, tokens: { input: 1, output: 1 } },
          { tokens: { input: 2, output: 3 } },
          { cost: -1, tokens: { input: 4, output: 5 } },
        ]
          .map((part) => JSON.stringify({ type: "step_finish", part }))
          .join("\n"),
        stream: "stdout",
      },
    ]);

    const events = [];
    for await (const event of new OpenCodeRunner({ credential }).start({
      prompt: "p",
      sandbox,
      sessionId: "s",
    }))
      events.push(event);

    expect(events).toEqual([
      {
        type: "completion",
        taskComplete: true,
        summary: "OpenCode session completed",
        usage: { inputTokens: 7, outputTokens: 9, provenance: "measured" },
      },
    ]);
  });

  it("makes the entire token total unavailable when any step is malformed", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data: [
          { tokens: { input: 10, output: 4 } },
          { tokens: { input: -1, output: 2 } },
          { tokens: { input: 3 } },
        ]
          .map((part) => JSON.stringify({ type: "step_finish", part }))
          .join("\n"),
        stream: "stdout",
      },
    ]);

    const events = [];
    for await (const event of new OpenCodeRunner({ credential }).start({
      prompt: "p",
      sandbox,
      sessionId: "s",
    }))
      events.push(event);

    expect(events).toEqual([
      {
        type: "completion",
        taskComplete: true,
        summary: "OpenCode session completed",
      },
    ]);
  });

  it("preserves valid usage before a later CLI failure without marking task completion", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      "bash",
      [
        {
          data: JSON.stringify({
            type: "step_finish",
            part: { cost: 0.25, tokens: { input: 10, output: 4 } },
          }),
          stream: "stdout",
        },
        { data: "provider failed", stream: "stderr" },
      ],
      { exitCode: 7 },
    );

    const events = [];
    for await (const event of new OpenCodeRunner({ credential }).start({
      prompt: "p",
      sandbox,
      sessionId: "s",
    }))
      events.push(event);

    expect(events).toEqual([
      {
        type: "completion",
        taskComplete: false,
        summary: "OpenCode session ended unsuccessfully",
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          provenance: "measured",
          costUsd: 0.25,
          costProvenance: "measured",
        },
      },
      {
        type: "error",
        message: "opencode CLI exited with code 7: provider failed",
      },
    ]);
  });

  it("writes the custom provider key into auth.json and redacts it", async () => {
    const providerSecret = "opencode-go-secret-key-1234567890";
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data: `{"type":"text","part":{"text":"${providerSecret}"}}\n`,
        stream: "stdout",
      },
    ]);

    const runner = new OpenCodeRunner({
      model: "opencode-go/glm-5.3",
      providerCredentials: { "opencode-go": { secret: providerSecret } },
    });
    const events = [];
    for await (const event of runner.start({
      prompt: "Implement it",
      runId: "run-go",
      sandbox,
      sessionId: "session-1",
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "progress", text: "[REDACTED]" });
    expect(JSON.stringify(events)).not.toContain(providerSecret);

    const authPath = harnessPath(sandbox, "data/opencode/auth.json");
    expect(await sandbox.readFile(authPath)).toBe(
      `${JSON.stringify({ "opencode-go": { type: "api", key: providerSecret } })}\n`,
    );
    expect(runnerCalls(sandbox)[0].args[1]).toContain("'--model' 'opencode-go/glm-5.3'");
    expect(JSON.stringify(runnerCalls(sandbox)[0].opts)).not.toContain(providerSecret);
  });

  it("keeps the Zen entry when a custom provider model also has a Zen key", async () => {
    const providerSecret = "opencode-go-secret-key-1234567890";
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      { data: `{"type":"text","part":{"text":"ok"}}\n`, stream: "stdout" },
    ]);

    const runner = new OpenCodeRunner({
      credential,
      model: "opencode-go/glm-5.3",
      providerCredentials: { "opencode-go": { secret: providerSecret } },
    });
    for await (const event of runner.start({
      prompt: "p",
      runId: "run-both",
      sandbox,
      sessionId: "s",
    })) {
      void event;
    }

    expect(await sandbox.readFile(harnessPath(sandbox, "data/opencode/auth.json"))).toBe(
      `${JSON.stringify({
        opencode: { type: "api", key: credential.secret },
        "opencode-go": { type: "api", key: providerSecret },
      })}\n`,
    );
  });

  it("emits completed and failed tool events but ignores pending tool events", () => {
    expect(
      parseOpenCodeLine(
        `{"type":"tool_use","part":{"tool":"read","state":{"status":"pending","input":{}}}}`,
      ),
    ).toEqual({ events: [], sessionId: undefined });
    expect(
      parseOpenCodeLine(
        `{"type":"tool_use","part":{"tool":"read","state":{"status":"error","input":{"path":"x"}}}}`,
      ),
    ).toEqual({
      events: [{ type: "tool_use", tool: "read", input: `{"path":"x"}` }],
      sessionId: undefined,
    });
  });

  it("compacts bulky tool input before emitting it", () => {
    const secret = "tool-input-secret";
    const parsed = parseOpenCodeLine(
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "write",
          state: {
            status: "completed",
            input: {
              content: `${secret}${"x".repeat(20_000)}`,
              note: `${secret}${"y".repeat(20_000)}`,
              path: "src/large.ts",
            },
          },
        },
      }),
      [secret],
    );

    expect(parsed?.events).toEqual([
      {
        type: "tool_use",
        tool: "write",
        input: JSON.stringify({
          note: `[REDACTED]${"y".repeat(490)}…`,
          path: "src/large.ts",
        }),
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain(secret);
    expect(JSON.stringify(parsed)).not.toContain("x".repeat(100));

    const bounded = parseOpenCodeLine(
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "custom",
          state: {
            status: "completed",
            input: Object.fromEntries(
              Array.from({ length: 20 }, (_, index) => [`field${index}`, "z".repeat(2_000)]),
            ),
          },
        },
      }),
    );
    const boundedInput = (bounded?.events[0] as { input: string }).input;
    expect(boundedInput.length).toBeLessThanOrEqual(4_096);
    expect(boundedInput.endsWith("…[truncated]")).toBe(true);
  });

  it("emits a useful clipped non-zero error without exposing the credential", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      "bash",
      [{ data: `${"x".repeat(600)} ${credential.secret}`, stream: "stderr" }],
      { exitCode: 9 },
    );

    const runner = new OpenCodeRunner({ credential });
    const events = [];
    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    const message = (events[0] as { message: string }).message;
    expect(message).toContain("exited with code 9");
    expect(message).not.toContain(credential.secret);
    expect(message.length).toBeLessThan(550);
  });

  it("surfaces JSON error events and redacts the credential", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data: `${JSON.stringify({ type: "error", error: { message: `bad ${credential.secret}` } })}\n`,
        stream: "stdout",
      },
    ]);

    const runner = new OpenCodeRunner({ credential });
    const events = [];
    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" })) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "error", message: "bad [REDACTED]" }]);
  });

  it("delivers failed-run usage before a deferred JSON error", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data:
          `${JSON.stringify({ type: "step_finish", part: { tokens: { input: 3, output: 2 } } })}\n` +
          JSON.stringify({ type: "error", message: "provider stopped" }),
        stream: "stdout",
      },
    ]);

    const events = [];
    for await (const event of new OpenCodeRunner({ credential }).start({
      prompt: "p",
      sandbox,
      sessionId: "s",
    }))
      events.push(event);

    expect(events).toEqual([
      {
        type: "completion",
        taskComplete: false,
        summary: "OpenCode session ended unsuccessfully",
        usage: { inputTokens: 3, outputTokens: 2, provenance: "measured" },
      },
      { type: "error", message: "provider stopped" },
    ]);
  });

  it("redacts credentials echoed in text and tool input events", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data:
          `{"type":"text","part":{"text":"${credential.secret}"}}\n` +
          `{"type":"tool_use","part":{"tool":"echo","state":{"status":"completed","input":{"key":"${credential.secret}"}}}}\n`,
        stream: "stdout",
      },
    ]);

    const runner = new OpenCodeRunner({ credential });
    const events = [];
    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" })) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "progress", text: "[REDACTED]" });
    expect(events).toContainEqual({
      type: "tool_use",
      tool: "echo",
      input: '{"key":"[REDACTED]"}',
    });
    expect(JSON.stringify(events)).not.toContain(credential.secret);
  });

  it("redacts caller-supplied secrets from streamed output", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data: `{"type":"text","part":{"text":"github-secret"}}\n`,
        stream: "stdout",
      },
    ]);

    const runner = new OpenCodeRunner({ credential });
    const events = [];
    for await (const event of runner.start({
      prompt: "p",
      sandbox,
      secrets: ["github-secret"],
      sessionId: "s",
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "progress", text: "[REDACTED]" });
  });
});

describe("parseOpenCodeLine", () => {
  it("ignores malformed lines", () => {
    expect(parseOpenCodeLine("not json")).toBeNull();
    expect(parseOpenCodeLine("   ")).toBeNull();
  });

  it("parses nested error messages", () => {
    expect(
      parseOpenCodeLine(
        `{"type":"error","sessionID":"s1","error":{"data":{"message":"provider unavailable"}}}`,
      ),
    ).toEqual({
      events: [{ type: "error", message: "provider unavailable" }],
      sessionId: "s1",
    });
  });

  it("parses measured per-step usage and cost without converting zero to absence", () => {
    expect(
      parseOpenCodeLine(
        JSON.stringify({
          type: "step_finish",
          part: { cost: 0, tokens: { input: 0, output: 0 } },
        }),
      ),
    ).toEqual({
      events: [],
      sessionId: undefined,
      messageId: undefined,
      step: { kind: "finish", reason: "" },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        provenance: "measured",
        costUsd: 0,
        costProvenance: "measured",
      },
    });
  });

  it.each([
    {},
    { tokens: {} },
    { tokens: { input: 1 } },
    { tokens: { output: 1 } },
    { tokens: { input: -1, output: 1 } },
    { tokens: { input: 1, output: -1 } },
    { tokens: { input: 1.5, output: 1 } },
    { tokens: { input: Number.MAX_SAFE_INTEGER + 1, output: 1 } },
    { tokens: { input: Number.NaN, output: 1 } },
    { tokens: { input: 1, output: Number.POSITIVE_INFINITY } },
    { tokens: { input: "1", output: 1 } },
    { tokens: { input: 1, output: 1, cache: { read: -1, write: 0 } } },
    { tokens: { input: 1, output: 1, cache: { read: 0, write: 1.5 } } },
    { tokens: { input: 1, output: 1, cache: { read: Number.MAX_SAFE_INTEGER, write: 1 } } },
  ])("marks malformed or partial OpenCode token telemetry invalid: %j", (part) => {
    expect(parseOpenCodeLine(JSON.stringify({ type: "step_finish", part }))).toEqual({
      events: [],
      sessionId: undefined,
      messageId: undefined,
      step: { kind: "finish", reason: "" },
      usageInvalid: true,
    });
  });

  it.each([-0.01, Number.NaN, Number.POSITIVE_INFINITY, "0.1", null])(
    "omits invalid per-step cost %j without manufacturing zero",
    (cost) => {
      expect(
        parseOpenCodeLine(
          JSON.stringify({
            type: "step_finish",
            part: { cost, tokens: { input: 2, output: 3 } },
          }),
        ),
      ).toEqual({
        events: [],
        sessionId: undefined,
        messageId: undefined,
        step: { kind: "finish", reason: "" },
        usage: { inputTokens: 2, outputTokens: 3, provenance: "measured" },
      });
    },
  );

  it("captures session ids from event parts and top-level error messages", () => {
    expect(
      parseOpenCodeLine(`{"type":"text","part":{"sessionID":"part-session","text":"hello"}}`),
    ).toEqual({
      events: [{ type: "progress", text: "hello" }],
      sessionId: "part-session",
    });
    expect(parseOpenCodeLine(`{"type":"error","message":"failed"}`)).toEqual({
      events: [{ type: "error", message: "failed" }],
      sessionId: undefined,
    });
  });
});

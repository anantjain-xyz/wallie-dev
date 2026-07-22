import { describe, expect, it } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";
import { probeSandboxCapabilities } from "@/lib/sandbox-capabilities/probe";

type CapturedOutput = {
  exitCode?: number;
  stderr?: string;
  stdout?: string;
};

function scriptBaseSuccess(sandbox: FakeSandbox) {
  sandbox.scriptExec(
    (call) => call.args.join(" ").includes("git --version"),
    [{ data: "git version 2.45.0\n", stream: "stdout" }],
  );
  sandbox.scriptExec(
    (call) => call.args.join(" ").includes("node --version"),
    [{ data: "v22.0.0\n", stream: "stdout" }],
  );
  sandbox.scriptExec(
    (call) => call.args.join(" ").includes("for pm in"),
    [{ data: "npm 10.0.0\n", stream: "stdout" }],
  );
  sandbox.scriptExec(
    (call) => call.args.join(" ").includes("claude --version"),
    [{ data: "1.0.0\n", stream: "stdout" }],
  );
}

function scriptCodexBaseSuccess(sandbox: FakeSandbox) {
  sandbox.scriptExec(
    (call) => call.args.join(" ").includes("git --version"),
    [{ data: "git version 2.45.0\n", stream: "stdout" }],
  );
  sandbox.scriptExec(
    (call) => call.args.join(" ").includes("node --version"),
    [{ data: "v22.0.0\n", stream: "stdout" }],
  );
  sandbox.scriptExec(
    (call) => call.args.join(" ").includes("for pm in"),
    [{ data: "npm 10.0.0\n", stream: "stdout" }],
  );
  sandbox.scriptExec(
    (call) => call.args.join(" ").includes("codex --version"),
    [{ data: "codex-cli 0.132.0\n", stream: "stdout" }],
  );
}

function scriptCapturedOutput(sandbox: FakeSandbox, matcher: string, output: CapturedOutput) {
  sandbox.scriptExec(
    (call) => call.args.join(" ").includes(matcher),
    (call) => {
      const script = call.args[1] ?? "";
      const stdoutPath = script.match(/^stdout_path='([^']+)'$/m)?.[1];
      const stderrPath = script.match(/^stderr_path='([^']+)'$/m)?.[1];
      if (!stdoutPath || !stderrPath) {
        throw new Error("Capability probe capture paths were not found.");
      }
      sandbox.files.set(stdoutPath, { data: Buffer.from(output.stdout ?? "", "utf8") });
      sandbox.files.set(stderrPath, { data: Buffer.from(output.stderr ?? "", "utf8") });
      return [];
    },
    { exitCode: output.exitCode ?? 0 },
  );
}

describe("probeSandboxCapabilities", () => {
  it("reports a fully screenshot-capable sandbox", async () => {
    const sandbox = new FakeSandbox();
    scriptBaseSuccess(sandbox);
    sandbox.scriptExec(
      (call) => call.args.join(" ").includes("require.resolve('playwright')"),
      [{ data: "1.56.0\n", stream: "stdout" }],
    );
    sandbox.scriptExec(
      (call) => call.args.join(" ").includes("npx playwright install chromium"),
      [{ data: "chromium ready\n", stream: "stdout" }],
    );
    sandbox.scriptExec(
      (call) => call.args.join(" ").includes("Wallie screenshot smoke"),
      [{ data: "screenshot ok\n", stream: "stdout" }],
    );

    const report = await probeSandboxCapabilities({
      agentProvider: "claude-code",
      sandbox,
    });

    expect(report.git.ok).toBe(true);
    expect(report.agentCli.ok).toBe(true);
    expect(report.playwrightPackage.ok).toBe(true);
    expect(report.chromium.ok).toBe(true);
    expect(report.screenshotSmoke.ok).toBe(true);
    expect(
      sandbox.calls.some((call) =>
        call.args.join(" ").includes("Playwright screenshot smoke timed out after 60 seconds"),
      ),
    ).toBe(true);
  });

  it("reports Playwright as missing when bootstrap is disabled", async () => {
    const sandbox = new FakeSandbox();
    scriptBaseSuccess(sandbox);
    sandbox.scriptExec(
      (call) => call.args.join(" ").includes("require.resolve('playwright')"),
      [{ data: "missing\n", stream: "stderr" }],
      { exitCode: 1 },
    );

    const report = await probeSandboxCapabilities({
      agentProvider: "claude-code",
      bootstrapPlaywright: false,
      sandbox,
    });

    expect(report.playwrightPackage.ok).toBe(false);
    expect(report.chromium.detail).toMatch(/Skipped/);
    expect(report.screenshotSmoke.ok).toBe(false);
  });

  it("reports Codex external-sandbox command configuration without a model call", async () => {
    const sandbox = new FakeSandbox();
    scriptCodexBaseSuccess(sandbox);

    const report = await probeSandboxCapabilities({
      agentProvider: "codex",
      bootstrapPlaywright: false,
      sandbox,
    });

    expect(report.agentCli.ok).toBe(true);
    expect(report.codexExternalSandbox).toEqual({
      detail: "Codex command uses Vercel Sandbox as the execution boundary.",
      ok: true,
    });
    expect(sandbox.calls.every((call) => !call.args.join(" ").includes("codex 'exec'"))).toBe(true);
  });

  it("allows screenshot smoke success without output", async () => {
    const sandbox = new FakeSandbox();
    scriptBaseSuccess(sandbox);
    sandbox.scriptExec(
      (call) => call.args.join(" ").includes("require.resolve('playwright')"),
      [{ data: "1.56.0\n", stream: "stdout" }],
    );
    sandbox.scriptExec(
      (call) => call.args.join(" ").includes("npx playwright install chromium"),
      [{ data: "chromium ready\n", stream: "stdout" }],
    );
    sandbox.scriptExec((call) => call.args.join(" ").includes("Wallie screenshot smoke"), []);

    const report = await probeSandboxCapabilities({
      agentProvider: "claude-code",
      sandbox,
    });

    expect(report.screenshotSmoke.ok).toBe(true);
    expect(report.screenshotSmoke.detail).toBe("Playwright screenshot smoke passed.");
  });

  it("uses captured files when sandbox command output is lost", async () => {
    const sandbox = new FakeSandbox();
    scriptCapturedOutput(sandbox, "git --version", { stdout: "git version 2.45.0\n" });
    scriptCapturedOutput(sandbox, "node --version", { stdout: "v22.0.0\n" });
    scriptCapturedOutput(sandbox, "for pm in", { stdout: "npm 10.0.0\n" });
    scriptCapturedOutput(sandbox, "claude --version", { stdout: "1.0.0\n" });
    scriptCapturedOutput(sandbox, "require.resolve('playwright')", { stdout: "1.56.0\n" });
    scriptCapturedOutput(sandbox, "npx playwright install chromium", {});
    scriptCapturedOutput(sandbox, "Wallie screenshot smoke", {});

    const report = await probeSandboxCapabilities({
      agentProvider: "claude-code",
      sandbox,
    });

    expect(report.git.detail).toBe("git version 2.45.0");
    expect(report.node.detail).toBe("v22.0.0");
    expect(report.packageManager.detail).toBe("npm 10.0.0");
    expect(report.agentCli.ok).toBe(true);
    expect(report.playwrightPackage.ok).toBe(true);
    expect(report.chromium).toEqual({
      detail: "Chromium install completed successfully.",
      ok: true,
    });
    expect(report.screenshotSmoke.ok).toBe(true);
  });

  it("normalizes expected Chromium fallback build warnings", async () => {
    const sandbox = new FakeSandbox();
    scriptBaseSuccess(sandbox);
    sandbox.scriptExec(
      (call) => call.args.join(" ").includes("require.resolve('playwright')"),
      [{ data: "1.60.0\n", stream: "stdout" }],
    );
    sandbox.scriptExec(
      (call) => call.args.join(" ").includes("npx playwright install chromium"),
      [
        {
          data: [
            "BEWARE: your OS is not officially supported by Playwright; downloading fallback build for ubuntu24.04-x64.\n",
            "BEWARE: your OS is not officially supported by Playwright; downloading fallback build for ubuntu24.04-x64.\n",
          ].join(""),
          stream: "stdout",
        },
      ],
    );
    sandbox.scriptExec((call) => call.args.join(" ").includes("Wallie screenshot smoke"), []);

    const report = await probeSandboxCapabilities({
      agentProvider: "claude-code",
      sandbox,
    });

    expect(report.chromium).toEqual({
      detail: "Chromium install completed successfully using Playwright's fallback Linux build.",
      ok: true,
    });
  });

  it("treats exit-zero with empty output as failure", async () => {
    const sandbox = new FakeSandbox();

    const report = await probeSandboxCapabilities({
      agentProvider: "claude-code",
      bootstrapPlaywright: false,
      sandbox,
    });

    expect(report.git.ok).toBe(false);
    expect(report.git.detail).toBe("git not found");
    expect(report.node.ok).toBe(false);
    expect(report.node.detail).toBe("node not found");
    expect(report.packageManager.ok).toBe(false);
    expect(report.agentCli.ok).toBe(false);
  });

  it("bootstraps Playwright when the package is initially missing", async () => {
    const sandbox = new FakeSandbox();
    scriptBaseSuccess(sandbox);
    sandbox.scriptExec(
      (call) => call.args.join(" ").includes("require.resolve('playwright')"),
      [{ data: "missing\n", stream: "stderr" }],
      { exitCode: 1 },
    );
    sandbox.scriptExec(
      (call) => call.args.join(" ").includes("npm install --no-save playwright"),
      [{ data: "1.56.0\n", stream: "stdout" }],
    );
    sandbox.scriptExec(
      (call) => call.args.join(" ").includes("npx playwright install chromium"),
      [{ data: "chromium ready\n", stream: "stdout" }],
    );
    sandbox.scriptExec(
      (call) => call.args.join(" ").includes("Wallie screenshot smoke"),
      [{ data: "screenshot ok\n", stream: "stdout" }],
    );

    const report = await probeSandboxCapabilities({
      agentProvider: "claude-code",
      sandbox,
    });

    expect(report.playwrightPackage.ok).toBe(true);
    expect(report.screenshotSmoke.ok).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";
import { probeSandboxCapabilities } from "@/lib/sandbox-capabilities/probe";

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

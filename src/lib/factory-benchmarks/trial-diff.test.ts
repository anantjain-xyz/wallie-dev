import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { replaySha256 } from "./replay-contracts";
import { benchmarkEvidenceSensitiveValues, readPrivateBenchmarkDiff } from "./trial-diff";

describe("private benchmark diff", () => {
  let sandbox: FakeSandbox;

  beforeEach(() => {
    sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  });

  afterEach(async () => {
    await sandbox.stop();
  });

  function git(...args: string[]) {
    return execFileSync("git", args, { cwd: sandbox.repoPath, encoding: "utf8" }).trim();
  }

  function commit(bytes: string | Buffer) {
    writeFileSync(join(sandbox.repoPath, "change.txt"), bytes);
    git("add", "change.txt");
    git(
      "-c",
      "user.name=Trial Test",
      "-c",
      "user.email=trial@example.test",
      "commit",
      "-m",
      "fixture",
    );
    return { commitSha: git("rev-parse", "HEAD"), treeSha: git("rev-parse", "HEAD^{tree}") };
  }

  function compare(
    input: ReturnType<typeof commit>,
    output: ReturnType<typeof commit>,
    prompt = "",
  ) {
    return readPrivateBenchmarkDiff({
      sandbox: {
        repoPath: sandbox.repoPath,
        exec: (cmd, args, opts) => {
          const executableIndex = args.indexOf("node");
          const localArgs = [...args];
          // Use the test machine's Node path in place of the managed Linux image's.
          localArgs[executableIndex] = process.execPath;
          return sandbox.exec(cmd, localArgs, opts);
        },
      },
      commits: { input, output },
      signal: AbortSignal.timeout(10_000),
      deadlineMs: Date.now() + 20_000,
      sensitiveValues: benchmarkEvidenceSensitiveValues(prompt),
    });
  }

  it("reads exact commits with local drivers disabled and redacts the bounded patch", async () => {
    const prompt = "A synthetic private task instruction";
    const token = "sk-synthetic-secret-value";
    const before = commit("before\n");
    const after = commit(`after\n${prompt}\nOPENAI_API_KEY=${token}\n`);
    const marker = join(sandbox.repoPath, "driver-ran");
    const driver = join(sandbox.repoPath, ".git", "diff-driver.sh");
    writeFileSync(driver, "#!/bin/sh\ntouch driver-ran\n", { mode: 0o755 });
    writeFileSync(
      join(sandbox.repoPath, ".git", "info", "attributes"),
      "change.txt diff=fixture\n",
    );
    git("config", "diff.fixture.command", driver);
    git("config", "diff.fixture.textconv", driver);
    writeFileSync(join(sandbox.repoPath, "change.txt"), "uncommitted and excluded\n");
    const captured = await compare(before, after, prompt);
    expect(captured).toMatchObject({ input: before, output: after, patch: expect.any(String) });
    expect(captured?.patch).toContain("-before\n+after\n+[REDACTED]\n+OPENAI_API_KEY=[redacted]\n");
    expect(captured?.patch).not.toContain("uncommitted and excluded");
    expect(captured?.sha256).toBe(replaySha256(captured?.patch ?? ""));
    expect(existsSync(marker)).toBe(false);
    expect(git("status", "--porcelain")).toBe("M change.txt");
    expect(await compare(before, { ...after, treeSha: before.treeSha })).toBeNull();
  });

  it("keeps binary and oversized changes unavailable", async () => {
    const base = commit("before\n");
    const binary = commit(Buffer.from([65, 0, 66]));
    const large = commit("é".repeat(33_000));
    expect(await compare(base, binary)).toBeNull();
    expect(await compare(base, large)).toBeNull();
  });
});

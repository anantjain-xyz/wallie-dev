import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { SandboxHandle } from "@/lib/sandbox/types";
import { shellQuote } from "@/lib/sandbox/command";
import { captureValidationEvidence, redactValidationText } from "./capture";
import { validationEvidenceConfigSchema } from "./contracts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(commands?: unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), "wallie-evidence-unit-"));
  directories.push(directory);
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  await writeFile(join(directory, "source.txt"), "original\n");
  if (commands !== undefined) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(directory, ".wallie"));
    await writeFile(
      join(directory, ".wallie/validation-evidence.json"),
      JSON.stringify({ version: 1, commands }),
    );
  }
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "fixture",
  );
  const sha = git("rev-parse", "HEAD");
  const sandbox: SandboxHandle = {
    id: "unit-local",
    repoPath: directory,
    exec: async (command, args, opts) => {
      const child = spawn(command, args, {
        cwd: opts?.cwd ?? directory,
        env: { ...process.env, ...opts?.env },
        signal: opts?.signal,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const exitCode = new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      return {
        exitCode,
        output: async () => {
          await exitCode;
          return { stdout, stderr };
        },
        logs: async function* () {},
        kill: async (signal) => {
          child.kill(signal);
        },
      };
    },
    readFile: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    writeFile: async (path, data) => {
      await writeFile(path, data);
    },
    stop: async () => {},
  };
  return { sandbox, sha, directory, git };
}

const command = (key: string, script: string, reports: unknown[] = []) => ({
  key,
  command: script,
  timeoutSeconds: 10,
  reports,
});
const report = { key: "results", path: "results.txt", kind: "report", required: true };

describe("trusted validation capture", { timeout: 20_000 }, () => {
  it.each(["worktree", "index", "info", "HEAD", "literal-unspecified", "literal-unset"])(
    "rejects masking content filters from %s attributes before validation or Git filtering",
    async (location) => {
      const { sandbox, directory, git } = await fixture([
        command("unit", 'test "$(cat source.txt)" = modified'),
      ]);
      const filterName = location.startsWith("literal-")
        ? location.slice("literal-".length)
        : "mask";
      git(
        "config",
        `filter.${filterName}.clean`,
        'printf "called\\n" >> .git/filter-ran; sed s/modified/original/g',
      );
      await writeFile(join(directory, ".gitattributes"), `source.txt filter=${filterName}\n`);
      git("add", ".gitattributes");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-qm",
        "Masked content fixture",
      );
      const sha = git("rev-parse", "HEAD");
      await writeFile(join(directory, "source.txt"), "modified\n");
      expect(git("status", "--porcelain")).toBe("");
      if (location === "index") {
        await writeFile(join(directory, ".gitattributes"), "");
      } else if (location === "info") {
        await writeFile(join(directory, ".gitattributes"), "");
        git("add", ".gitattributes");
        await writeFile(join(directory, ".git/info/attributes"), "source.txt filter=mask\n");
      } else if (location === "HEAD") {
        await writeFile(join(directory, ".gitattributes"), "");
        git("add", ".gitattributes");
        await rm(join(directory, ".gitattributes"));
      }
      await rm(join(directory, ".git/filter-ran"), { force: true });
      await expect(captureValidationEvidence({ sandbox, commitSha: sha })).rejects.toThrow(
        "Validation evidence collection failed.",
      );
      expect(await sandbox.readFile(join(directory, ".git/filter-ran"))).toBeNull();
    },
  );

  it("reads the actual checkpoint configuration and tree despite Git replacement refs", async () => {
    const { sandbox, sha, directory, git } = await fixture([command("unit", "printf original")]);
    await writeFile(
      join(directory, ".wallie/validation-evidence.json"),
      JSON.stringify({ version: 1, commands: [command("unit", "printf replacement")] }),
    );
    git("add", ".wallie/validation-evidence.json");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "Replacement object",
    );
    const replacement = git("rev-parse", "HEAD");
    git("checkout", "--detach", sha);
    git("replace", sha, replacement);
    expect(git("show", "HEAD:.wallie/validation-evidence.json")).toContain("printf replacement");
    const captured = await captureValidationEvidence({ sandbox, commitSha: sha });
    expect(captured.records[0]).toMatchObject({
      command: "printf original",
      status: "passed",
      commitSha: sha,
      finalCommitSha: sha,
    });
    expect(captured.assets[0].bytes.toString()).toBe("original");
  });

  it("rejects same-size source edits concealed by repository stat-trust settings", async () => {
    const { sandbox, sha, directory, git } = await fixture([command("unit", "printf passed")]);
    const path = join(directory, "source.txt");
    const timestamp = new Date("2020-01-01T00:00:00Z");
    await utimes(path, timestamp, timestamp);
    git("add", "source.txt");
    git("config", "core.trustctime", "false");
    git("config", "core.checkStat", "minimal");
    await writeFile(path, "changed!\n");
    await utimes(path, timestamp, timestamp);
    expect(git("status", "--porcelain")).toBe("");
    await expect(captureValidationEvidence({ sandbox, commitSha: sha })).rejects.toThrow(
      "Validation checkpoint changed before execution.",
    );
  });

  it("does not turn absent configuration or prose into execution", async () => {
    const { sandbox, sha } = await fixture();
    const captured = await captureValidationEvidence({ sandbox, commitSha: sha });
    expect(captured.records).toEqual([]);
    expect(captured.assets).toEqual([]);
    expect(captured.treeSha).toMatch(/^[a-f0-9]{40}$/);
  });

  it("records real execution, exact git identity and redacted durable text", async () => {
    const secret = "synthetic-credential-123456789";
    const { sandbox, sha } = await fixture([
      command(
        "unit",
        `printf 'success ${secret}' ; printf 'report ${secret}' > "$WALLIE_EVIDENCE_DIR/results.txt"`,
        [report],
      ),
    ]);
    const captured = await captureValidationEvidence({
      sandbox,
      commitSha: sha,
      secrets: [secret],
    });
    expect(captured.records[0]).toMatchObject({
      key: "unit",
      provenance: "harness",
      status: "passed",
      exitCode: 0,
      commitSha: sha,
      finalCommitSha: sha,
      treeSha: captured.treeSha,
      finalTreeSha: captured.treeSha,
      reportKeys: ["unit/results"],
      missingRequiredReports: [],
    });
    expect(captured.records[0].command).not.toContain(secret);
    expect(captured.assets).toHaveLength(2);
    expect(captured.assets.find((asset) => asset.key === "unit/results")?.bytes.toString()).toBe(
      "report [REDACTED]",
    );
    expect(JSON.stringify(captured)).not.toContain(secret);
  });

  it("never passes failed commands, missing reports or timed out execution", async () => {
    const { sandbox, sha } = await fixture([
      command("failure", "exit 7"),
      command("missing", "true", [report]),
      { ...command("timeout", "sleep 10"), timeoutSeconds: 1 },
    ]);
    const captured = await captureValidationEvidence({ sandbox, commitSha: sha });
    expect(captured.records.map((record) => record.status)).toEqual(["failed", "failed", "error"]);
    expect(captured.records[0].exitCode).toBe(7);
    expect(captured.records[1].missingRequiredReports).toEqual(["missing/results"]);
  });

  it("settles a timeout even when a detached descendant keeps its output pipes open", async () => {
    const pidDirectory = await mkdtemp(join(tmpdir(), "wallie-evidence-descendant-"));
    directories.push(pidDirectory);
    const pidPath = join(pidDirectory, "pid");
    const script = `
      const fs = require('node:fs');
      const {spawn} = require('node:child_process');
      const child = spawn(process.execPath, ['-e','setTimeout(()=>{},30000)'], {detached:true,stdio:'inherit'});
      fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
      child.unref();
      setTimeout(()=>{},30000);
    `;
    const { sandbox, sha } = await fixture([
      { ...command("detached", `node -e ${shellQuote(script)}`, [report]), timeoutSeconds: 1 },
    ]);
    const started = performance.now();
    try {
      const captured = await captureValidationEvidence({ sandbox, commitSha: sha });
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(captured.records[0]).toMatchObject({
        status: "error",
        exitCode: null,
        missingRequiredReports: ["detached/results"],
      });
      expect(captured.assets).toEqual([]);
    } finally {
      // A setsid descendant escapes the command's process group. In production
      // the provider sandbox teardown owns it; this local adapter must reap it.
      const pid = Number(await readFile(pidPath, "utf8").catch(() => ""));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    }
  });

  it("invalidates earlier success when a later command edits tracked source", async () => {
    const { sandbox, sha } = await fixture([
      command("before", "test -f source.txt"),
      command("edit", "printf changed >> source.txt"),
    ]);
    const captured = await captureValidationEvidence({ sandbox, commitSha: sha });
    expect(captured.records.map((record) => record.status)).toEqual(["stale", "stale"]);
  });

  it("invalidates evidence for new untracked files or a later commit", async () => {
    const { sandbox, sha } = await fixture([command("new", "printf changed > new-source.txt")]);
    expect((await captureValidationEvidence({ sandbox, commitSha: sha })).records[0].status).toBe(
      "stale",
    );
  });

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "rejects source edits hidden by %s",
    async (flag) => {
      const { sandbox, sha } = await fixture([
        command("before", "test -f source.txt"),
        command("hidden", `git update-index ${flag} source.txt; printf changed >> source.txt`),
      ]);
      const captured = await captureValidationEvidence({ sandbox, commitSha: sha });
      expect(captured.records.map((record) => record.status)).toEqual(["stale", "stale"]);
    },
  );

  it("rejects a different checkpoint before executing commands", async () => {
    const { sandbox } = await fixture([command("marker", "touch should-not-run")]);
    await expect(captureValidationEvidence({ sandbox, commitSha: "a".repeat(40) })).rejects.toThrow(
      "Validation checkpoint changed before execution.",
    );
  });

  it("does not replay reports from previous commands and rejects symlinks/binary screenshots", async () => {
    const { sandbox, sha } = await fixture([
      command("first", 'printf report > "$WALLIE_EVIDENCE_DIR/results.txt"', [report]),
      command("replay", "true", [report]),
      command("symlink", 'ln -s /etc/passwd "$WALLIE_EVIDENCE_DIR/results.txt"', [report]),
      command("binary", 'printf "\\000binary" > "$WALLIE_EVIDENCE_DIR/results.txt"', [report]),
      command("screenshot", 'printf image > "$WALLIE_EVIDENCE_DIR/results.txt"', [
        { ...report, kind: "screenshot" },
      ]),
    ]);
    const captured = await captureValidationEvidence({ sandbox, commitSha: sha });
    expect(captured.records.map((record) => record.status)).toEqual([
      "passed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    expect(captured.assets.filter((asset) => asset.required)).toHaveLength(1);
  });

  it("distinguishes optional assets and rejects oversized output", async () => {
    const secret = "synthetic-credential-123456789";
    const { sandbox, sha } = await fixture([
      command("optional", "true", [{ ...report, required: false }]),
      command(
        "excess",
        `node -e 'process.stdout.write("x".repeat(65530) + "${secret}" + "x".repeat(10000))'`,
      ),
    ]);
    const captured = await captureValidationEvidence({
      sandbox,
      commitSha: sha,
      secrets: [secret],
    });
    expect(captured.records.map((record) => record.status)).toEqual(["passed", "error"]);
    expect(captured.assets.find((asset) => asset.key === "excess/log")).toBeUndefined();
    expect(JSON.stringify(captured)).not.toContain(secret.slice(0, 6));
  });
});

describe("evidence contracts and redaction", () => {
  it("rejects duplicate identities, path traversal and unknown configuration", () => {
    expect(
      validationEvidenceConfigSchema.safeParse({
        version: 1,
        commands: [command("x", "true"), command("x", "true")],
      }).success,
    ).toBe(false);
    expect(
      validationEvidenceConfigSchema.safeParse({
        version: 1,
        commands: [command("x", "true", [{ ...report, path: "../secret" }])],
      }).success,
    ).toBe(false);
    expect(
      validationEvidenceConfigSchema.safeParse({ version: 1, commands: [], assertions: "passed" })
        .success,
    ).toBe(false);
  });

  it("redacts secret encodings and common credential forms", () => {
    const secret = "test secret+$value";
    const text = [
      secret,
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
      "TOKEN=unknown-token-value",
      "Authorization: Bearer another-token",
      "-----BEGIN RSA PRIVATE KEY-----\nprivate material\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactValidationText(text, [secret]);
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain("unknown-token-value");
    expect(redacted).not.toContain("another-token");
    expect(redacted).not.toContain("private material");
  });
});

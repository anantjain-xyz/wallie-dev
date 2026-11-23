import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureCommittedSourceCheckpoint } from "@/lib/pipeline/source-checkpoint";
import type { SandboxHandle } from "@/lib/sandbox/types";
import { readValidationIdentity } from "@/lib/validation-evidence/capture";
import { exportValidationSource, materializeValidationSource } from "./join-validation-source";

function useDirectory(repoPath: string): SandboxHandle {
  return {
    id: repoPath,
    repoPath,
    async exec(cmd, args, options) {
      const execution = execFile(cmd, args, {
        cwd: options?.cwd ?? repoPath,
        env: { ...process.env, ...options?.env },
        signal: options?.signal,
        maxBuffer: 16 * 1024 * 1024,
      });
      let stdout = "",
        stderr = "";
      execution.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      execution.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const exitCode = new Promise<number>((resolve) => {
        execution.once("close", (code) => resolve(code ?? -1));
      });
      return {
        exitCode,
        async output() {
          await exitCode;
          return { stdout, stderr };
        },
        async *logs() {
          yield* [];
        },
        async kill(signal) {
          execution.kill(signal);
        },
      };
    },
    async writeFile(path, data, options) {
      await writeFile(path, data, options);
    },
    async readFile(path) {
      return readFile(path, "utf8").catch(() => null);
    },
    async stop() {},
  };
}

async function git(sandbox: SandboxHandle, ...args: string[]) {
  const process = await sandbox.exec("git", args);
  expect(await process.exitCode).toBe(0);
  return (await process.output()).stdout.trim();
}

describe("exact join tree handoff", () => {
  it("captures the real incremental bundle from bare Git and transfers only the fresh validation commit/tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "wallie-join-tree-fixture-"));
    try {
      const seed = useDirectory(join(root, "seed"));
      const bare = useDirectory(join(root, "bare"));
      const validation = useDirectory(join(root, "validation"));
      const tampered = useDirectory(join(root, "tampered"));
      await Promise.all([seed, validation, tampered].map(({ repoPath }) => mkdir(repoPath)));
      await git(seed, "init", "--template=", "--object-format=sha1");
      await git(seed, "config", "user.name", "Wallie fixture");
      await git(seed, "config", "user.email", "fixture@example.test");
      await writeFile(join(seed.repoPath, "history"), "historical bytes deliberately excluded\n");
      await git(seed, "add", "history");
      await git(seed, "commit", "-m", "base");
      const base = await git(seed, "rev-parse", "HEAD");
      await git(seed, "rm", "history");
      await writeFile(join(seed.repoPath, "current"), "exact joined bytes\n");
      await git(seed, "add", "current");
      await git(seed, "commit", "-m", "candidate");
      const candidate = {
        commitSha: await git(seed, "rev-parse", "HEAD"),
        treeSha: await git(seed, "rev-parse", "HEAD^{tree}"),
      };
      await git(seed, "clone", "--bare", seed.repoPath, bare.repoPath);
      await git(
        bare,
        "config",
        "http.https://github.com/.extraheader",
        "fixture credential excluded from transfer",
      );
      const signal = AbortSignal.timeout(15_000);

      const checkpoint = await captureCommittedSourceCheckpoint({
        sandbox: bare,
        baseSha: base,
        headSha: candidate.commitSha,
        signal,
      });
      expect(checkpoint).toMatchObject({
        kind: "bundle",
        baseSha: base,
        headSha: candidate.commitSha,
      });

      const source = await exportValidationSource(bare, candidate, signal);
      const modified = Buffer.from(source.bytes);
      modified[0] ^= 1;
      await expect(
        materializeValidationSource(tampered, candidate, { ...source, bytes: modified }, signal),
      ).rejects.toThrow("integrity verification");
      await materializeValidationSource(validation, candidate, source, signal);
      expect(await readValidationIdentity(validation, signal)).toEqual({
        ...candidate,
        clean: true,
      });
      expect(await readFile(join(validation.repoPath, "current"), "utf8")).toBe(
        "exact joined bytes\n",
      );
      expect(await git(validation, "rev-list", "--count", "HEAD")).toBe("1");
      const missing = await validation.exec("git", ["cat-file", "-e", base]);
      expect(await missing.exitCode).not.toBe(0);
      const config = await readFile(join(validation.repoPath, ".git/config"), "utf8");
      expect(config).not.toContain("extraheader");
      expect(config).not.toContain("remote");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

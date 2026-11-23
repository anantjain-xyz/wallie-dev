import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          ...options?.env,
        },
        signal: options?.signal,
        maxBuffer: 512 * 1024,
      });
      let stdout = "",
        stderr = "";
      execution.on("error", () => undefined);
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
  const { stdout, stderr } = await process.output();
  expect(await process.exitCode, stderr).toBe(0);
  return stdout.trim();
}

describe("exact join tree handoff", () => {
  it("transfers a large unchanged base in bounded chunks and retries a single lost upload reply", async () => {
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
      const unchangedBase = randomBytes(9 * 1024 * 1024);
      await writeFile(join(seed.repoPath, "history"), "historical bytes deliberately excluded\n");
      await writeFile(join(seed.repoPath, "large-base.bin"), unchangedBase);
      await git(seed, "add", "history", "large-base.bin");
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
      expect(source.byteLength).toBeGreaterThan(8 * 1024 * 1024);
      expect(source.chunks.length).toBeGreaterThan(32);
      const modified = Buffer.from(source.chunks[0]);
      modified[0] ^= 1;
      await expect(
        materializeValidationSource(
          tampered,
          candidate,
          { ...source, chunks: [modified, ...source.chunks.slice(1)] },
          signal,
        ),
      ).rejects.toThrow("integrity verification");

      const uploadedPaths: string[] = [];
      const write = validation.writeFile;
      validation.writeFile = async (path, data, options) => {
        expect(Buffer.byteLength(data)).toBeLessThanOrEqual(256 * 1024);
        uploadedPaths.push(path);
        await write(path, data, options);
        if (uploadedPaths.length === 1)
          throw new Error("The provider response was lost after the write.");
      };
      await materializeValidationSource(validation, candidate, source, signal);
      expect(uploadedPaths).toHaveLength(source.chunks.length + 1);
      expect(uploadedPaths[1]).toBe(uploadedPaths[0]);
      await expect(readFile(uploadedPaths[0])).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readValidationIdentity(validation, signal)).toEqual({
        ...candidate,
        clean: true,
      });
      expect(await readFile(join(validation.repoPath, "current"), "utf8")).toBe(
        "exact joined bytes\n",
      );
      expect(
        createHash("sha256")
          .update(await readFile(join(validation.repoPath, "large-base.bin")))
          .digest("hex"),
      ).toBe(createHash("sha256").update(unchangedBase).digest("hex"));
      expect(await git(validation, "rev-list", "--count", "HEAD")).toBe("1");
      const missing = await validation.exec("git", ["cat-file", "-e", base]);
      expect(await missing.exitCode).not.toBe(0);
      const config = await readFile(join(validation.repoPath, ".git/config"), "utf8");
      expect(config).not.toContain("extraheader");
      expect(config).not.toContain("remote");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("surfaces the caller's deadline even if a chunk upload never answers", async () => {
    const sandbox = useDirectory("/tmp/join-validation-deadline-fixture");
    const exec = vi.fn<SandboxHandle["exec"]>(async () => ({
      exitCode: Promise.resolve(0),
      async output() {
        return { stdout: "", stderr: "" };
      },
      async *logs() {
        yield* [];
      },
      async kill() {},
    }));
    sandbox.exec = exec;
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    sandbox.writeFile = () =>
      new Promise<void>(() => {
        uploadStarted();
      });

    const candidate = { commitSha: "a".repeat(40), treeSha: "b".repeat(40) };
    const bytes = Buffer.from("pending chunk");
    const controller = new AbortController();
    const transfer = materializeValidationSource(
      sandbox,
      candidate,
      {
        ...candidate,
        chunks: [bytes],
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      controller.signal,
    );

    await started;
    const deadline = new Error("Exact join deadline elapsed");
    const rejected = expect(transfer).rejects.toBe(deadline);
    controller.abort(deadline);
    await rejected;
    expect(exec.mock.calls.map(([command]) => command)).toEqual(["mkdir"]);
  });
});

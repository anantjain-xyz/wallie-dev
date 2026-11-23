import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SandboxHandle } from "@/lib/sandbox/types";
import { captureValidationEvidence } from "@/lib/validation-evidence/capture";
import { prepareJoinValidationDependencies } from "./join-validation-dependencies";

function sandboxWithExec(repoPath: string, exec: SandboxHandle["exec"]): SandboxHandle {
  return {
    id: repoPath,
    repoPath,
    exec,
    async readFile(path) {
      return readFile(path, "utf8").catch(() => null);
    },
    async writeFile(path, data, options) {
      await writeFile(path, data, options);
    },
    async stop() {},
  };
}

function localSandbox(repoPath: string, cachePath: string) {
  return sandboxWithExec(repoPath, async (command, args, options) => {
    const process = execFile(command, args, {
      cwd: options?.cwd ?? repoPath,
      env: {
        NODE_ENV: "test",
        PATH: globalThis.process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        npm_config_cache: cachePath,
        npm_config_offline: "true",
        npm_config_update_notifier: "false",
        ...options?.env,
      },
      signal: options?.signal,
    });
    let stdout = "";
    let stderr = "";
    process.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    process.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // The signal may kill the process before it exits normally.
    process.on("error", () => undefined);
    const exitCode = new Promise<number>((resolve) => {
      process.once("close", (code) => resolve(code ?? -1));
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
        process.kill(signal);
      },
    };
  });
}

async function requiredOutput(sandbox: SandboxHandle, command: string, args: string[]) {
  const process = await sandbox.exec(command, args);
  const { stdout, stderr } = await process.output();
  expect(await process.exitCode, stderr).toBe(0);
  return stdout.trim();
}

describe("prepareJoinValidationDependencies", () => {
  it("installs a locked local dependency before running a frozen test-only plan in a fresh checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "wallie-join-dependencies-"));
    try {
      const source = join(root, "source");
      const checkout = join(root, "checkout");
      const dependency = join(source, "fixture-dependency");
      const cache = join(root, "npm-cache");
      await mkdir(dependency, { recursive: true });
      await Promise.all([
        writeFile(
          join(source, "package.json"),
          JSON.stringify({
            name: "join-validation-fixture",
            version: "1.0.0",
            private: true,
            scripts: { test: "node test.cjs" },
            devDependencies: { "fixture-dependency": "file:fixture-dependency" },
          }),
        ),
        writeFile(
          join(dependency, "package.json"),
          JSON.stringify({ name: "fixture-dependency", version: "1.0.0", main: "index.cjs" }),
        ),
        writeFile(join(dependency, "index.cjs"), 'module.exports = "from the joined checkout";\n'),
        writeFile(
          join(source, "test.cjs"),
          'require("node:assert/strict").equal(require("fixture-dependency"), "from the joined checkout");\n',
        ),
        writeFile(join(source, ".gitignore"), "node_modules/\n"),
      ]);
      const authored = localSandbox(source, cache);
      await requiredOutput(authored, "npm", [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ]);
      await requiredOutput(authored, "git", ["init", "--quiet", "--template="]);
      await requiredOutput(authored, "git", ["add", "--all"]);
      await requiredOutput(authored, "git", [
        "-c",
        "user.name=Wallie fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--quiet",
        "-m",
        "Freeze the validation dependency",
      ]);
      await requiredOutput(authored, "git", [
        "clone",
        "--quiet",
        "--no-hardlinks",
        source,
        checkout,
      ]);

      const fresh = localSandbox(checkout, cache);
      const commitSha = await requiredOutput(fresh, "git", ["rev-parse", "HEAD"]);
      const before = await fresh.exec("npm", ["test"]);
      expect(await before.exitCode).not.toBe(0);
      expect((await before.output()).stderr).toContain("Cannot find module 'fixture-dependency'");

      const signal = AbortSignal.timeout(15_000);
      const prepared = await prepareJoinValidationDependencies(fresh, signal);
      const evidence = await captureValidationEvidence({
        sandbox: prepared,
        commitSha,
        plan: {
          version: 1,
          commands: [{ key: "tests", command: "npm test", timeoutSeconds: 8, reports: [] }],
        },
        signal,
      });
      expect(evidence.records).toEqual([
        expect.objectContaining({ key: "tests", status: "passed", exitCode: 0, commitSha }),
      ]);
      expect(await requiredOutput(fresh, "git", ["status", "--porcelain"])).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("uses the pinned pnpm version for both frozen installation and validation", async () => {
    const exec = vi.fn<SandboxHandle["exec"]>(async (command) => {
      const stdout =
        command === "git"
          ? "package.json\npnpm-lock.yaml\n"
          : command === "node"
            ? JSON.stringify({ packageManager: "pnpm@10.21.0" })
            : "";
      return {
        exitCode: Promise.resolve(0),
        async output() {
          return { stdout, stderr: "" };
        },
        async *logs() {
          yield* [];
        },
        async kill() {},
      };
    });
    const sandbox = sandboxWithExec("/tmp/validation-repository", exec);
    const signal = AbortSignal.timeout(15_000);
    const prepared = await prepareJoinValidationDependencies(sandbox, signal);
    await prepared.exec("pnpm", ["test"], { signal });

    expect(exec).toHaveBeenCalledWith(
      "bash",
      expect.arrayContaining(["npm", "install", "--global", "pnpm@10.21.0"]),
      expect.objectContaining({ cwd: "/tmp", signal }),
    );
    expect(exec).toHaveBeenCalledWith(
      "bash",
      expect.arrayContaining([
        'export PATH="$1:$PATH"; shift; exec "$@"',
        "/tmp/wallie-join-package-tools/bin",
        "pnpm",
        "install",
        "--frozen-lockfile",
      ]),
      expect.objectContaining({ cwd: sandbox.repoPath, signal }),
    );
    expect(exec).toHaveBeenLastCalledWith(
      "bash",
      expect.arrayContaining([
        'export PATH="$1:$PATH"; shift; exec "$@"',
        "/tmp/wallie-join-package-tools/bin",
        "pnpm",
        "test",
      ]),
      { signal },
    );
  });
});

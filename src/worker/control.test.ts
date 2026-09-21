import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startWorkerControlServer, type WorkerControlStatus } from "./control";

const exec = promisify(execFile);
const cli = resolve("scripts/worker-control.mjs");
let directory: string;
let socketPath: string;
let control: Awaited<ReturnType<typeof startWorkerControlServer>> | undefined;
let status: WorkerControlStatus;

beforeEach(async () => {
  // Keep below the Unix socket path limit on both macOS and Linux.
  directory = await mkdtemp("/tmp/wallie-control-");
  socketPath = `${directory}/control.sock`;
  status = { workerId: "worker-test", phase: "running", activeJobIds: [] };
});
afterEach(async () => {
  await control?.close();
  control = undefined;
  await rm(directory, { recursive: true, force: true });
});
const runCli = (...args: string[]) =>
  exec(process.execPath, [cli, ...args], {
    env: { ...process.env, WORKER_CONTROL_SOCKET: socketPath },
    timeout: 5_000,
  });
const start = async (requestDrain: () => void = vi.fn()) => {
  control = await startWorkerControlServer(socketPath, {
    getStatus: () => status,
    requestDrain,
  });
};

describe("local worker control", () => {
  it("serves status through an owner-only socket and permits only POST to drain", async () => {
    const drain = vi.fn();
    await start(drain);
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse((await runCli("status")).stdout)).toEqual(status);
    const code = await new Promise((done, reject) => {
      const req = request({ socketPath, path: "/drain", method: "GET" }, (response) => {
        response.resume();
        response.on("end", () => done(response.statusCode));
      });
      req.on("error", reject).end();
    });
    expect(code).toBe(404);
    expect(drain).not.toHaveBeenCalled();
  });

  it("CLI waits for explicit drained status even when no active jobs are listed", async () => {
    const drain = vi.fn(() => {
      status.phase = "draining";
    });
    await start(drain);
    let completed = false;
    const result = runCli("drain").then((value) => {
      completed = true;
      return value;
    });
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    status.phase = "drained";
    expect(JSON.parse((await result).stdout)).toEqual(status);
  });

  it("CLI fails if the worker identity changes during drain", async () => {
    await start(() => {
      status.phase = "draining";
    });
    const result = runCli("drain");
    const rejected = expect(result).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("identity changed"),
    });
    await vi.waitFor(() => expect(status.phase).toBe("draining"));
    status = { ...status, workerId: "replacement", phase: "drained" };
    await rejected;
  });

  it("CLI times out without declaring an incomplete drain safe", async () => {
    await start(() => {
      status.phase = "draining";
    });
    await expect(runCli("drain", "--timeout-seconds", "1")).rejects.toMatchObject({ code: 1 });
    expect(status.phase).toBe("draining");
  });

  it("CLI fails closed for a missing worker, stopping worker, or contradictory status", async () => {
    await expect(runCli("drain")).rejects.toMatchObject({ code: 1 });
    await start();
    status.phase = "stopping";
    await expect(runCli("drain")).rejects.toMatchObject({ code: 1 });
    status = { ...status, phase: "drained", activeJobIds: ["still-running"] };
    await expect(runCli("drain")).rejects.toMatchObject({ code: 1 });
  });

  it("refuses a live socket, ordinary file, and shared parent directory", async () => {
    await start();
    await expect(
      startWorkerControlServer(socketPath, { getStatus: () => status, requestDrain: vi.fn() }),
    ).rejects.toThrow("already in use");
    await control!.close();
    control = undefined;
    await writeFile(socketPath, "preserve me");
    await expect(start()).rejects.toThrow("non-socket");
    expect(await readFile(socketPath, "utf8")).toBe("preserve me");
    await chmod(directory, 0o755);
    await expect(start()).rejects.toThrow("owner-only directory");
  });

  it("recovers its stale socket after a process crash", async () => {
    const child = spawn(process.execPath, [
      "--eval",
      `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => console.log("ready"))`,
    ]);
    try {
      await new Promise<void>((done, reject) => {
        child.once("error", reject);
        child.stdout.once("data", () => done());
      });
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      child.kill("SIGKILL");
      await exited;
      expect((await lstat(socketPath)).isSocket()).toBe(true);
      await start();
      expect(JSON.parse((await runCli("status")).stdout)).toEqual(status);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

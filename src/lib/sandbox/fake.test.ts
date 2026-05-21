import { describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";

import { FakeSandbox } from "./fake";

describe("FakeSandbox", () => {
  it("records calls and returns scripted logs", async () => {
    const sb = new FakeSandbox();
    sb.scriptExec("echo", [
      { data: "hello\n", stream: "stdout" },
      { data: "world\n", stream: "stdout" },
    ]);

    const proc = await sb.exec("echo", ["hello"]);
    const logs: string[] = [];
    for await (const e of proc.logs()) logs.push(e.data);

    expect(logs).toEqual(["hello\n", "world\n"]);
    expect(await proc.exitCode).toBe(0);
    expect(sb.calls).toHaveLength(1);
    expect(sb.calls[0].cmd).toBe("echo");
  });

  it("propagates scripted non-zero exit code", async () => {
    const sb = new FakeSandbox();
    sb.scriptExec("false", [{ data: "boom\n", stream: "stderr" }], { exitCode: 1 });

    const proc = await sb.exec("false", []);
    for await (const entry of proc.logs()) {
      void entry;
    }
    expect(await proc.exitCode).toBe(1);
  });

  it("round-trips files via writeFile / readFile", async () => {
    const sb = new FakeSandbox();
    await sb.writeFile("/tmp/hello.txt", "hi there", { mode: 0o600 });
    expect(await sb.readFile("/tmp/hello.txt")).toBe("hi there");
    expect(await sb.readFile("/tmp/missing.txt")).toBeNull();
  });

  it("rejects exec after stop", async () => {
    const sb = new FakeSandbox();
    await sb.stop();
    await expect(sb.exec("ls", [])).rejects.toThrow(/stopped/);
  });

  it("supports function matchers for precise scripting", async () => {
    const sb = new FakeSandbox();
    sb.scriptExec(
      (c) => c.cmd === "bash" && c.args[0] === "-lc" && c.args[1]?.includes("git push"),
      [{ data: "pushed\n", stream: "stdout" }],
    );

    const proc = await sb.exec("bash", ["-lc", "git push -u origin main"]);
    const logs: string[] = [];
    for await (const e of proc.logs()) logs.push(e.data);
    expect(logs).toEqual(["pushed\n"]);
  });

  it("runs passthrough commands from the sandbox checkout by default", async () => {
    const sb = new FakeSandbox(undefined, { passthroughExec: true });
    try {
      const proc = await sb.exec("bash", ["-lc", "pwd"]);
      const output = await proc.output();

      expect(realpathSync(output.stdout.trim())).toBe(realpathSync(sb.repoPath));
      expect(await proc.exitCode).toBe(0);
    } finally {
      await sb.stop();
    }
  });

  it("streams passthrough logs before the command exits", async () => {
    const sb = new FakeSandbox(undefined, { passthroughExec: true });
    try {
      const proc = await sb.exec("bash", ["-lc", "printf first; sleep 1; printf second"]);
      const iter = proc.logs()[Symbol.asyncIterator]();

      const first = await Promise.race([
        iter.next().then((result) => result.value?.data),
        proc.exitCode.then(() => "exited"),
      ]);

      expect(first).toBe("first");
      expect(await proc.exitCode).toBe(0);
    } finally {
      await sb.stop();
    }
  });

  it("does not leak host env vars into passthrough commands", async () => {
    const previous = process.env.WALLIE_FAKE_HOST_SECRET;
    process.env.WALLIE_FAKE_HOST_SECRET = "host-secret";

    const sb = new FakeSandbox(undefined, { passthroughExec: true });
    try {
      const proc = await sb.exec(
        "bash",
        ["-lc", 'printf "%s|%s" "${WALLIE_FAKE_HOST_SECRET:-}" "$EXPLICIT_VALUE"'],
        { env: { EXPLICIT_VALUE: "explicit" } },
      );
      const output = await proc.output();

      expect(output.stdout).toBe("|explicit");
      expect(await proc.exitCode).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env.WALLIE_FAKE_HOST_SECRET;
      } else {
        process.env.WALLIE_FAKE_HOST_SECRET = previous;
      }
      await sb.stop();
    }
  });

  it("reports signal-terminated passthrough commands as non-zero", async () => {
    const sb = new FakeSandbox(undefined, { passthroughExec: true });
    try {
      const proc = await sb.exec("bash", ["-lc", "while true; do sleep 1; done"]);
      await proc.kill("SIGTERM");

      expect(await proc.exitCode).toBe(143);
    } finally {
      await sb.stop();
    }
  });

  it("fails fast when passthrough git bootstrap fails", () => {
    expect(
      () => new FakeSandbox(undefined, { branch: "bad branch name", passthroughExec: true }),
    ).toThrow(/FakeSandbox git checkout -B bad branch name failed/);
  });
});

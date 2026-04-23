import { describe, expect, it } from "vitest";

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
});

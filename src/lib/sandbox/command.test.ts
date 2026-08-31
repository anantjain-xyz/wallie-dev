import { describe, expect, it } from "vitest";

import { redactSecrets, SandboxLogBuffer, shellEnvPrefix, shellJoin } from "./command";

describe("sandbox command utilities", () => {
  it("preserves every argument when providers require one POSIX command string", () => {
    expect(shellJoin("node", ["-e", "console.log('a b')", "$(touch /tmp/nope)", ""])).toBe(
      `'node' '-e' 'console.log('"'"'a b'"'"')' '$(touch /tmp/nope)' ''`,
    );
    expect(shellEnvPrefix({ EMPTY: "", TOKEN: "a b'c" })).toBe(`env EMPTY='' TOKEN='a b'"'"'c' `);
  });

  it("rejects unsafe environment variable names", () => {
    expect(() => shellEnvPrefix({ "BAD-NAME": "value" })).toThrow(/environment variable name/);
  });

  it("replays buffered stdout and stderr after a command completes", async () => {
    const buffer = new SandboxLogBuffer();
    buffer.push({ data: "one", stream: "stdout" });
    buffer.push({ data: "two", stream: "stderr" });
    buffer.close();

    const entries = [];
    for await (const entry of buffer.stream()) entries.push(entry);
    expect(entries).toEqual([
      { data: "one", stream: "stdout" },
      { data: "two", stream: "stderr" },
    ]);
  });

  it("redacts raw and URL-encoded credentials", () => {
    expect(redactSecrets("token=abc/def and token=abc%2Fdef", ["abc/def"])).toBe(
      "token=[REDACTED] and token=[REDACTED]",
    );
  });
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type LintMessage = {
  message: string;
  ruleId: string | null;
};

type LintResult = {
  messages: LintMessage[];
};

const eslintPath = fileURLToPath(
  new URL("../../node_modules/eslint/bin/eslint.js", import.meta.url),
);
const fixturesDirectory = new URL("../../test/eslint-fixtures/", import.meta.url);

function lintFixture(name: string) {
  const fixturePath = fileURLToPath(new URL(name, fixturesDirectory));
  const result = spawnSync(
    process.execPath,
    [eslintPath, "--no-ignore", "--format", "json", fixturePath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  if (result.error) throw result.error;
  if (!result.stdout) {
    throw new Error(result.stderr || "ESLint did not return JSON output.");
  }

  return {
    exitCode: result.status,
    results: JSON.parse(result.stdout) as LintResult[],
    stderr: result.stderr,
  };
}

describe("wallie-supabase/no-unbound-client-methods", () => {
  it("accepts direct calls and deliberately bound aliases through casts", () => {
    const lint = lintFixture("supabase-rpc-bound.ts");

    expect(lint.stderr).toBe("");
    expect(lint.exitCode).toBe(0);
    expect(lint.results.flatMap((result) => result.messages)).toEqual([]);
  }, 30_000);

  it("rejects destructured, assigned, cast, and passed rpc references", () => {
    const lint = lintFixture("supabase-rpc-unbound.ts");
    const messages = lint.results
      .flatMap((result) => result.messages)
      .filter((message) => message.ruleId === "wallie-supabase/no-unbound-client-methods");

    expect(lint.stderr).toBe("");
    expect(lint.exitCode).toBe(1);
    expect(messages).toHaveLength(4);
    expect(messages.every((message) => message.message.includes("depend on their receiver"))).toBe(
      true,
    );
    expect(messages.every((message) => message.message.includes("client.rpc.bind(client)"))).toBe(
      true,
    );
  }, 30_000);
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const eslintPath = fileURLToPath(
  new URL("../../node_modules/eslint/bin/eslint.js", import.meta.url),
);
const fixturesDirectory = new URL("../../test/eslint-fixtures/", import.meta.url);
const boundFixture = fileURLToPath(new URL("supabase-rpc-bound.ts", fixturesDirectory));
const unboundFixture = fileURLToPath(new URL("supabase-rpc-unbound.ts", fixturesDirectory));

describe("wallie-supabase/no-unbound-client-methods", () => {
  let results: ESLint.LintResult[];

  beforeAll(() => {
    const lint = spawnSync(
      process.execPath,
      [eslintPath, "--no-ignore", "--format", "json", boundFixture, unboundFixture],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    if (lint.error) throw lint.error;
    expect(lint.signal, "ESLint was terminated by a signal").toBeNull();
    expect(lint.stderr, "Unexpected ESLint stderr").toBe("");
    expect(lint.status, "ESLint must exit 1 for the intentional receiver violations").toBe(1);

    try {
      results = JSON.parse(lint.stdout) as ESLint.LintResult[];
    } catch (cause) {
      throw new Error("ESLint did not return valid JSON.", { cause });
    }

    if (!Array.isArray(results)) {
      throw new Error("ESLint did not return a JSON array of file results.");
    }
    expect(
      results.map((result) => result?.filePath).sort(),
      "ESLint must report exactly one result for each fixture",
    ).toEqual([boundFixture, unboundFixture].sort());
  }, 30_000);

  function messagesForFixture(fixturePath: string) {
    const messages = results.find((result) => result.filePath === fixturePath)?.messages;
    if (!Array.isArray(messages)) {
      throw new Error(`ESLint returned no diagnostics array for ${fixturePath}.`);
    }
    return messages;
  }

  it("accepts direct calls and deliberately bound aliases through transparent syntax", () => {
    expect(messagesForFixture(boundFixture)).toEqual([]);
  });

  it("rejects every detached rpc reference, including cast, effectful, and computed forms", () => {
    const messages = messagesForFixture(unboundFixture);
    expect(messages).toHaveLength(7);
    for (const message of messages) {
      expect(message).toMatchObject({
        ruleId: "wallie-supabase/no-unbound-client-methods",
        severity: 2,
      });
      expect(message.message).toContain("depend on their receiver");
      expect(message.message).toContain("client.rpc.bind(client)");
    }
  });
});

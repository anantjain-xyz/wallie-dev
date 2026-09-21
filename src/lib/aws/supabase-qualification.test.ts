import { beforeAll, describe, expect, it } from "vitest";

let assertTapPassed: (output: string, label: string) => number;

beforeAll(async () => {
  const helper = new URL("../../../scripts/fixtures/qualification-tap.mjs", import.meta.url).href;
  ({ assertTapPassed } = await import(helper));
});

describe("self-hosted database qualification TAP results", () => {
  it("counts passing assertions with a leading plan and SQL setup rows", () => {
    expect(
      assertTapPassed(
        "\n1..2\nOK\nBEGIN\n# diagnostic\nok 1 - RLS enabled\n1\nok 2 - RPC denied\nCOMMIT\n",
        "fixture.sql",
      ),
    ).toBe(2);
  });

  it("accepts a no_plan test's trailing plan and CRLF output", () => {
    expect(assertTapPassed("ok 1 - first\r\nok 2 - second\r\n1..2\r\n", "fixture.sql")).toBe(2);
  });

  it("does not treat diagnostic text as results", () => {
    expect(assertTapPassed("1..1\n# not ok 2\n# Bail out!\nok 1 - proof\n", "fixture.sql")).toBe(1);
  });

  it.each([
    ["failed assertion", "1..2\nok 1 - good\nnot ok 2 - wrong\n"],
    ["TODO failure", "1..1\nnot ok 1 - wrong # TODO repair\n"],
    ["bailout", "1..1\nok 1\nBail out! Database unavailable\n"],
    ["missing plan", "ok 1 - proof\n"],
    ["SQL setup output alone", "OK\nBEGIN\nCOMMIT\n"],
    ["empty output", ""],
    ["zero-assertion skip", "1..0 # SKIP database unavailable\n"],
    ["missing assertions", "1..1\n"],
    ["too few assertions", "1..2\nok 1\n"],
    ["too many assertions", "1..1\nok 1\nok 2\n"],
    ["duplicate plans", "1..1\nok 1\n1..1\n"],
    ["duplicate IDs", "1..2\nok 1\nok 1\n"],
    ["out-of-order IDs", "1..2\nok 2\nok 1\n"],
    ["gaps", "1..2\nok 1\nok 3\n"],
    ["unnumbered results", "1..1\nok - proof\n"],
    ["malformed plan", "1..1unexpected\nok 1\n"],
    ["plan in the middle", "ok 1\n1..2\nok 2\n"],
    ["unsafe plan integer", "1..9007199254740992\nok 1\n"],
    ["skipped assertion", "1..1\nok 1 # SKIP missing extension\n"],
    ["TODO assertion", "1..1\nok 1 # TODO pending check\n"],
  ])("rejects %s instead of reporting qualification success", (_name, output) => {
    expect(() => assertTapPassed(output, "fixture.sql")).toThrow(/^fixture\.sql:/);
  });

  it("does not expose setup rows in failure messages", () => {
    expect(() => assertTapPassed("password=private-fixture\nnot ok 1\n", "fixture.sql")).toThrow(
      "fixture.sql: TAP assertion failed",
    );
  });
});

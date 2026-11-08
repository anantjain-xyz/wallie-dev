import { describe, expect, it } from "vitest";

import { parseRunFailure } from "./run-failure";
import { sanitizeRunFailureDiagnostic } from "./failure-diagnostic";

describe("terminal run failures", () => {
  it.each([
    ["configuration", "credentials", "Reconnect"],
    ["configuration", "sandbox_configuration", "sandbox connection"],
    ["configuration", "repository_configuration", "GitHub connection"],
    ["configuration", "agent_configuration", "workspace Settings"],
    ["agent_exit", "agent_exit", "Retry only after"],
    ["agent_exit", "agent_incomplete", "stage instructions"],
    ["timeout", "timeout", "configured limit"],
    ["budget", "budget", "repair limits"],
    ["publication", "publication", "retained source recovery"],
    ["unknown", "unknown", "before deciding whether to retry"],
  ])("provides specific recovery for persisted %s / %s", (category, code, recovery) => {
    const failure = parseRunFailure(JSON.stringify({ version: 1, category, code }));
    expect(failure).toMatchObject({ category, code });
    expect(failure?.cause).toBeTruthy();
    expect(failure?.recovery).toContain(recovery);
  });

  it.each([
    "Tests failed; fix the assertion",
    "**Error:** The command exited with code 1",
    JSON.stringify({ version: 1, category: "configuration", code: "agent_exit" }),
    JSON.stringify({ version: 2, category: "timeout", code: "timeout" }),
    JSON.stringify({ version: 1, category: "private payload", code: "unknown" }),
    JSON.stringify({ version: 1, category: "unknown", code: "unrecognized secret" }),
    "null",
  ])("does not invent a terminal cause from invalid or legacy payloads: %s", (value) => {
    expect(parseRunFailure(value)).toBeNull();
  });

  it("uses only allowlisted copy even when persisted metadata contains sensitive fields", () => {
    const failure = parseRunFailure(
      JSON.stringify({
        version: 1,
        category: "configuration",
        code: "credentials",
        cause: "api_key=private-provider-value",
        recovery: "Bearer private-auth-value",
        diagnostic: { password: "private-password" },
      }),
    );
    expect(JSON.stringify(failure)).not.toMatch(/private-provider|private-auth|private-password/);
    expect(failure?.cause).toContain("credentials");
  });
});

describe("historical failure diagnostic redaction", () => {
  it.each([
    'Failed request {"credentials":{"private_key":"sensitive-value"}}',
    'token="sensitive-value"',
    "https://user:sensitive-value@example.com/?api_key=sensitive-value",
    "Bearer sensitive-value-abcdefghijk",
    "-----BEGIN PRIVATE KEY-----\nsensitive-value\n-----END PRIVATE KEY-----",
  ])("redacts stored diagnostics before displaying them: %s", (value) => {
    expect(sanitizeRunFailureDiagnostic(value)).not.toContain("sensitive-value");
    expect(sanitizeRunFailureDiagnostic(value)).toContain("[redacted]");
  });

  it("retains useful diagnostics within a bounded size", () => {
    expect(sanitizeRunFailureDiagnostic("Agent exited with code 7")).toBe(
      "Agent exited with code 7",
    );
    expect(sanitizeRunFailureDiagnostic("x".repeat(10_000))).toHaveLength(1000);
  });
});

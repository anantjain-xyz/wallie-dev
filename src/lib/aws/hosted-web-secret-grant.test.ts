import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-hosted-web-secret-grant.mjs", import.meta.url),
);
const { hostedWebSecretGrant } = await import(new URL(`file://${script}`).href);
const now = Date.parse("2026-09-26T20:00:00Z");
const expires = "2026-09-26T22:00:00Z";

describe("isolated hosted-web secret grant", () => {
  it("permits only metadata and one first web value write, all expiring", () => {
    const policy = hostedWebSecretGrant(expires, now);
    expect(policy.Statement.map((item: { Action: string | string[] }) => item.Action)).toEqual([
      [
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetResourcePolicy",
        "secretsmanager:ListSecretVersionIds",
      ],
      "secretsmanager:PutSecretValue",
    ]);
    for (const statement of policy.Statement) {
      expect(statement.Resource).toBe(
        "arn:aws:secretsmanager:us-west-2:111614490109:secret:/wallie/staging/web/runtime-vDeDr4",
      );
      expect(statement.Condition.DateLessThan["aws:CurrentTime"]).toBe(expires);
    }
    expect(JSON.stringify(policy)).not.toMatch(/worker|CreateSecret|TagResource|GetSecretValue/);
  });

  it("rejects non-UTC, expired, and excessive grants", () => {
    expect(() => hostedWebSecretGrant("2026-09-26T20:05:00Z", now)).toThrow();
    expect(() => hostedWebSecretGrant("2026-09-28T20:00:00Z", now)).toThrow();
    expect(() => hostedWebSecretGrant("2026-09-26T22:00:00-00:00", now)).toThrow();
  });
});

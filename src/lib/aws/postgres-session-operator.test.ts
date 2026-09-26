import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-postgres-session-operator.mjs", import.meta.url),
);
const account = "123456789012";
const region = "us-west-2";
const instance = "i-0123456789abcdef0";
const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const args = [
  "--account-id",
  account,
  "--region",
  region,
  "--instance-id",
  instance,
  "--expires-at",
  expiresAt,
];

type Statement = {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition: {
    StringEquals: Record<string, string>;
    ArnEquals: Record<string, string>;
    DateLessThan: Record<string, string>;
  };
};
type Policy = { Version: string; Statement: Statement[] };

function run(
  parameters: readonly string[],
  env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "" },
) {
  return spawnSync(process.execPath, [script, ...parameters], {
    encoding: "utf8",
    timeout: 5_000,
    env,
  });
}

function rendered(parameters: readonly string[]) {
  const result = run(parameters);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toMatch(/<[A-Z_]+>/);
  const policy = JSON.parse(result.stdout) as Policy;
  expect(policy.Version).toBe("2012-10-17");
  expect(JSON.stringify(policy).length).toBeLessThanOrEqual(6_144);
  return policy;
}

describe("temporary PostgreSQL operator shell grant", () => {
  it("limits shell start to the reviewed host and termination to the caller's host sessions", () => {
    const statements = rendered(args).Statement;
    expect(statements.map((statement) => statement.Sid)).toEqual([
      "StartReviewedPostgresShellOnly",
      "OpenDataChannelForReviewedOperator",
      "EndOnlyOwnPostgresSessions",
    ]);
    const [start, channel, lifecycle] = statements;
    expect(start.Action).toBe("ssm:StartSession");
    expect(start.Resource).toEqual([
      `arn:aws:ec2:${region}:${account}:instance/${instance}`,
      `arn:aws:ssm:${region}:${account}:document/SSM-SessionManagerRunShell`,
    ]);
    const ownSessions = `arn:aws:ssm:${region}:${account}:session/${"${aws:username}"}-*`;
    expect(channel.Action).toBe("ssmmessages:OpenDataChannel");
    expect(channel.Resource).toBe("*");
    expect(lifecycle.Action).toBe("ssm:TerminateSession");
    expect(lifecycle.Resource).toBe(ownSessions);
    expect(lifecycle.Condition.StringEquals["ssm:resourceTag/aws:ssmmessages:target-id"]).toBe(
      instance,
    );
    expect(statements.flatMap((statement) => statement.Action)).toEqual([
      "ssm:StartSession",
      "ssmmessages:OpenDataChannel",
      "ssm:TerminateSession",
    ]);
    for (const statement of statements) {
      expect(statement.Effect).toBe("Allow");
      if (statement.Sid !== "OpenDataChannelForReviewedOperator") {
        expect(statement.Resource).not.toBe("*");
      }
      expect(statement.Condition.StringEquals).toMatchObject({
        "aws:PrincipalAccount": account,
        "aws:RequestedRegion": region,
      });
      expect(statement.Condition.ArnEquals).toEqual({
        "aws:PrincipalArn": `arn:aws:iam::${account}:user/wallie-local`,
      });
      expect(statement.Condition.DateLessThan).toEqual({ "aws:CurrentTime": expiresAt });
    }
  });

  it.each([
    ["missing instance", args.slice(0, -4).concat(args.slice(-2))],
    ["duplicate instance", [...args, "--instance-id", instance]],
    ["extra option", [...args, "--policy", "host"]],
    ["positional argument", [...args, "unexpected"]],
    ["wildcard instance", args.map((value) => (value === instance ? "i-*" : value))],
    ["short instance", args.map((value) => (value === instance ? "i-12345678" : value))],
    ["different partition", args.map((value) => (value === region ? "cn-north-1" : value))],
    ["bad account", args.map((value) => (value === account ? "12345" : value))],
    ["expired", args.map((value) => (value === expiresAt ? "2026-01-01T00:00:00Z" : value))],
    [
      "overlong expiry",
      args.map((value) =>
        value === expiresAt
          ? new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
          : value,
      ),
    ],
    ["invalid date", args.map((value) => (value === expiresAt ? "2026-02-30T00:00:00Z" : value))],
  ] as const)("rejects %s without a policy", (_label, parameters) => {
    const result = run(parameters);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-postgres-session-operator]");
  });

  it("ignores ambient AWS identity and remains under IAM's size limit in a longer region", () => {
    const result = run(args, {
      NODE_ENV: "test",
      PATH: "",
      AWS_PROFILE: "unrelated",
      AWS_REGION: "cn-north-1",
      AWS_ACCESS_KEY_ID: "must-not-appear",
      AWS_SECRET_ACCESS_KEY: "must-not-appear",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/unrelated|cn-north-1|must-not-appear/);
    const longerRegion = args.map((value) => (value === region ? "ap-southeast-7" : value));
    expect(JSON.stringify(rendered(longerRegion)).length).toBeLessThanOrEqual(6_144);
  });
});

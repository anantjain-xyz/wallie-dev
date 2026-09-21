import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/inspect-aws-staging.mjs", import.meta.url));
const accountId = "123456789012";
const region = "us-west-2";
const commonArgs = ["--account-id", accountId, "--region", region];
const inspectArgs = ["inspect", ...commonArgs, "--profile", "wallie-staging"];
const directories: string[] = [];

type Response = { json?: unknown; raw?: string; status?: number };

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function run(args = inspectArgs, overrides: Record<string, Response> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "wallie-aws-discovery-"));
  directories.push(directory);
  const log = join(directory, "calls.jsonl");
  const responses: Record<string, Response> = {
    "sts get-caller-identity": {
      json: { Account: accountId, Arn: `arn:aws:iam::${accountId}:user/discovery` },
    },
    "ec2 describe-vpcs": { json: [] },
    "ec2 describe-availability-zones": { json: [] },
    "rds describe-db-engine-versions": { json: [{ version: "17.6" }] },
    "rds describe-orderable-db-instance-options": { json: [] },
    "ec2 describe-instance-types": { json: [] },
    "ec2 describe-instance-type-offerings": { json: [] },
    "service-quotas get-service-quota": { json: { value: null } },
    ...overrides,
  };
  writeFileSync(log, "");
  writeFileSync(
    join(directory, "aws"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_AWS_LOG, JSON.stringify(args) + "\\n");
const response = JSON.parse(process.env.TEST_AWS_RESPONSES)[args.slice(0, 2).join(" ")];
if (!response) { process.stderr.write("Unexpected AWS operation"); process.exit(90); }
if (response.status) { process.stderr.write("AccessDenied: fixture denial"); process.exit(response.status); }
process.stdout.write(response.raw ?? JSON.stringify(response.json));
`,
    { mode: 0o700 },
  );
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      NODE_ENV: "test",
      PATH: `${directory}:${dirname(process.execPath)}`,
      HOME: directory,
      TEST_AWS_LOG: log,
      TEST_AWS_RESPONSES: JSON.stringify(responses),
    },
  });
  if (result.error) throw result.error;
  const calls = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  return { ...result, calls };
}

describe("AWS discovery CLI", () => {
  it("renders a narrowly scoped policy without invoking AWS", () => {
    const result = run(["policy", ...commonArgs]);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([]);
    const policy = JSON.parse(result.stdout) as {
      Statement: { Action: string[] | string; Resource: string; Condition: unknown }[];
    };
    expect(policy.Statement.flatMap((statement) => statement.Action).sort()).toEqual(
      [
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeInstanceTypeOfferings",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeVpcs",
        "rds:DescribeDBEngineVersions",
        "rds:DescribeOrderableDBInstanceOptions",
        "servicequotas:GetServiceQuota",
      ].sort(),
    );
    for (const statement of policy.Statement) {
      expect(statement.Condition).toEqual({
        StringEquals: { "aws:RequestedRegion": region, "aws:PrincipalAccount": accountId },
      });
      expect(statement.Resource).toBe(
        [statement.Action].flat().includes("servicequotas:GetServiceQuota")
          ? `arn:aws:servicequotas:${region}:${accountId}:ec2/L-1216C47A`
          : "*",
      );
    }
  });

  it.each([
    ["inspect", ...commonArgs],
    ["inspect", "--region", region, "--profile", "wallie-staging"],
    ["inspect", "--account-id", "123", "--region", region, "--profile", "wallie-staging"],
    ["inspect", "--account-id", accountId, "--region", "us_west_2", "--profile", "wallie-staging"],
    [...inspectArgs, "--region", "us-east-1"],
    [...inspectArgs, "--unknown", "value"],
    [...inspectArgs, "--runner-instance-type", "m7i.large;touch"],
  ])("rejects invalid or incomplete arguments before calling AWS: %j", (...args) => {
    const result = run(args);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.calls).toEqual([]);
  });

  it("preserves a missing quota value and forwards explicitly selected probes", () => {
    const result = run(
      [
        ...inspectArgs,
        "--runner-instance-type",
        "m8i.metal-24xl",
        "--db-instance-class",
        "db.m7g.large",
      ],
      { "service-quotas get-service-quota": { json: {} } },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).standardOnDemandVcpuQuota).toEqual({});
    expect(result.calls.find((call) => call[1] === "describe-instance-types")).toContain(
      "m8i.metal-24xl",
    );
    expect(
      result.calls.find((call) => call[1] === "describe-orderable-db-instance-options"),
    ).toContain("db.m7g.large");
  });

  it.each([
    { Account: "999999999999", Arn: "arn:aws:iam::999999999999:user/discovery" },
    { Account: accountId, Arn: `arn:aws:iam::${accountId}:root` },
  ])("stops after identity validation for an unsafe identity: %j", (identity) => {
    const result = run(inspectArgs, { "sts get-caller-identity": { json: identity } });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.calls.map((call) => call.slice(0, 2))).toEqual([["sts", "get-caller-identity"]]);
  });

  it("preserves empty findings and unknown quotas without claiming qualification", () => {
    const result = run();
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      schemaVersion: 1,
      purpose: "discovery-only",
      region,
      postgresMajor: 17,
      candidates: { runnerInstanceType: "m7i.large", dbInstanceClass: "db.t4g.medium" },
      availabilityZones: [],
      vpcs: [],
      databaseOptions: [],
      runnerTypes: [],
      runnerOfferings: [],
      standardOnDemandVcpuQuota: { value: null },
    });
    expect(result.stdout).not.toContain(accountId);
    expect(result.stdout).not.toContain("arn:aws:iam");
    expect(result.calls).toHaveLength(8);
    expect(result.calls[0].slice(0, 2)).toEqual(["sts", "get-caller-identity"]);
    for (const call of result.calls) {
      for (const [flag, value] of [
        ["--profile", "wallie-staging"],
        ["--region", region],
        ["--output", "json"],
        ["--cli-connect-timeout", "15"],
        ["--cli-read-timeout", "30"],
      ]) {
        expect(call[call.indexOf(flag) + 1]).toBe(value);
      }
      expect(call).toContain("--no-cli-pager");
      expect(call).toContain("--no-cli-auto-prompt");
      expect(call).not.toContain("--no-paginate");
      expect(call).not.toContain("--max-items");
    }
  });

  it.each<Response>([{ status: 254 }, { raw: "not-json" }, { json: {} }])(
    "fails without a partial report when a discovery response is invalid: %j",
    (response) => {
      const result = run(inspectArgs, { "ec2 describe-vpcs": response });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toBe("");
    },
  );

  it("discards completed discovery reads if the final quota response has an invalid shape", () => {
    const result = run(inspectArgs, { "service-quotas get-service-quota": { json: [] } });
    expect(result.status).not.toBe(0);
    expect(result.calls).toHaveLength(8);
    expect(result.stdout).toBe("");
  });
});

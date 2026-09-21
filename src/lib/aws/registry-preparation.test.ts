import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/prepare-aws-registry.mjs", import.meta.url));
const account = "123456789012";
const region = "us-west-2";
const common = ["--account-id", account, "--region", region];
const marker = "wallie-staging-registry";
const metadata = ["Project", "Environment", "ManagedBy", "Component", "Name"];
const array = (value: string | string[]) => (Array.isArray(value) ? value : [value]);
type Statement = {
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition: Record<string, Record<string, string | string[]>>;
};

function render(command: string, args = common) {
  return spawnSync(process.execPath, [script, command, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    env: { NODE_ENV: "test", PATH: "" },
  });
}

function grants(action: string) {
  const result = render("policy");
  expect(result.status).toBe(0);
  const statements = (JSON.parse(result.stdout).Statement as Statement[]).filter((statement) =>
    array(statement.Action).includes(`ecr:${action}`),
  );
  expect(statements.length).toBeGreaterThan(0);
  return statements;
}

describe("AWS registry preparation", () => {
  it.each([
    [region, "aws"],
    ["us-gov-west-1", "aws-us-gov"],
    ["cn-north-1", "aws-cn"],
  ])("renders a bounded provisioning policy offline for %s", (awsRegion, partition) => {
    const result = render("policy", ["--account-id", account, "--region", awsRegion]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(/<[A-Z_]+>|access_key|secret_key|token|profile/);
    const policy = JSON.parse(result.stdout);
    expect(policy.Version).toBe("2012-10-17");
    expect(JSON.stringify(policy).length).toBeLessThanOrEqual(6_144);
    const statements = policy.Statement as Statement[];
    expect([...new Set(statements.flatMap((statement) => array(statement.Action)))].sort()).toEqual(
      [
        "ecr:CreateRepository",
        "ecr:DescribeRepositories",
        "ecr:ListTagsForResource",
        "ecr:PutImageScanningConfiguration",
        "ecr:PutImageTagMutability",
        "ecr:TagResource",
        "ecr:UntagResource",
      ],
    );
    for (const statement of statements) {
      expect(statement.Effect).toBe("Allow");
      expect(statement.Condition.StringEquals).toMatchObject({
        "aws:PrincipalAccount": account,
        "aws:RequestedRegion": awsRegion,
      });
      expect(array(statement.Resource)).toEqual(
        ["web", "worker"].map(
          (name) =>
            `arn:${partition}:ecr:${awsRegion}:${account}:repository/wallie-staging/${name}`,
        ),
      );
    }
  });

  it("renders only account and region variables without AWS tools, credentials, or backend access", () => {
    const result = render("variables");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ aws_account_id: account, aws_region: region });
  });

  it.each([
    ["apply", common],
    ["policy", []],
    ["variables", ["--account-id", "123", "--region", region]],
    ["policy", ["--account-id", account, "--region", 'us-west-2"\nprofile="root']],
    ["policy", ["--account-id", account, "--region", "us-iso-east-1"]],
    ["policy", [...common, "--region", region]],
    ["variables", [...common, "--account-id", account]],
    ["policy", [...common, "--profile", "root"]],
    ["variables", [...common, "--component", "registry"]],
    ["policy", [...common, "--repository", "other"]],
    ["policy", [...common, "extra"]],
  ] as [string, string[]][])("rejects invalid or unsupported input: %s %j", (command, args) => {
    const result = render(command, args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-registry]");
  });
});

// Structural guards for this policy; these do not simulate AWS authorization.
describe("registry policy ownership", () => {
  it("requires the ownership tag on creation and rejects a different existing marker", () => {
    for (const { Condition: condition } of grants("CreateRepository")) {
      expect(condition.StringEquals["aws:RequestTag/WallieStack"]).toBe(marker);
      expect(condition.StringEqualsIfExists["aws:ResourceTag/WallieStack"]).toBe(marker);
      expect(condition["ForAllValues:StringEquals"]["aws:TagKeys"]).toEqual([
        "WallieStack",
        ...metadata,
      ]);
    }
  });

  it("preserves ownership while permitting the required ECR bootstrap-tagging exception", () => {
    for (const { Condition: condition } of grants("TagResource")) {
      if (condition.StringEquals["aws:ResourceTag/WallieStack"] === marker) {
        expect(condition.StringEqualsIfExists["aws:RequestTag/WallieStack"]).toBe(marker);
      } else {
        // ECR has no create-action discriminator: untagged fixed names must be absent at preflight.
        expect(condition.StringEquals["aws:RequestTag/WallieStack"]).toBe(marker);
        expect(condition.StringEqualsIfExists["aws:ResourceTag/WallieStack"]).toBe(marker);
      }
      expect(condition["ForAllValues:StringEquals"]["aws:TagKeys"]).toEqual([
        "WallieStack",
        ...metadata,
      ]);
    }
  });

  it.each(["PutImageScanningConfiguration", "PutImageTagMutability", "UntagResource"])(
    "requires existing ownership for %s",
    (action) => {
      for (const statement of grants(action)) {
        expect(statement.Condition.StringEquals["aws:ResourceTag/WallieStack"]).toBe(marker);
      }
    },
  );

  it("cannot remove the ownership marker or use an omitted tag-key list", () => {
    for (const { Condition: condition } of grants("UntagResource")) {
      expect(condition["ForAllValues:StringEquals"]["aws:TagKeys"]).toEqual(metadata);
      expect(condition.Null["aws:TagKeys"]).toBe("false");
    }
  });
});

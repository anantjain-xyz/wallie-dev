import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-image-publishing.mjs", import.meta.url),
);
const account = "123456789012";
const region = "us-west-2";
const common = ["--account-id", account, "--region", region];
const array = (value: string | string[]) => (Array.isArray(value) ? value : [value]);
const registryActions = ["ecr:GetAuthorizationToken", "ecr:GetRegistryScanningConfiguration"];
const repositoryActions = [
  "ecr:BatchCheckLayerAvailability",
  "ecr:BatchGetImage",
  "ecr:BatchGetRepositoryScanningConfiguration",
  "ecr:CompleteLayerUpload",
  "ecr:DescribeImageScanFindings",
  "ecr:DescribeImages",
  "ecr:DescribeRepositories",
  "ecr:InitiateLayerUpload",
  "ecr:ListTagsForResource",
  "ecr:PutImage",
  "ecr:UploadLayerPart",
];
type Statement = {
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition: Record<string, Record<string, string>>;
};

function render(command = "policy", args = common) {
  return spawnSync(process.execPath, [script, command, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    env: { NODE_ENV: "test", PATH: "" },
  });
}

describe("AWS image publishing preparation", () => {
  it.each([
    [region, "aws"],
    ["us-gov-west-1", "aws-us-gov"],
    ["cn-north-1", "aws-cn"],
  ])("renders the publishing policy offline for %s", (awsRegion, partition) => {
    const result = render("policy", ["--account-id", account, "--region", awsRegion]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(/<[A-Z_]+>|access_key|secret_key|profile|tfstate/);
    const policy = JSON.parse(result.stdout);
    expect(policy.Version).toBe("2012-10-17");
    expect(JSON.stringify(policy).length).toBeLessThanOrEqual(6_144);
    const statements = policy.Statement as Statement[];
    expect([...new Set(statements.flatMap((statement) => array(statement.Action)))].sort()).toEqual(
      [...registryActions, ...repositoryActions].sort(),
    );

    // Structural regression guards, not an AWS IAM authorization simulator.
    for (const statement of statements) {
      expect(statement.Effect).toBe("Allow");
      if (statement.Resource === "*") {
        expect(array(statement.Action).sort()).toEqual(registryActions);
        expect(statement.Condition).toEqual({
          StringEquals: { "aws:PrincipalAccount": account, "aws:RequestedRegion": awsRegion },
        });
      } else {
        expect(array(statement.Resource)).toEqual(
          ["web", "worker"].map(
            (name) =>
              `arn:${partition}:ecr:${awsRegion}:${account}:repository/wallie-staging/${name}`,
          ),
        );
        expect(statement.Condition).toEqual({
          StringEquals: {
            "aws:PrincipalAccount": account,
            "aws:RequestedRegion": awsRegion,
            "aws:ResourceTag/WallieStack": "wallie-staging-registry",
          },
        });
        expect(array(statement.Action).every((action) => repositoryActions.includes(action))).toBe(
          true,
        );
      }
    }
  });

  it("cannot grant repository operations through a wildcard or missing ownership condition", () => {
    const result = render();
    expect(result.status).toBe(0);
    const statements = JSON.parse(result.stdout).Statement as Statement[];
    for (const action of repositoryActions) {
      const grants = statements.filter((statement) => array(statement.Action).includes(action));
      expect(grants.length).toBeGreaterThan(0);
      for (const statement of grants) {
        expect(array(statement.Resource).every((resource) => !resource.includes("*"))).toBe(true);
        expect(statement.Condition.StringEquals["aws:ResourceTag/WallieStack"]).toBe(
          "wallie-staging-registry",
        );
        expect(statement.Condition).not.toHaveProperty("StringEqualsIfExists");
      }
    }
  });

  it.each([
    ["apply", common],
    ["variables", common],
    ["policy", []],
    ["policy", ["--account-id", "123", "--region", region]],
    ["policy", ["--account-id", `${account}\n`, "--region", region]],
    ["policy", ["--account-id", account, "--region", 'us-west-2"\nprofile="root']],
    ["policy", ["--account-id", account, "--region", "us-iso-east-1"]],
    ["policy", [...common, "--region", region]],
    ["policy", [...common, "--account-id", account]],
    ["policy", [...common, "--profile", "root"]],
    ["policy", [...common, "--repository", "other"]],
    ["policy", [...common, "--component", "web"]],
    ["policy", [...common, "--access-key-id", "secret"]],
    ["policy", [...common, "extra"]],
  ] as [string, string[]][])("rejects invalid or unsupported input: %s %j", (command, args) => {
    const result = render(command, args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-image-publishing]");
  });
});

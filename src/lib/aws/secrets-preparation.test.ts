import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/prepare-aws-secrets.mjs", import.meta.url));
const account = "123456789012";
const region = "us-west-2";
const args = ["--account-id", account, "--region", region];
const names = ["/wallie/staging/web/runtime", "/wallie/staging/worker/runtime"];
const arns = names.map((name) => `arn:aws:secretsmanager:${region}:${account}:secret:${name}`);
const marker = "wallie-staging-application";
const tagKeys = ["WallieStack", "Project", "Environment", "ManagedBy", "Component", "Name"];
type Statement = {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition: Record<string, Record<string, string | string[]>>;
};
const array = (value: string | string[]) => (Array.isArray(value) ? value : [value]);
function render(input = args) {
  return spawnSync(process.execPath, [script, ...input], {
    encoding: "utf8",
    timeout: 5000,
    env: { NODE_ENV: "test", PATH: "" },
  });
}
function statements() {
  const result = render();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout).Statement as Statement[];
}

// Structural grant boundaries, not an AWS authorization simulator.
describe("AWS runtime secret preparation", () => {
  it("renders offline within IAM size limits with only creation, tagging, and metadata reads", () => {
    const result = render();
    const policy = JSON.parse(result.stdout);
    expect(policy.Version).toBe("2012-10-17");
    expect(result.stdout).not.toMatch(/<[A-Z_]+>|SecretString|SecretBinary/);
    expect(JSON.stringify(policy).length).toBeLessThanOrEqual(6144);
    expect([...new Set(statements().flatMap((item) => array(item.Action)))].sort()).toEqual([
      "secretsmanager:CreateSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetResourcePolicy",
      "secretsmanager:ListSecretVersionIds",
      "secretsmanager:TagResource",
    ]);
  });

  it("bounds every grant to the account, region, and exact names with six-character service suffixes", () => {
    for (const item of statements()) {
      expect(item.Effect).toBe("Allow");
      expect(item.Condition.StringEquals).toMatchObject({
        "aws:PrincipalAccount": account,
        "aws:RequestedRegion": region,
      });
      for (const resource of array(item.Resource)) {
        expect(resource).not.toContain("*");
        expect(
          item.Action === "secretsmanager:DescribeSecret"
            ? arns.flatMap((arn) => [arn, `${arn}-??????`])
            : arns.map((arn) => `${arn}-??????`),
        ).toContain(resource);
      }
    }
  });

  it("requires all fixed tags and an exact name for creation, without replicas or a custom key", () => {
    const creates = statements().filter((item) => item.Action === "secretsmanager:CreateSecret");
    expect(creates).toHaveLength(2);
    for (const [index, item] of creates.entries()) {
      expect(item.Resource).toBe(`${arns[index]}-??????`);
      expect(item.Condition.StringEquals).toMatchObject({
        "secretsmanager:Name": names[index],
        "aws:RequestTag/Name": names[index],
        "aws:RequestTag/WallieStack": marker,
        "aws:RequestTag/Component": "runtime-secrets",
        "aws:RequestTag/Project": "Wallie",
        "aws:RequestTag/Environment": "staging",
        "aws:RequestTag/ManagedBy": "Terraform",
      });
      expect(item.Condition["ForAllValues:StringEquals"]["aws:TagKeys"]).toEqual(tagKeys);
      expect(item.Condition.Null).toEqual({
        "secretsmanager:AddReplicaRegions": "true",
        "secretsmanager:KmsKeyArn": "true",
        "secretsmanager:KmsKeyId": "true",
        "secretsmanager:Type": "true",
      });
      expect(item.Condition.BoolIfExists).toEqual({
        "secretsmanager:ForceOverwriteReplicaSecret": "false",
      });
    }
  });

  it("preserves existing ownership during required creation tagging and permits no tag removal", () => {
    const tags = statements().filter((item) => item.Action === "secretsmanager:TagResource");
    expect(tags).toHaveLength(2);
    for (const [index, item] of tags.entries()) {
      expect(item.Resource).toBe(`${arns[index]}-??????`);
      expect(item.Condition.StringEqualsIfExists).toEqual({
        "aws:ResourceTag/WallieStack": marker,
      });
      const requestTags = Object.keys(item.Condition.StringEquals)
        .filter((key) => key.startsWith("aws:RequestTag/"))
        .map((key) => key.slice("aws:RequestTag/".length));
      expect(requestTags).toEqual(tagKeys);
      expect(item.Condition["ForAllValues:StringEquals"]["aws:TagKeys"]).toEqual(tagKeys);
      expect(item.Condition.StringEquals["aws:RequestTag/WallieStack"]).toBe(marker);
      expect(item.Condition.StringEquals["aws:RequestTag/Name"]).toBe(names[index]);
      // Untagged exact-name resources can be claimed; absence must be checked live.
    }
  });

  it("allows missing-name description but requires owned, complete ARNs for policy/version inventory", () => {
    const items = statements();
    const describe = items.filter((item) => item.Action === "secretsmanager:DescribeSecret");
    expect(describe).toHaveLength(1);
    expect(describe[0].Resource).toEqual(arns.flatMap((arn) => [arn, `${arn}-??????`]));
    expect(describe[0].Condition).toEqual({
      StringEquals: { "aws:PrincipalAccount": account, "aws:RequestedRegion": region },
    });
    const inventory = items.filter((item) =>
      array(item.Action).includes("secretsmanager:ListSecretVersionIds"),
    );
    expect(inventory).toHaveLength(1);
    expect(inventory[0].Resource).toEqual(arns.map((arn) => `${arn}-??????`));
    expect(inventory[0].Condition.StringEquals["aws:ResourceTag/WallieStack"]).toBe(marker);
  });

  it.each([
    [],
    ["--account-id", account],
    ["--region", region],
    ["policy", ...args],
    ["--account-id", "12345", "--region", region],
    ["--account-id", "12345678901x", "--region", region],
    ["--account-id", ` ${account}`, "--region", region],
    ["--account-id", account, "--region", "us-west-2 "],
    ["--account-id", account, "--region", "us_west_2"],
    ["--account-id", account, "--region", "cn-north-1"],
    ["--account-id", account, "--region", "us-gov-west-1"],
    ["--account-id", account, "--region", "us-iso-east-1"],
    [...args, "--account-id", account],
    [...args, "--region", region],
    [...args, "--profile", "wallie-staging"],
  ])("rejects invalid or ambiguous inputs without emitting policy: %j", (...input) => {
    const result = render(input);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-secrets]");
  });
});

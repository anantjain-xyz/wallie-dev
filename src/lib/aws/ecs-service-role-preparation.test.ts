import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-ecs-service-role.mjs", import.meta.url),
);
const account = "123456789012";
const role = `arn:aws:iam::${account}:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS`;
const managedPolicy = "arn:aws:iam::aws:policy/aws-service-role/AmazonECSServiceRolePolicy";
const args = ["policy", "--account-id", account];
const array = (value: string | string[]) => (Array.isArray(value) ? value : [value]);
type Statement = {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string;
  Condition: { StringEquals: Record<string, string> };
};

function render(input = args, env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "" }) {
  return spawnSync(process.execPath, [script, ...input], {
    encoding: "utf8",
    timeout: 5000,
    env,
  });
}

function policy() {
  const result = render();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as { Version: string; Statement: Statement[] };
}

describe("ECS service-linked-role bootstrap preparation", () => {
  it("renders offline and permits only the bounded creation and verification actions", () => {
    const document = policy();
    expect(document.Version).toBe("2012-10-17");
    expect(document.Statement).toHaveLength(3);
    expect(JSON.stringify(document).length).toBeLessThanOrEqual(6144);
    expect([...new Set(document.Statement.flatMap((item) => array(item.Action)))].sort()).toEqual([
      "iam:CreateServiceLinkedRole",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:GetRole",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
    ]);
    for (const item of document.Statement) {
      expect(item.Effect).toBe("Allow");
      expect(item.Resource).not.toContain("*");
      expect(item.Condition.StringEquals["aws:PrincipalAccount"]).toBe(account);
      expect(item.Condition.StringEquals).not.toHaveProperty("aws:RequestedRegion");
    }
    expect(JSON.stringify(document)).not.toMatch(/<[A-Z_]+>|access_key|secret_key|token/);
  });

  it("allows creation only for the exact account, role name, service path and ECS service", () => {
    expect(policy().Statement[0]).toEqual({
      Sid: "CreateOnlyEcsServiceLinkedRole",
      Effect: "Allow",
      Action: "iam:CreateServiceLinkedRole",
      Resource: role,
      Condition: {
        StringEquals: {
          "aws:PrincipalAccount": account,
          "iam:AWSServiceName": "ecs.amazonaws.com",
        },
      },
    });
  });

  it("limits inspection to the exact role and AWS-owned managed policy", () => {
    expect(policy().Statement.slice(1)).toEqual([
      {
        Sid: "InspectExactEcsRole",
        Effect: "Allow",
        Action: ["iam:GetRole", "iam:ListAttachedRolePolicies", "iam:ListRolePolicies"],
        Resource: role,
        Condition: { StringEquals: { "aws:PrincipalAccount": account } },
      },
      {
        Sid: "InspectAwsManagedEcsPolicy",
        Effect: "Allow",
        Action: ["iam:GetPolicy", "iam:GetPolicyVersion"],
        Resource: managedPolicy,
        Condition: { StringEquals: { "aws:PrincipalAccount": account } },
      },
    ]);
  });

  it("renders the supplied account without inheriting credentials or alternate AWS configuration", () => {
    const result = render(["policy", "--account-id", "999999999999"], {
      NODE_ENV: "test",
      PATH: "",
      AWS_PROFILE: "unrelated",
      AWS_REGION: "cn-north-1",
      AWS_ACCESS_KEY_ID: "must-not-appear",
      AWS_SECRET_ACCESS_KEY: "must-not-appear",
      AWS_SESSION_TOKEN: "must-not-appear",
    });
    expect(result.status).toBe(0);
    const document = JSON.parse(result.stdout);
    expect(document.Statement[0].Resource).toBe(role.replace(account, "999999999999"));
    expect(result.stdout).not.toMatch(/must-not-appear|unrelated|cn-north-1/);
  });

  it.each(
    [
      [],
      ["apply", "--account-id", account],
      ["policy"],
      ...[
        "",
        "123",
        "1234567890123",
        "12345678901a",
        ` ${account}`,
        `${account}\n`,
        `${account}\r`,
      ].map((value) => ["policy", "--account-id", value]),
      [...args, "extra"],
      [...args, "--account-id", account],
      [...args, "--account-id", "999999999999"],
      [...args, "--region", "us-west-2"],
      [...args, "--profile", "root"],
      [...args, "--role-name", "OtherRole"],
      [...args, "--aws-service-name", "lambda.amazonaws.com"],
      [...args, "--partition", "aws-cn"],
    ].map((input) => ({ input })),
  )("rejects unsupported or ambiguous input: %j", ({ input }) => {
    const result = render(input);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-ecs-service-role]");
  });
});

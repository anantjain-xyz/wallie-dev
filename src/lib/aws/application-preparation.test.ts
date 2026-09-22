import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-application.mjs", import.meta.url),
);
const account = "123456789012";
const region = "us-west-2";
const common = ["--account-id", account, "--region", region];
const marker = "wallie-staging-application";
const cluster = `arn:aws:ecs:${region}:${account}:cluster/wallie-staging`;
const logs = ["web", "worker"].map(
  (component) => `arn:aws:logs:${region}:${account}:log-group:/wallie/staging/${component}`,
);
const metadata = ["Project", "Environment", "ManagedBy", "Component", "Name"];
const executionRoles = ["web", "worker"].map(
  (component) => `arn:aws:iam::${account}:role/wallie-staging-${component}-execution`,
);
const array = (value: string | string[]) => (Array.isArray(value) ? value : [value]);
type Statement = {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition: Record<string, Record<string, string | string[]>>;
};
function render(command: string, args = common) {
  return spawnSync(process.execPath, [script, command, ...args], {
    encoding: "utf8",
    timeout: 5000,
    env: { NODE_ENV: "test", PATH: "" },
  });
}
function statements() {
  const result = render("policy");
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout).Statement as Statement[];
}
function grants(action: string) {
  const found = statements().filter((statement) => array(statement.Action).includes(action));
  expect(found.length).toBeGreaterThan(0);
  return found;
}

// These assertions bound the grant; live service authorization still needs qualification.
describe("AWS application foundation preparation", () => {
  it("renders a customer-managed policy offline without deployment, IAM writes, or log contents access", () => {
    const result = render("policy");
    const policy = JSON.parse(result.stdout);
    expect(policy.Version).toBe("2012-10-17");
    expect(result.stdout).not.toMatch(/<[A-Z_]+>|access_key|secret_key|token/);
    expect(JSON.stringify(policy).length).toBeLessThanOrEqual(6144);
    const items = statements();
    expect([...new Set(items.flatMap((statement) => array(statement.Action)))].sort()).toEqual([
      "ecs:CreateCluster",
      "ecs:DescribeClusters",
      "ecs:ListTagsForResource",
      "ecs:TagResource",
      "ecs:UntagResource",
      "ecs:UpdateCluster",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "logs:CreateLogGroup",
      "logs:DescribeLogGroups",
      "logs:ListTagsForResource",
      "logs:PutLogGroupDeletionProtection",
      "logs:PutRetentionPolicy",
      "logs:TagResource",
      "logs:UntagResource",
    ]);
    for (const item of items) {
      expect(item.Effect).toBe("Allow");
      expect(item.Condition.StringEquals["aws:PrincipalAccount"]).toBe(account);
      if (!array(item.Action).includes("iam:GetRole"))
        expect(item.Condition.StringEquals["aws:RequestedRegion"]).toBe(region);
      for (const action of array(item.Action)) {
        for (const resource of array(item.Resource)) {
          if (action === "logs:DescribeLogGroups") expect(resource).toBe("*");
          else
            expect([
              cluster,
              ...logs,
              ...logs.map((arn) => `${arn}:*`),
              `arn:aws:iam::${account}:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS`,
              ...executionRoles,
            ]).toContain(resource);
        }
      }
    }
    expect(items.filter((item) => array(item.Resource).includes("*"))).toEqual(
      grants("logs:DescribeLogGroups"),
    );
  });

  it("limits both CloudWatch ARN forms to their reviewed API grants", () => {
    for (const action of [
      "logs:CreateLogGroup",
      "logs:PutRetentionPolicy",
      "logs:PutLogGroupDeletionProtection",
    ])
      for (const item of grants(action))
        expect(array(item.Resource)).toEqual(logs.map((arn) => `${arn}:*`));
    for (const action of ["logs:ListTagsForResource", "logs:UntagResource"])
      for (const item of grants(action))
        expect(array(item.Resource).filter((arn) => arn.includes(":logs:"))).toEqual(logs);
    for (const item of grants("logs:TagResource"))
      expect(array(item.Resource).filter((arn) => arn.includes(":logs:"))).toEqual(
        item.Sid === "TagNewLogGroups" ? [...logs, ...logs.map((arn) => `${arn}:*`)] : logs,
      );
    for (const action of [
      "ecs:CreateCluster",
      "ecs:DescribeClusters",
      "ecs:ListTagsForResource",
      "ecs:TagResource",
      "ecs:UntagResource",
      "ecs:UpdateCluster",
    ])
      for (const item of grants(action))
        expect(array(item.Resource).filter((arn) => arn.includes(":ecs:"))).toEqual([cluster]);
  });

  it("preserves every condition while covering tagged creation at the exact log-group names", () => {
    expect(statements().filter((item) => item.Sid === "TagNewLogGroups")).toEqual([
      {
        Sid: "TagNewLogGroups",
        Effect: "Allow",
        Action: "logs:TagResource",
        Resource: [...logs, ...logs.map((arn) => `${arn}:*`)],
        Condition: {
          StringEquals: {
            "aws:PrincipalAccount": account,
            "aws:RequestedRegion": region,
            "aws:RequestTag/WallieStack": marker,
          },
          "ForAllValues:StringEquals": { "aws:TagKeys": ["WallieStack", ...metadata] },
          StringEqualsIfExists: { "aws:ResourceTag/WallieStack": marker },
        },
      },
    ]);
  });

  it("permits prerequisite role reads but cannot create a service-linked role or pass one to a workload", () => {
    expect(
      grants("iam:GetRole").filter((item) => item.Sid === "ReadExistingEcsServiceRole"),
    ).toEqual([
      {
        Sid: "ReadExistingEcsServiceRole",
        Effect: "Allow",
        Action: "iam:GetRole",
        Resource: `arn:aws:iam::${account}:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS`,
        Condition: { StringEquals: { "aws:PrincipalAccount": account } },
      },
    ]);
  });

  it("adds only configuration reads for the two exact execution roles, without a new managed attachment", () => {
    const expected = {
      Sid: "ReadExecutionRoleConfiguration",
      Effect: "Allow",
      Action: [
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
      ],
      Resource: executionRoles,
      Condition: { StringEquals: { "aws:PrincipalAccount": account } },
    };
    for (const action of expected.Action)
      expect(grants(action).filter((item) => item.Sid !== "ReadExistingEcsServiceRole")).toEqual([
        expected,
      ]);
    const largest = render("policy", ["--account-id", account, "--region", "ap-southeast-7"]);
    expect(largest.status).toBe(0);
    expect(JSON.stringify(JSON.parse(largest.stdout)).length).toBeLessThanOrEqual(6144);
  });

  it("requires the ownership marker when creating resources and limits initial ECS tagging to creation", () => {
    for (const action of ["ecs:CreateCluster", "logs:CreateLogGroup"])
      for (const item of grants(action)) {
        expect(item.Condition.StringEquals["aws:RequestTag/WallieStack"]).toBe(marker);
        expect(item.Condition["ForAllValues:StringEquals"]["aws:TagKeys"]).toEqual([
          "WallieStack",
          ...metadata,
        ]);
      }
    const initial = grants("ecs:TagResource").filter(
      (item) => item.Condition.StringEquals["ecs:CreateAction"],
    );
    expect(initial).toHaveLength(1);
    expect(initial[0].Condition.StringEquals).toMatchObject({
      "ecs:CreateAction": "CreateCluster",
      "aws:RequestTag/WallieStack": marker,
    });
  });

  it("preserves existing ownership on every settings or tagging grant", () => {
    for (const action of [
      "ecs:UpdateCluster",
      "logs:PutRetentionPolicy",
      "logs:PutLogGroupDeletionProtection",
      "ecs:UntagResource",
      "logs:UntagResource",
    ])
      for (const item of grants(action))
        expect(item.Condition.StringEquals["aws:ResourceTag/WallieStack"]).toBe(marker);
    for (const action of ["ecs:TagResource", "logs:TagResource"])
      for (const item of grants(action)) {
        const condition = item.Condition;
        if (condition.StringEquals["ecs:CreateAction"]) continue;
        if (condition.StringEquals["aws:ResourceTag/WallieStack"] === marker)
          expect(condition.StringEqualsIfExists["aws:RequestTag/WallieStack"]).toBe(marker);
        else {
          // Logs lacks ECS's create-only context; exact-name absence preflight is required.
          expect(action).toBe("logs:TagResource");
          expect(condition.StringEquals["aws:RequestTag/WallieStack"]).toBe(marker);
          expect(condition.StringEqualsIfExists["aws:ResourceTag/WallieStack"]).toBe(marker);
        }
        expect(condition["ForAllValues:StringEquals"]["aws:TagKeys"]).toEqual([
          "WallieStack",
          ...metadata,
        ]);
      }
    for (const action of ["ecs:UntagResource", "logs:UntagResource"])
      for (const item of grants(action)) {
        expect(item.Condition["ForAllValues:StringEquals"]["aws:TagKeys"]).toEqual(metadata);
        expect(item.Condition.Null["aws:TagKeys"]).toBe("false");
      }
  });

  it("renders only account and region variables", () => {
    const result = render("variables");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ aws_account_id: account, aws_region: region });
  });

  it.each([
    ["apply", common],
    ["policy", []],
    ["variables", ["--account-id", "123", "--region", region]],
    ...[
      "cn-north-1",
      "us-gov-west-1",
      "us-iso-east-1",
      "us-west-2\n",
      'us-west-2"\nprofile="root',
    ].map((awsRegion) => ["policy", ["--account-id", account, "--region", awsRegion]]),
    ["policy", ["--account-id", `${account}\n`, "--region", region]],
    ["policy", [...common, "--region", region]],
    ["variables", [...common, "--account-id", account]],
    ["policy", [...common, "--profile", "root"]],
    ["policy", [...common, "extra"]],
  ] as [string, string[]][])("rejects unsupported or ambiguous input: %s %j", (command, args) => {
    const result = render(command, args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-application]");
  });
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-postgres-session-grant.mjs", import.meta.url),
);
const account = "123456789012";
const region = "us-west-2";
const vpc = "vpc-0123456789abcdef0";
const dbGroup = "sg-0123456789abcdef0";
const logsEndpoint = "vpce-0123456789abcdef0";
const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const common = ["--account-id", account, "--region", region, "--expires-at", expiresAt];
const networkArgs = [
  "--policy",
  "network",
  ...common,
  "--vpc-id",
  vpc,
  "--database-security-group-id",
  dbGroup,
  "--logs-endpoint-id",
  logsEndpoint,
];
const hostArgs = ["--policy", "host", ...common];

type Statement = {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition: Record<string, Record<string, string | string[]>>;
};
type Policy = { Version: string; Statement: Statement[] };
const actions = (statement: Statement) =>
  Array.isArray(statement.Action) ? statement.Action : [statement.Action];
const ec2Arn = (resource: string) => `arn:aws:ec2:${region}:${account}:${resource}`;
const logGroupArn = `arn:aws:logs:${region}:${account}:log-group:/wallie/staging/postgres/session`;
const roleArn = `arn:aws:iam::${account}:role/wallie-staging-postgres`;

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
  const expectedRegion = parameters[parameters.indexOf("--region") + 1];
  expect(policy.Version).toBe("2012-10-17");
  expect(JSON.stringify(policy).length).toBeLessThanOrEqual(6_144);
  for (const statement of policy.Statement) {
    expect(statement.Effect).toBe("Allow");
    expect(statement.Condition.DateLessThan).toEqual({ "aws:CurrentTime": expiresAt });
    expect(statement.Condition.StringEquals["aws:PrincipalAccount"]).toBe(account);
    if (!actions(statement).every((action) => action.startsWith("iam:"))) {
      expect(statement.Condition.StringEquals["aws:RequestedRegion"]).toBe(expectedRegion);
    }
  }
  return policy;
}

describe("temporary private PostgreSQL session-logging deployment grants", () => {
  it("limits the network grant to one named Logs path in the reviewed VPC", () => {
    const statements = rendered(networkArgs).Statement;
    expect(statements.map((statement) => statement.Sid)).toEqual([
      "CreateLogsGroupInOwnedVpc",
      "CreateNamedLogsEndpointGroup",
      "ManageNewLogsEndpointGroupRules",
      "AddDatabaseLogsEgress",
      "CreateTwoNamedLogsRules",
      "TagNamedLogsGroupOnlyAtCreation",
      "TagNamedLogsRulesOnlyAtCreation",
      "ModifyReviewedLogsEndpoint",
      "UseNewLogsEndpointGroup",
    ]);
    const bySid = Object.fromEntries(statements.map((statement) => [statement.Sid, statement]));
    expect(bySid.CreateLogsGroupInOwnedVpc.Resource).toBe(ec2Arn(`vpc/${vpc}`));
    expect(bySid.CreateNamedLogsEndpointGroup.Resource).toBe(ec2Arn("security-group/*"));
    expect(bySid.CreateNamedLogsEndpointGroup.Condition.StringEquals).toMatchObject({
      "aws:RequestTag/WallieStack": "wallie-staging-network",
      "aws:RequestTag/Component": "postgres-session-logging",
      "aws:RequestTag/Name": "wallie-staging-postgres-logs-endpoints",
    });
    expect(bySid.ManageNewLogsEndpointGroupRules.Condition.ArnEquals["ec2:Vpc"]).toBe(
      ec2Arn(`vpc/${vpc}`),
    );
    expect(bySid.AddDatabaseLogsEgress.Resource).toBe(ec2Arn(`security-group/${dbGroup}`));
    expect(bySid.AddDatabaseLogsEgress.Condition.StringEquals).toMatchObject({
      "aws:ResourceTag/Component": "self-hosted-supabase",
      "aws:ResourceTag/Name": "wallie-staging-supabase-db",
    });
    expect(bySid.CreateTwoNamedLogsRules.Resource).toBe(ec2Arn("security-group-rule/*"));
    expect(bySid.CreateTwoNamedLogsRules.Condition.StringEquals["aws:RequestTag/Name"]).toEqual([
      "wallie-staging-postgres-logs-ingress",
      "wallie-staging-postgres-logs-egress",
    ]);
    for (const sid of ["TagNamedLogsGroupOnlyAtCreation", "TagNamedLogsRulesOnlyAtCreation"]) {
      expect(bySid[sid].Action).toBe("ec2:CreateTags");
      expect(bySid[sid].Condition["ForAllValues:StringEquals"]["aws:TagKeys"]).toEqual([
        "WallieStack",
        "Project",
        "Environment",
        "ManagedBy",
        "Component",
        "Name",
      ]);
    }
    expect(bySid.TagNamedLogsGroupOnlyAtCreation.Condition.StringEquals["ec2:CreateAction"]).toBe(
      "CreateSecurityGroup",
    );
    expect(
      bySid.TagNamedLogsRulesOnlyAtCreation.Condition.StringEquals["ec2:CreateAction"],
    ).toEqual(["AuthorizeSecurityGroupIngress", "AuthorizeSecurityGroupEgress"]);
    expect(bySid.ModifyReviewedLogsEndpoint.Resource).toBe(ec2Arn(`vpc-endpoint/${logsEndpoint}`));
    expect(bySid.ModifyReviewedLogsEndpoint.Condition.StringEquals).toMatchObject({
      "aws:ResourceTag/Component": "private-connectivity",
      "aws:ResourceTag/Name": "wallie-staging-logs",
    });
    expect(bySid.UseNewLogsEndpointGroup.Resource).toBe(ec2Arn("security-group/*"));
    expect(bySid.UseNewLogsEndpointGroup.Condition.StringEquals["aws:ResourceTag/Name"]).toBe(
      "wallie-staging-postgres-logs-endpoints",
    );
    expect(statements.flatMap(actions).sort()).toEqual(
      [
        "ec2:CreateSecurityGroup",
        "ec2:CreateSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupEgress",
        "ec2:AuthorizeSecurityGroupEgress",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:AuthorizeSecurityGroupEgress",
        "ec2:CreateTags",
        "ec2:CreateTags",
        "ec2:ModifyVpcEndpoint",
        "ec2:ModifyVpcEndpoint",
      ].sort(),
    );
  });

  it("limits the host grant to one protected log group and the bounded host role", () => {
    const statements = rendered(hostArgs).Statement;
    expect(statements.map((statement) => statement.Sid)).toEqual([
      "ReadHostEc2InventoryForTerraform",
      "ReadLogGroupsForTerraform",
      "CreateNamedSessionLogGroup",
      "TagNamedSessionLogGroup",
      "SetSessionLogRetention",
      "ReadNamedSessionLogGroupTags",
      "ReadBoundedHostRole",
      "ReadHostInstanceProfile",
      "PutBoundedHostSessionLogsPolicy",
    ]);
    const bySid = Object.fromEntries(statements.map((statement) => [statement.Sid, statement]));
    expect(bySid.ReadHostEc2InventoryForTerraform.Resource).toBe("*");
    expect(actions(bySid.ReadHostEc2InventoryForTerraform)).toEqual([
      "ec2:DescribeImages",
      "ec2:DescribeInstances",
      "ec2:DescribeInstanceAttribute",
      "ec2:DescribeInstanceCreditSpecifications",
      "ec2:DescribeInstanceTypes",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSecurityGroupRules",
      "ec2:DescribeSubnets",
      "ec2:DescribeTags",
      "ec2:DescribeVpcs",
      "ec2:DescribeVpcEndpoints",
      "ec2:DescribeVolumes",
      "ec2:DescribeVolumeStatus",
    ]);
    expect(bySid.ReadLogGroupsForTerraform.Resource).toBe("*");
    expect(bySid.CreateNamedSessionLogGroup.Resource).toBe(`${logGroupArn}:*`);
    expect(bySid.CreateNamedSessionLogGroup.Condition.StringEquals).toMatchObject({
      "aws:RequestTag/WallieStack": "wallie-staging-postgres",
      "aws:RequestTag/Component": "postgres-host",
      "aws:RequestTag/Name": "/wallie/staging/postgres/session",
    });
    expect(bySid.TagNamedSessionLogGroup.Resource).toEqual([logGroupArn, `${logGroupArn}:*`]);
    expect(bySid.SetSessionLogRetention.Resource).toBe(`${logGroupArn}:*`);
    expect(bySid.ReadNamedSessionLogGroupTags.Resource).toBe(logGroupArn);
    expect(bySid.SetSessionLogRetention.Condition.StringEquals).toMatchObject({
      "aws:ResourceTag/WallieStack": "wallie-staging-postgres",
      "aws:ResourceTag/Name": "/wallie/staging/postgres/session",
    });
    expect(bySid.ReadBoundedHostRole.Resource).toBe(roleArn);
    expect(bySid.ReadHostInstanceProfile.Action).toBe("iam:GetInstanceProfile");
    expect(bySid.ReadHostInstanceProfile.Resource).toBe(
      `arn:aws:iam::${account}:instance-profile/wallie-staging-postgres`,
    );
    expect(bySid.PutBoundedHostSessionLogsPolicy.Resource).toBe(roleArn);
    expect(
      bySid.PutBoundedHostSessionLogsPolicy.Condition.ArnEquals["iam:PermissionsBoundary"],
    ).toBe(`arn:aws:iam::${account}:policy/WallieStagingPostgresHostBoundary`);
    expect(bySid.PutBoundedHostSessionLogsPolicy.Condition.StringEquals).toMatchObject({
      "aws:ResourceTag/WallieStack": "wallie-staging-postgres",
      "aws:ResourceTag/Name": "wallie-staging-postgres",
    });
    for (const excluded of [
      "iam:PutRolePermissionsBoundary",
      "logs:DeleteLogGroup",
      "logs:DeleteRetentionPolicy",
      "logs:PutLogGroupDeletionProtection",
    ]) {
      expect(statements.flatMap(actions)).not.toContain(excluded);
    }
  });

  it.each([
    ["missing network endpoint", networkArgs.slice(0, -2)],
    ["duplicate option", [...networkArgs, "--vpc-id", vpc]],
    ["extra host option", [...hostArgs, "--vpc-id", vpc]],
    ["unknown policy", ["--policy", "admin", ...common]],
    [
      "China region",
      networkArgs.map((value, index) =>
        index === networkArgs.indexOf("--region") + 1 ? "cn-north-1" : value,
      ),
    ],
    [
      "wildcard DB group",
      networkArgs.map((value, index) =>
        index === networkArgs.indexOf("--database-security-group-id") + 1 ? "sg-*" : value,
      ),
    ],
    [
      "expired",
      hostArgs.map((value, index) =>
        index === hostArgs.indexOf("--expires-at") + 1 ? "2026-01-01T00:00:00Z" : value,
      ),
    ],
    [
      "overlong",
      hostArgs.map((value, index) =>
        index === hostArgs.indexOf("--expires-at") + 1
          ? new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
          : value,
      ),
    ],
  ] as const)("rejects %s without output", (_label, parameters) => {
    const result = run(parameters);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-postgres-session-grant]");
  });

  it("ignores ambient AWS credentials and profile", () => {
    for (const parameters of [networkArgs, hostArgs]) {
      const result = run(parameters, {
        NODE_ENV: "test",
        PATH: "",
        AWS_PROFILE: "unrelated",
        AWS_REGION: "cn-north-1",
        AWS_ACCESS_KEY_ID: "must-not-appear",
        AWS_SECRET_ACCESS_KEY: "must-not-appear",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toMatch(/unrelated|cn-north-1|must-not-appear/);
    }
  });

  it("fits both IAM managed-policy limits in a longer commercial region", () => {
    for (const parameters of [networkArgs, hostArgs]) {
      const longerRegionArgs = parameters.map((value, index) =>
        index === parameters.indexOf("--region") + 1 ? "ap-southeast-7" : value,
      );
      expect(JSON.stringify(rendered(longerRegionArgs)).length).toBeLessThanOrEqual(6_144);
    }
  });
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-postgres-image-pull-grant.mjs", import.meta.url),
);
const account = "123456789012";
const region = "us-west-2";
const vpc = "vpc-0123456789abcdef0";
const dbGroup = "sg-0123456789abcdef0";
const dbRouteTable = "rtb-0123456789abcdef0";
const endpoints = ["vpce-0123456789abcdef0", "vpce-1123456789abcdef0", "vpce-2123456789abcdef0"];
const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const args = [
  "--account-id",
  account,
  "--region",
  region,
  "--vpc-id",
  vpc,
  "--database-security-group-id",
  dbGroup,
  "--database-route-table-id",
  dbRouteTable,
  "--ecr-api-endpoint-id",
  endpoints[0],
  "--ecr-dkr-endpoint-id",
  endpoints[1],
  "--image-layers-endpoint-id",
  endpoints[2],
  "--expires-at",
  expiresAt,
];
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
const awsArn = (resource: string) => `arn:aws:ec2:${region}:${account}:${resource}`;

function run(
  parameters: readonly string[] = args,
  env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "" },
) {
  return spawnSync(process.execPath, [script, ...parameters], {
    encoding: "utf8",
    timeout: 5_000,
    env,
  });
}

function rendered(parameters: readonly string[] = args) {
  const result = run(parameters);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toMatch(/<[A-Z_]+>/);
  const document = JSON.parse(result.stdout) as Policy;
  expect(document.Version).toBe("2012-10-17");
  expect(JSON.stringify(document).length).toBeLessThanOrEqual(6_144);
  for (const statement of document.Statement) {
    expect(statement.Effect).toBe("Allow");
    expect(statement.Condition.DateLessThan).toEqual({ "aws:CurrentTime": expiresAt });
    expect(statement.Condition.StringEquals).toMatchObject({
      "aws:PrincipalAccount": account,
      "aws:RequestedRegion": parameters[parameters.indexOf("--region") + 1],
    });
  }
  return document;
}

describe("temporary PostgreSQL private image-pull network grant", () => {
  it("scopes group and rule writes to the reviewed VPC and database group", () => {
    const statements = rendered().Statement;
    expect(statements.map((statement) => statement.Sid)).toEqual([
      "CreateGroupInOwnedVpc",
      "CreateNamedEndpointGroup",
      "ManageNewEndpointGroupRules",
      "AddDatabaseEgress",
      "CreateThreeNamedImageRules",
      "TagNamedGroupOnlyAtCreation",
      "TagNamedRulesOnlyAtCreation",
      "ModifyThreeReviewedEndpoints",
      "UseNewPostgresEndpointGroup",
      "UseDatabaseRouteTable",
    ]);
    const bySid = Object.fromEntries(statements.map((statement) => [statement.Sid, statement]));
    expect(bySid.CreateGroupInOwnedVpc.Resource).toBe(awsArn(`vpc/${vpc}`));
    expect(bySid.CreateGroupInOwnedVpc.Condition.StringEquals["aws:ResourceTag/WallieStack"]).toBe(
      "wallie-staging-network",
    );
    expect(bySid.CreateNamedEndpointGroup.Resource).toBe(awsArn("security-group/*"));
    expect(bySid.CreateNamedEndpointGroup.Condition.StringEquals).toMatchObject({
      "aws:RequestTag/Component": "postgres-image-pull",
      "aws:RequestTag/Name": "wallie-staging-postgres-ecr-endpoints",
    });
    expect(actions(bySid.ManageNewEndpointGroupRules)).toEqual([
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:RevokeSecurityGroupEgress",
    ]);
    expect(bySid.ManageNewEndpointGroupRules.Condition.ArnEquals["ec2:Vpc"]).toBe(
      awsArn(`vpc/${vpc}`),
    );
    expect(bySid.AddDatabaseEgress.Resource).toBe(awsArn(`security-group/${dbGroup}`));
    expect(bySid.AddDatabaseEgress.Condition.StringEquals).toMatchObject({
      "aws:ResourceTag/Component": "self-hosted-supabase",
      "aws:ResourceTag/Name": "wallie-staging-supabase-db",
    });
    expect(bySid.CreateThreeNamedImageRules.Resource).toBe(awsArn("security-group-rule/*"));
    expect(bySid.CreateThreeNamedImageRules.Condition.StringEquals["aws:RequestTag/Name"]).toEqual([
      "wallie-staging-postgres-ecr-ingress",
      "wallie-staging-postgres-ecr-egress",
      "wallie-staging-postgres-ecr-layers",
    ]);
    for (const sid of ["TagNamedGroupOnlyAtCreation", "TagNamedRulesOnlyAtCreation"]) {
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
    expect(bySid.TagNamedGroupOnlyAtCreation.Condition.StringEquals["ec2:CreateAction"]).toBe(
      "CreateSecurityGroup",
    );
    expect(bySid.TagNamedRulesOnlyAtCreation.Condition.StringEquals["ec2:CreateAction"]).toEqual([
      "AuthorizeSecurityGroupIngress",
      "AuthorizeSecurityGroupEgress",
    ]);
  });

  it("permits endpoint edits only for reviewed IDs and the newly added resources", () => {
    const statements = rendered().Statement.slice(7);
    expect(statements.map((statement) => statement.Sid)).toEqual([
      "ModifyThreeReviewedEndpoints",
      "UseNewPostgresEndpointGroup",
      "UseDatabaseRouteTable",
    ]);
    expect(
      statements.every((statement) => actions(statement).join() === "ec2:ModifyVpcEndpoint"),
    ).toBe(true);
    const bySid = Object.fromEntries(statements.map((statement) => [statement.Sid, statement]));
    expect(bySid.ModifyThreeReviewedEndpoints.Resource).toEqual(
      endpoints.map((id) => awsArn(`vpc-endpoint/${id}`)),
    );
    expect(
      bySid.ModifyThreeReviewedEndpoints.Condition.StringEquals["aws:ResourceTag/Name"],
    ).toEqual([
      "wallie-staging-ecr-api",
      "wallie-staging-ecr-dkr",
      "wallie-staging-ecr-image-layers",
    ]);
    expect(bySid.UseNewPostgresEndpointGroup.Resource).toBe(awsArn("security-group/*"));
    expect(bySid.UseNewPostgresEndpointGroup.Condition.StringEquals).toMatchObject({
      "aws:ResourceTag/Component": "postgres-image-pull",
      "aws:ResourceTag/Name": "wallie-staging-postgres-ecr-endpoints",
    });
    expect(bySid.UseDatabaseRouteTable.Resource).toBe(awsArn(`route-table/${dbRouteTable}`));
    expect(bySid.UseDatabaseRouteTable.Condition.StringEquals["aws:ResourceTag/Name"]).toBe(
      "wallie-staging-database-a",
    );
    expect(JSON.stringify(statements)).not.toContain("subnet/");
    expect(JSON.stringify(statements)).not.toContain("services-a");
    expect(JSON.stringify(statements)).not.toContain("wallie-staging-logs");
  });

  it.each([
    ["missing ID", args.slice(0, -2)],
    ["duplicate option", [...args, "--vpc-id", vpc]],
    ["unexpected option", [...args, "--profile", "root"]],
    [
      "repeated endpoint ID",
      args.map((value, index) =>
        index === args.indexOf("--ecr-dkr-endpoint-id") + 1 ? endpoints[0] : value,
      ),
    ],
    [
      "China region",
      args.map((value, index) => (index === args.indexOf("--region") + 1 ? "cn-north-1" : value)),
    ],
    [
      "wildcard SG",
      args.map((value, index) =>
        index === args.indexOf("--database-security-group-id") + 1 ? "sg-*" : value,
      ),
    ],
    [
      "expired",
      args.map((value, index) =>
        index === args.indexOf("--expires-at") + 1 ? "2026-01-01T00:00:00Z" : value,
      ),
    ],
    [
      "overlong",
      args.map((value, index) =>
        index === args.indexOf("--expires-at") + 1
          ? new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
          : value,
      ),
    ],
  ] as const)("rejects %s without emitting a policy", (_label, parameters) => {
    const result = run(parameters);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-postgres-image-pull-grant]");
  });

  it("fits the IAM policy limit in a longer commercial region", () => {
    const longerRegionArgs = args.map((value, index) =>
      index === args.indexOf("--region") + 1 ? "ap-southeast-7" : value,
    );
    expect(JSON.stringify(rendered(longerRegionArgs)).length).toBeLessThanOrEqual(6_144);
  });

  it("ignores ambient AWS credentials and profile", () => {
    const result = run(args, {
      PATH: "",
      NODE_ENV: "test",
      AWS_PROFILE: "unrelated",
      AWS_REGION: "cn-north-1",
      AWS_ACCESS_KEY_ID: "must-not-appear",
      AWS_SECRET_ACCESS_KEY: "must-not-appear",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/unrelated|cn-north-1|must-not-appear/);
  });
});

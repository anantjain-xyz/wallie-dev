import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-supabase-connectivity.mjs", import.meta.url),
);
const account = "123456789012";
const region = "us-west-2";
const vpc = "vpc-0123456789abcdef0";
const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const args = [
  "--account-id",
  account,
  "--region",
  region,
  "--vpc-id",
  vpc,
  "--expires-at",
  expiresAt,
];
const arn = `arn:aws:ec2:${region}:${account}:`;
const groupNames = [
  "wallie-staging-supabase-proxy",
  "wallie-staging-supabase-api",
  "wallie-staging-supabase-db",
];
const ruleNames = [
  "wallie-staging-supabase-proxy-api",
  "wallie-staging-supabase-api-proxy",
  "wallie-staging-supabase-api-db",
  "wallie-staging-supabase-db-api",
];
type Statement = {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string;
  Condition: Record<string, Record<string, string | string[]>>;
};
const actions = (value: Statement["Action"]) => (Array.isArray(value) ? value : [value]);

function run(parameters = args, env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "" }) {
  return spawnSync(process.execPath, [script, ...parameters], {
    encoding: "utf8",
    timeout: 5_000,
    env,
  });
}

function policy() {
  const result = run();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as { Version: string; Statement: Statement[] };
}

describe("temporary self-hosted Supabase connectivity grant", () => {
  it("renders only named SG and rule tag scopes for the planned slice", () => {
    const rendered = policy();
    expect(rendered.Version).toBe("2012-10-17");
    expect(JSON.stringify(rendered).length).toBeLessThanOrEqual(6_144);
    expect(rendered.Statement.map((statement) => statement.Sid)).toEqual([
      "CreateGroupsInOwnedVpc",
      "CreateThreeNamedGroups",
      "ManageOwnedGroupRulesInVpc",
      "CreateFourNamedRules",
      "TagNamedGroupsOnlyAtCreation",
      "TagNamedRulesOnlyAtCreation",
    ]);
    const bySid = Object.fromEntries(
      rendered.Statement.map((statement) => [statement.Sid, statement]),
    );

    expect(bySid.CreateGroupsInOwnedVpc.Resource).toBe(`${arn}vpc/${vpc}`);
    expect(bySid.CreateGroupsInOwnedVpc.Condition.StringEquals["aws:ResourceTag/WallieStack"]).toBe(
      "wallie-staging-network",
    );
    expect(bySid.CreateThreeNamedGroups.Resource).toBe(`${arn}security-group/*`);
    expect(bySid.CreateThreeNamedGroups.Condition.StringEquals["aws:RequestTag/Name"]).toEqual(
      groupNames,
    );
    expect(bySid.CreateFourNamedRules.Resource).toBe(`${arn}security-group-rule/*`);
    expect(bySid.CreateFourNamedRules.Condition.StringEquals["aws:RequestTag/Name"]).toEqual(
      ruleNames,
    );
    expect(bySid.ManageOwnedGroupRulesInVpc.Condition).toMatchObject({
      StringEquals: {
        "aws:ResourceTag/WallieStack": "wallie-staging-network",
        "aws:ResourceTag/Component": "self-hosted-supabase",
        "aws:ResourceTag/Name": groupNames,
      },
      ArnEquals: { "ec2:Vpc": `${arn}vpc/${vpc}` },
    });
    expect(actions(bySid.ManageOwnedGroupRulesInVpc.Action)).toEqual([
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:RevokeSecurityGroupEgress",
    ]);

    for (const statement of rendered.Statement) {
      expect(statement.Effect).toBe("Allow");
      expect(statement.Condition.StringEquals).toMatchObject({
        "aws:PrincipalAccount": account,
        "aws:RequestedRegion": region,
      });
      expect(statement.Condition.DateLessThan).toEqual({ "aws:CurrentTime": expiresAt });
      expect(statement.Resource).toMatch(new RegExp(`^${arn.replaceAll(".", "\\.")}`));
      expect(actions(statement.Action).every((action) => action.startsWith("ec2:"))).toBe(true);
    }
    expect(
      [...new Set(rendered.Statement.flatMap((statement) => actions(statement.Action)))].sort(),
    ).toEqual(
      [
        "ec2:CreateSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:AuthorizeSecurityGroupEgress",
        "ec2:RevokeSecurityGroupEgress",
        "ec2:CreateTags",
      ].sort(),
    );
  });

  it("permits tagging only during creation with exact name and ownership markers", () => {
    const statements = policy().Statement;
    for (const [resource, names, createAction] of [
      ["security-group/*", groupNames, "CreateSecurityGroup"],
      [
        "security-group-rule/*",
        ruleNames,
        ["AuthorizeSecurityGroupIngress", "AuthorizeSecurityGroupEgress"],
      ],
    ] as const) {
      const statement = statements.find(
        (candidate) =>
          actions(candidate.Action).includes("ec2:CreateTags") &&
          candidate.Resource === `${arn}${resource}`,
      );
      expect(statement?.Condition.StringEquals).toMatchObject({
        "aws:RequestTag/WallieStack": "wallie-staging-network",
        "aws:RequestTag/Component": "self-hosted-supabase",
        "aws:RequestTag/Name": names,
        "ec2:CreateAction": createAction,
      });
      expect(statement?.Condition["ForAllValues:StringEquals"]["aws:TagKeys"]).toEqual([
        "WallieStack",
        "Project",
        "Environment",
        "ManagedBy",
        "Component",
        "Name",
      ]);
    }
    expect(statements.flatMap((statement) => actions(statement.Action))).not.toContain(
      "ec2:DeleteTags",
    );
  });

  it.each([
    ["missing account", ["--region", region, "--vpc-id", vpc, "--expires-at", expiresAt]],
    ["repeated option", [...args, "--vpc-id", vpc]],
    ["unexpected option", [...args, "--profile", "root"]],
    ["positional option", [...args, "apply"]],
    [
      "China region",
      [
        "--account-id",
        account,
        "--region",
        "cn-north-1",
        "--vpc-id",
        vpc,
        "--expires-at",
        expiresAt,
      ],
    ],
    [
      "GovCloud region",
      [
        "--account-id",
        account,
        "--region",
        "us-gov-west-1",
        "--vpc-id",
        vpc,
        "--expires-at",
        expiresAt,
      ],
    ],
    [
      "wildcard VPC",
      ["--account-id", account, "--region", region, "--vpc-id", "vpc-*", "--expires-at", expiresAt],
    ],
    [
      "short VPC",
      [
        "--account-id",
        account,
        "--region",
        region,
        "--vpc-id",
        "vpc-123",
        "--expires-at",
        expiresAt,
      ],
    ],
    ["expired grant", [...args.slice(0, -1), "2026-01-01T00:00:00Z"]],
    [
      "overlong grant",
      [
        ...args.slice(0, -1),
        new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      ],
    ],
    ["non-UTC grant", [...args.slice(0, -1), "2026-09-23T00:00:00-07:00"]],
  ])("rejects %s without emitting a policy", (_description, parameters) => {
    const result = run(parameters);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-supabase-connectivity]");
  });

  it("ignores ambient AWS credentials and profile", () => {
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
  });
});

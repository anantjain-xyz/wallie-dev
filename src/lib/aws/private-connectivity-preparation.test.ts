import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-private-connectivity.mjs", import.meta.url),
);
const inputs = {
  "account-id": "123456789012",
  region: "us-west-2",
  "vpc-id": "vpc-0123456789abcdef0",
  "services-subnet-a-id": "subnet-0123456789abcdef0",
  "services-subnet-b-id": "subnet-0123456789abcdef1",
  "services-route-table-a-id": "rtb-0123456789abcdef0",
  "services-route-table-b-id": "rtb-0123456789abcdef1",
  "s3-prefix-list-arn": "arn:aws:ec2:us-west-2:aws:prefix-list/pl-01234567",
};
const argsFor = (values: Record<string, string>) =>
  Object.entries(values).flatMap(([key, value]) => [`--${key}`, value]);
const args = argsFor(inputs);
const array = (value: string | string[]) => (Array.isArray(value) ? value : [value]);
type Statement = {
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition: Record<string, Record<string, string | string[]>>;
};
const arn = `arn:aws:ec2:${inputs.region}:${inputs["account-id"]}:`;
const vpc = `${arn}vpc/${inputs["vpc-id"]}`;
const owned = {
  "aws:ResourceTag/WallieStack": "wallie-staging-network",
  "aws:ResourceTag/Component": "private-connectivity",
};
const requested = {
  "aws:RequestTag/WallieStack": "wallie-staging-network",
  "aws:RequestTag/Component": "private-connectivity",
};

function render(parameters = args, env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "" }) {
  return spawnSync(process.execPath, [script, ...parameters], {
    encoding: "utf8",
    timeout: 5000,
    env,
  });
}

function statements() {
  const result = render();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout).Statement as Statement[];
}

describe("private connectivity policy preparation", () => {
  it.each(["us-west-2", "ap-southeast-7"])("renders a bounded offline policy for %s", (region) => {
    const result = render(
      argsFor({
        ...inputs,
        region,
        "s3-prefix-list-arn": `arn:aws:ec2:${region}:aws:prefix-list/pl-0123456789abcdef0`,
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/<[A-Z_]+>|access_key|secret_key|token|profile/);
    const policy = JSON.parse(result.stdout);
    expect(policy.Version).toBe("2012-10-17");
    expect(JSON.stringify(policy).length).toBeLessThanOrEqual(6144);
    for (const statement of policy.Statement as Statement[]) {
      expect(statement.Effect).toBe("Allow");
      expect(statement.Condition.StringEquals).toMatchObject({
        "aws:PrincipalAccount": inputs["account-id"],
        "aws:RequestedRegion": region,
      });
      for (const resource of array(statement.Resource)) {
        if (resource === "*") {
          expect(array(statement.Action).every((action) => action.startsWith("ec2:Describe"))).toBe(
            true,
          );
        } else if (resource.includes(":aws:prefix-list/")) {
          expect(resource).toBe(`arn:aws:ec2:${region}:aws:prefix-list/pl-0123456789abcdef0`);
          expect(statement.Action).toBe("ec2:ModifySecurityGroupRules");
        } else {
          expect(resource).toMatch(new RegExp(`^arn:aws:ec2:${region}:${inputs["account-id"]}:`));
        }
      }
    }
    expect(
      [...new Set((policy.Statement as Statement[]).flatMap((s) => array(s.Action)))].sort(),
    ).toEqual(
      [
        "ec2:AuthorizeSecurityGroupEgress",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:CreateSecurityGroup",
        "ec2:CreateTags",
        "ec2:CreateVpcEndpoint",
        "ec2:DescribePrefixLists",
        "ec2:DescribeManagedPrefixLists",
        "ec2:DescribeSecurityGroupRules",
        "ec2:DescribeVpcEndpoints",
        "ec2:ModifySecurityGroupRules",
        "ec2:ModifyVpcEndpoint",
        "ec2:RevokeSecurityGroupEgress",
        "ec2:RevokeSecurityGroupIngress",
      ].sort(),
    );
  });

  it.each(Object.keys(inputs))("requires %s", (key) => {
    const values = { ...inputs } as Record<string, string>;
    delete values[key];
    const result = render(argsFor(values));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it.each([
    ["account-id", "123"],
    ["account-id", `${inputs["account-id"]}\n`],
    ["region", "cn-north-1"],
    ["region", "us-gov-west-1"],
    ["region", "us-iso-east-1"],
    ["region", `${inputs.region}\n`],
    ["vpc-id", "vpc-*"],
    ["services-subnet-a-id", "subnet-123"],
    ["services-subnet-b-id", inputs["services-subnet-a-id"]],
    ["services-route-table-a-id", inputs["services-subnet-a-id"]],
    ["services-route-table-b-id", inputs["services-route-table-a-id"]],
    ["s3-prefix-list-arn", "arn:aws:ec2:us-east-1:aws:prefix-list/pl-01234567"],
    ["s3-prefix-list-arn", "arn:aws:ec2:us-west-2:123456789012:prefix-list/pl-01234567"],
    ["s3-prefix-list-arn", "arn:aws:ec2:us-west-2:aws:prefix-list/*"],
    ["s3-prefix-list-arn", "arn:aws:ec2:us-west-2:aws:prefix-list/pl-012345678"],
    ["s3-prefix-list-arn", `${inputs["s3-prefix-list-arn"]}\n`],
  ])("rejects unsupported or ambiguous %s", (key, value) => {
    const result = render(argsFor({ ...inputs, [key]: value }));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-private-connectivity]");
  });

  it.each([["--vpc-id", inputs["vpc-id"]], ["--profile", "root"], ["apply"]])(
    "rejects extra or repeated arguments %j",
    (...extra) => {
      const result = render([...args, ...extra]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
    },
  );

  it("ignores ambient credentials and account configuration", () => {
    const result = render(args, {
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

// Policy structure checks are not an AWS authorization simulator.
describe("private connectivity ownership boundaries", () => {
  it("authorizes existing dependencies by exact ID without requiring creation tags", () => {
    const grants = statements();
    const dependencies = grants.filter((s) =>
      array(s.Resource).some((r) => /:(vpc|subnet|route-table)\//.test(r)),
    );
    expect(dependencies.flatMap((s) => array(s.Resource)).sort()).toEqual(
      [
        vpc,
        `${arn}subnet/${inputs["services-subnet-a-id"]}`,
        `${arn}subnet/${inputs["services-subnet-b-id"]}`,
        `${arn}route-table/${inputs["services-route-table-a-id"]}`,
        `${arn}route-table/${inputs["services-route-table-b-id"]}`,
      ].sort(),
    );
    for (const statement of dependencies) {
      expect(statement.Condition.StringEquals["aws:ResourceTag/WallieStack"]).toBe(
        "wallie-staging-network",
      );
      expect(JSON.stringify(statement.Condition)).not.toContain("aws:RequestTag/");
      expect(array(statement.Action)).not.toContain("ec2:CreateRoute");
      expect(array(statement.Action)).not.toContain("ec2:DeleteRoute");
    }
  });

  it("requires both ownership markers and the fixed names at resource creation", () => {
    const grants = statements();
    const names = {
      "security-group": ["wallie-staging-application-tasks", "wallie-staging-aws-endpoints"],
      "vpc-endpoint": [
        "wallie-staging-ecr-api",
        "wallie-staging-ecr-dkr",
        "wallie-staging-logs",
        "wallie-staging-ecr-image-layers",
      ],
      "security-group-rule": [
        "wallie-staging-endpoint-https",
        "wallie-staging-task-endpoint-https",
        "wallie-staging-task-layer-https",
      ],
    };
    for (const [resourceType, expected] of Object.entries(names)) {
      const statement = grants.find(
        (s) =>
          s.Resource === `${arn}${resourceType}/*` &&
          s.Condition.StringEquals["aws:RequestTag/Name"],
      )!;
      expect(statement.Condition.StringEquals).toMatchObject(requested);
      expect(statement.Condition.StringEquals["aws:RequestTag/Name"]).toEqual(expected);
      expect(statement.Condition["ForAllValues:StringEquals"]["aws:TagKeys"]).toEqual([
        "WallieStack",
        "Project",
        "Environment",
        "ManagedBy",
        "Component",
        "Name",
      ]);
    }
    const endpoints = grants.find(
      (s) => s.Resource === `${arn}vpc-endpoint/*` && s.Action === "ec2:CreateVpcEndpoint",
    )!;
    expect(endpoints.Condition.StringEquals["ec2:VpceServiceOwner"]).toBe("amazon");
    expect(endpoints.Condition.StringEquals["ec2:VpceServiceName"]).toEqual([
      "com.amazonaws.us-west-2.ecr.api",
      "com.amazonaws.us-west-2.ecr.dkr",
      "com.amazonaws.us-west-2.logs",
      "com.amazonaws.us-west-2.s3",
    ]);
  });

  it("restricts existing group changes to owned groups in the exact VPC", () => {
    const group = statements().find((s) =>
      array(s.Action).includes("ec2:RevokeSecurityGroupEgress"),
    )!;
    expect(group.Resource).toBe(`${arn}security-group/*`);
    expect(group.Condition.StringEquals).toMatchObject(owned);
    expect(group.Condition.ArnEquals).toEqual({ "ec2:Vpc": vpc });
    expect(array(group.Action)).toContain("ec2:RevokeSecurityGroupEgress");
    const updates = statements().find(
      (s) =>
        array(s.Action).includes("ec2:ModifySecurityGroupRules") &&
        array(s.Resource).includes(`${arn}security-group-rule/*`),
    )!;
    expect(updates.Resource).toEqual([`${arn}vpc-endpoint/*`, `${arn}security-group-rule/*`]);
    expect(updates.Condition.StringEquals).toMatchObject(owned);
  });

  it("allows the exact AWS-owned prefix list only as an SG-rule update reference", () => {
    const references = statements().filter((s) =>
      array(s.Resource).some((resource) => resource.includes(":prefix-list/")),
    );
    expect(references).toEqual([
      {
        Effect: "Allow",
        Action: "ec2:ModifySecurityGroupRules",
        Resource: inputs["s3-prefix-list-arn"],
        Condition: {
          StringEquals: {
            "aws:PrincipalAccount": inputs["account-id"],
            "aws:RequestedRegion": inputs.region,
          },
        },
      },
    ]);
  });

  it("cannot adopt resources or change/remove either ownership marker through tagging", () => {
    const tagGrants = statements().filter((s) => array(s.Action).includes("ec2:CreateTags"));
    expect(tagGrants).toHaveLength(2);
    for (const { Condition: condition } of tagGrants) {
      if (condition.StringEquals["ec2:CreateAction"]) {
        expect(condition.StringEquals).toMatchObject(requested);
        expect(condition.StringEquals["ec2:CreateAction"]).toEqual([
          "CreateSecurityGroup",
          "CreateVpcEndpoint",
          "AuthorizeSecurityGroupIngress",
          "AuthorizeSecurityGroupEgress",
        ]);
      } else {
        expect(condition.StringEquals).toMatchObject(owned);
        expect(condition.StringEqualsIfExists).toEqual(requested);
      }
    }
    expect(statements().flatMap((s) => array(s.Action))).not.toContain("ec2:DeleteTags");
  });
});

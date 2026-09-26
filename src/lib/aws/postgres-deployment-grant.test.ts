import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-postgres-deployment.mjs", import.meta.url),
);
const boundaryPath = fileURLToPath(
  new URL("../../../infra/aws/postgres-host-boundary-policy.template.json", import.meta.url),
);
const account = "123456789012";
const region = "us-west-2";
const vpc = "vpc-0123456789abcdef0";
const subnet = "subnet-0123456789abcdef0";
const dbGroup = "sg-0123456789abcdef0";
const ami = "ami-0123456789abcdef0";
const keyArn = `arn:aws:kms:${region}:${account}:key/01234567-89ab-cdef-0123-456789abcdef`;
const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const baseArgs = [
  "--account-id",
  account,
  "--region",
  region,
  "--vpc-id",
  vpc,
  "--subnet-id",
  subnet,
  "--database-security-group-id",
  dbGroup,
  "--ami-id",
  ami,
  "--kms-key-arn",
  keyArn,
  "--expires-at",
  expiresAt,
];
const ec2Arn = `arn:aws:ec2:${region}:${account}:`;
const roleArn = `arn:aws:iam::${account}:role/wallie-staging-postgres`;
const boundaryArn = `arn:aws:iam::${account}:policy/WallieStagingPostgresHostBoundary`;

type Statement = {
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition: Record<string, Record<string, string | string[]>>;
};
type Policy = { Version: string; Statement: Statement[] };
const array = (value: string | string[]) => (Array.isArray(value) ? value : [value]);
const actions = (statement: Statement) => array(statement.Action);
const resources = (statement: Statement) => array(statement.Resource);

function run(
  policy: string,
  args = baseArgs,
  env: NodeJS.ProcessEnv = { PATH: "", NODE_ENV: "test" },
) {
  return spawnSync(process.execPath, [script, "--policy", policy, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    env,
  });
}

function rendered(policy: "identity-network" | "compute-storage") {
  const result = run(policy);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  const document = JSON.parse(result.stdout) as Policy;
  expect(document.Version).toBe("2012-10-17");
  expect(JSON.stringify(document).length).toBeLessThanOrEqual(6_144);
  expect(result.stdout).not.toMatch(/<[A-Z_]+>/);
  return document;
}

function renderedBoundary() {
  const result = spawnSync(
    process.execPath,
    [script, "--policy", "host-boundary", "--account-id", account, "--region", region],
    { encoding: "utf8", timeout: 5_000, env: { PATH: "", NODE_ENV: "test" } },
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toMatch(/<[A-Z_]+>/);
  const document = JSON.parse(result.stdout) as Policy;
  expect(document.Version).toBe("2012-10-17");
  expect(JSON.stringify(document).length).toBeLessThanOrEqual(6_144);
  return document;
}

function findStatement(policy: Policy, action: string) {
  const matches = policy.Statement.filter((statement) => actions(statement).includes(action));
  expect(matches.length).toBeGreaterThan(0);
  return matches;
}

describe("offline PostgreSQL host deployment grants", () => {
  it("renders two expiring, disjoint managed policies without AWS credentials", () => {
    const identity = rendered("identity-network");
    const compute = rendered("compute-storage");
    expect(JSON.stringify(identity).length).toBeLessThan(6_144);
    expect(JSON.stringify(compute).length).toBeLessThan(6_144);
    expect(
      identity.Statement.some((statement) => actions(statement).includes("iam:CreateRole")),
    ).toBe(true);
    expect(
      compute.Statement.some((statement) => actions(statement).includes("ec2:RunInstances")),
    ).toBe(true);
    expect(findStatement(compute, "ec2:DescribeInstanceCreditSpecifications")[0].Resource).toBe(
      "*",
    );
    expect(findStatement(compute, "ec2:DescribeInstanceTypes")[0].Resource).toBe("*");
    expect(findStatement(compute, "ec2:DescribeTags")[0].Resource).toBe("*");
    for (const statement of [...identity.Statement, ...compute.Statement]) {
      expect(statement.Effect).toBe("Allow");
      expect(statement.Condition.StringEquals["aws:PrincipalAccount"]).toBe(account);
      expect(statement.Condition.DateLessThan).toEqual({ "aws:CurrentTime": expiresAt });
      if (actions(statement).every((action) => action.startsWith("iam:"))) {
        expect(statement.Condition.StringEquals).not.toHaveProperty("aws:RequestedRegion");
      } else {
        expect(statement.Condition.StringEquals["aws:RequestedRegion"]).toBe(region);
      }
      expect(actions(statement)).not.toContain("iam:PutRolePermissionsBoundary");
      expect(actions(statement)).not.toContain("iam:DeleteRolePermissionsBoundary");
      expect(
        actions(statement).every((action) => !/(?:Delete|Terminate|Detach)/.test(action)),
      ).toBe(true);
    }
    expect(
      [...identity.Statement, ...compute.Statement]
        .flatMap(actions)
        .filter((action) => action.startsWith("ssm:")),
    ).toEqual([]);
  });

  it("forces the exact permissions boundary before writing and passing the host role", () => {
    const policy = rendered("identity-network");
    const createRole = findStatement(policy, "iam:CreateRole")[0];
    expect(resources(createRole)).toEqual([roleArn]);
    expect(createRole.Condition.StringEquals["iam:PermissionsBoundary"]).toBe(boundaryArn);
    expect(createRole.Condition.StringEquals["aws:RequestTag/Name"]).toBe(
      "wallie-staging-postgres",
    );
    const putPolicy = findStatement(policy, "iam:PutRolePolicy")[0];
    expect(resources(putPolicy)).toEqual([roleArn]);
    expect(putPolicy.Condition.StringEquals["iam:PermissionsBoundary"]).toBe(boundaryArn);
    const compute = rendered("compute-storage");
    const passRole = findStatement(compute, "iam:PassRole")[0];
    expect(resources(passRole)).toEqual([roleArn]);
    expect(passRole.Condition.StringEquals["iam:PassedToService"]).toBe("ec2.amazonaws.com");
    expect(passRole.Condition).not.toHaveProperty("ArnEquals");
    expect(findStatement(policy, "iam:AddRoleToInstanceProfile")[0].Resource).toBe(
      `arn:aws:iam::${account}:instance-profile/wallie-staging-postgres`,
    );
    expect(
      policy.Statement.flatMap(actions)
        .filter((action) => action.startsWith("iam:"))
        .sort(),
    ).toEqual(
      [
        "iam:CreateRole",
        "iam:TagRole",
        "iam:CreateInstanceProfile",
        "iam:TagInstanceProfile",
        "iam:PutRolePolicy",
        "iam:AddRoleToInstanceProfile",
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:GetInstanceProfile",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
      ].sort(),
    );
    expect(findStatement(compute, "iam:PassRole")).toHaveLength(1);
    expect(policy.Statement.flatMap(actions)).not.toContain("iam:PassRole");
    const template = JSON.parse(readFileSync(boundaryPath, "utf8")) as Policy;
    expect(JSON.stringify(template)).toContain("<ACCOUNT_ID>");
    expect(JSON.stringify(template)).toContain("<REGION>");
    const boundary = renderedBoundary();
    expect(boundary.Statement.flatMap(actions).sort()).toEqual(
      [
        "ssm:UpdateInstanceInformation",
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel",
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ].sort(),
    );
  });

  it("caps the permanent host role at ECR auth and exact owned PostgreSQL repository reads", () => {
    const boundary = renderedBoundary();
    const auth = findStatement(boundary, "ecr:GetAuthorizationToken");
    expect(auth).toHaveLength(1);
    expect(auth[0].Resource).toBe("*");
    expect(auth[0].Condition.StringEquals).toEqual({
      "aws:PrincipalAccount": account,
      "aws:RequestedRegion": region,
    });

    const repositoryArn = `arn:aws:ecr:${region}:${account}:repository/wallie-staging/supabase-postgres`;
    const pull = findStatement(boundary, "ecr:BatchGetImage");
    expect(pull).toHaveLength(1);
    expect(actions(pull[0]).sort()).toEqual(
      ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"].sort(),
    );
    expect(pull[0].Resource).toBe(repositoryArn);
    expect(pull[0].Condition.StringEquals).toEqual({
      "aws:PrincipalAccount": account,
      "aws:RequestedRegion": region,
      "aws:ResourceTag/WallieStack": "wallie-staging-registry",
    });
    expect(
      boundary.Statement.flatMap(actions).some((action) =>
        /ecr:(?:Put|Delete|BatchDelete)/.test(action),
      ),
    ).toBe(false);
  });

  it("caps PostgreSQL shell transcripts at the named CloudWatch log group", () => {
    const boundary = renderedBoundary();
    const logGroupArn = `arn:aws:logs:${region}:${account}:log-group:/wallie/staging/postgres/session`;
    const logStreamArn = `${logGroupArn}:log-stream:*`;
    expect(findStatement(boundary, "logs:DescribeLogGroups")).toMatchObject([
      {
        Resource: "*",
        Condition: {
          StringEquals: {
            "aws:PrincipalAccount": account,
            "aws:RequestedRegion": region,
          },
        },
      },
    ]);
    const describeStreams = findStatement(boundary, "logs:DescribeLogStreams");
    expect(describeStreams).toHaveLength(1);
    expect(resources(describeStreams[0])).toHaveLength(2);
    expect(resources(describeStreams[0]).sort()).toEqual([logGroupArn, `${logGroupArn}:*`].sort());
    for (const action of ["logs:CreateLogStream", "logs:PutLogEvents"]) {
      expect(findStatement(boundary, action)).toMatchObject([{ Resource: logStreamArn }]);
    }
    expect(
      boundary.Statement.flatMap(actions)
        .filter((action) => action.startsWith("logs:"))
        .sort(),
    ).toEqual(
      [
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ].sort(),
    );
  });

  it.each([
    ["missing account", ["--policy", "host-boundary", "--region", region]],
    [
      "duplicate account",
      [
        "--policy",
        "host-boundary",
        "--account-id",
        account,
        "--account-id",
        account,
        "--region",
        region,
      ],
    ],
    [
      "extra deployment option",
      ["--policy", "host-boundary", "--account-id", account, "--region", region, "--vpc-id", vpc],
    ],
    [
      "invalid region",
      ["--policy", "host-boundary", "--account-id", account, "--region", "cn-north-1"],
    ],
  ])("rejects host boundary %s", (_name, args) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      timeout: 5_000,
      env: { PATH: "", NODE_ENV: "test" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-postgres-deployment]");
  });

  it("keeps both managed policies under the IAM size limit in a longer valid region", () => {
    const longRegion = "ap-southeast-7";
    const args = baseArgs.map((value) => {
      if (value === region) return longRegion;
      if (value === keyArn) return keyArn.replace(region, longRegion);
      return value;
    });
    for (const selectedPolicy of ["identity-network", "compute-storage"]) {
      const result = run(selectedPolicy, args);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.stringify(JSON.parse(result.stdout)).length).toBeLessThanOrEqual(6_144);
    }
  });

  it("limits the network slice to the reviewed VPC, DB subnet/group, and SSM endpoints", () => {
    const policy = rendered("identity-network");
    expect(
      findStatement(policy, "ec2:CreateSecurityGroup").some((statement) =>
        resources(statement).includes(`${ec2Arn}vpc/${vpc}`),
      ),
    ).toBe(true);
    expect(
      findStatement(policy, "ec2:CreateVpcEndpoint").some((statement) =>
        resources(statement).includes(`${ec2Arn}subnet/${subnet}`),
      ),
    ).toBe(true);
    const endpoint = findStatement(policy, "ec2:CreateVpcEndpoint").find((statement) =>
      resources(statement).includes(`${ec2Arn}vpc-endpoint/*`),
    );
    expect(endpoint?.Condition.StringEquals["ec2:VpceServiceName"]).toEqual([
      `com.amazonaws.${region}.ssm`,
      `com.amazonaws.${region}.ssmmessages`,
    ]);
    expect(endpoint?.Condition.StringEquals["ec2:VpceServiceOwner"]).toBe("amazon");
    const dbEgress = findStatement(policy, "ec2:AuthorizeSecurityGroupEgress").find((statement) =>
      resources(statement).includes(`${ec2Arn}security-group/${dbGroup}`),
    );
    expect(dbEgress?.Condition.ArnEquals["ec2:Vpc"]).toBe(`${ec2Arn}vpc/${vpc}`);
    expect(dbEgress?.Condition.StringEquals).toMatchObject({
      "aws:ResourceTag/WallieStack": "wallie-staging-network",
      "aws:ResourceTag/Component": "self-hosted-supabase",
      "aws:ResourceTag/Name": "wallie-staging-supabase-db",
    });
    const rules = findStatement(policy, "ec2:AuthorizeSecurityGroupIngress").find((statement) =>
      resources(statement).includes(`${ec2Arn}security-group-rule/*`),
    );
    expect(rules?.Condition.StringEquals["aws:RequestTag/Name"]).toEqual([
      "wallie-staging-postgres-ssm-ingress",
      "wallie-staging-postgres-ssm-egress",
    ]);
  });

  it("pins launch inputs, requires encrypted storage, and confines KMS to the verified key", () => {
    const policy = rendered("compute-storage");
    const launchResources = policy.Statement.filter((statement) =>
      actions(statement).includes("ec2:RunInstances"),
    ).flatMap(resources);
    expect(new Set(launchResources)).toEqual(
      new Set([
        `arn:aws:ec2:${region}::image/${ami}`,
        `${ec2Arn}security-group/${dbGroup}`,
        `${ec2Arn}instance/*`,
        `${ec2Arn}network-interface/*`,
        `${ec2Arn}volume/*`,
      ]),
    );
    const launchNetwork = findStatement(policy, "ec2:RunInstances").find((statement) =>
      resources(statement).includes(`${ec2Arn}network-interface/*`),
    );
    expect(launchNetwork?.Condition.Bool["ec2:AssociatePublicIpAddress"]).toBe("false");
    const launchRoot = findStatement(policy, "ec2:RunInstances").find((statement) =>
      resources(statement).includes(`${ec2Arn}volume/*`),
    );
    expect(launchRoot?.Condition.Bool["ec2:Encrypted"]).toBe("true");
    const dataVolume = findStatement(policy, "ec2:CreateVolume")[0];
    expect(dataVolume.Condition.Bool["ec2:Encrypted"]).toBe("true");
    expect(dataVolume.Condition.StringEquals["ec2:VolumeType"]).toBe("gp3");
    expect(dataVolume.Condition.StringEquals["ec2:KmsKeyId"]).toBe(keyArn);
    expect(dataVolume.Condition.StringEquals["aws:RequestTag/Name"]).toBe(
      "wallie-staging-postgres-data",
    );
    const attach = findStatement(policy, "ec2:AttachVolume")[0];
    expect(new Set(resources(attach))).toEqual(
      new Set([`${ec2Arn}instance/*`, `${ec2Arn}volume/*`]),
    );
    expect(
      findStatement(policy, "ec2:ModifyInstanceAttribute")[0].Condition.StringEquals[
        "ec2:Attribute"
      ],
    ).toBe("disableApiTermination");
    for (const statement of policy.Statement.filter((item) =>
      actions(item).some((action) => action.startsWith("kms:")),
    )) {
      expect(statement.Resource).toBe(keyArn);
      expect(statement.Condition.StringEquals["kms:ViaService"]).toBe(
        `ec2.${region}.amazonaws.com`,
      );
    }
    expect(findStatement(policy, "kms:CreateGrant")[0].Condition.Bool).toEqual({
      "kms:GrantIsForAWSResource": "true",
    });
  });

  it.each([
    ["missing account", baseArgs.slice(2)],
    ["duplicate account", [...baseArgs, "--account-id", account]],
    ["unknown option", [...baseArgs, "--profile", "root"]],
    ["wildcard VPC", baseArgs.map((value) => (value === vpc ? "vpc-*" : value))],
    [
      "wrong key account",
      baseArgs.map((value) => (value === keyArn ? keyArn.replace(account, "999999999999") : value)),
    ],
    [
      "wrong key region",
      baseArgs.map((value) => (value === keyArn ? keyArn.replace(region, "us-east-1") : value)),
    ],
    ["expired", baseArgs.map((value) => (value === expiresAt ? "2026-01-01T00:00:00Z" : value))],
    [
      "non-UTC expiry",
      baseArgs.map((value) => (value === expiresAt ? "2026-09-26T12:00:00-07:00" : value)),
    ],
  ])("rejects %s without emitting a grant", (_name, args) => {
    const result = run("identity-network", args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-postgres-deployment]");
  });

  it("requires one recognized policy selector", () => {
    for (const args of [
      baseArgs,
      ["--policy", "identity-network", "--policy", "compute-storage", ...baseArgs],
      ["--policy", "all", ...baseArgs],
    ]) {
      const result = spawnSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        timeout: 5_000,
        env: { PATH: "", NODE_ENV: "test" },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
    }
  });

  it("ignores ambient AWS profile and credentials", () => {
    const result = run("compute-storage", baseArgs, {
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

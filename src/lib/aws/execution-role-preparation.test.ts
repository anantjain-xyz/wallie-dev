import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-execution-roles.mjs", import.meta.url),
);
const account = "123456789012";
const region = "us-west-2";
const common = ["--account-id", account, "--region", region];
function run(command: string, component = "web", extra: string[] = [], base = common) {
  return spawnSync(
    process.execPath,
    [script, command, ...base, "--component", component, ...extra],
    {
      encoding: "utf8",
      timeout: 5000,
      env: {
        NODE_ENV: "test",
        PATH: "",
        AWS_PROFILE: "must-not-be-used",
        AWS_ACCESS_KEY_ID: "ambient-not-used",
      },
    },
  );
}
function artifact(command: string, component = "web") {
  const result = run(command, component);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}
function readback(component = "web") {
  const manifest = artifact("manifest", component);
  const { PermissionsBoundary: _boundary, ...role } = manifest.role;
  void _boundary;
  return {
    "get-role": { Role: { ...role, RoleId: "AROAEXAMPLE", CreateDate: "2026-09-22T00:00:00Z" } },
    "list-role-policies": { PolicyNames: manifest.inlinePolicyNames, IsTruncated: false },
    "list-attached-role-policies": {
      AttachedPolicies: manifest.attachedPolicyArns,
      IsTruncated: false,
    },
    "get-role-policy": manifest.inlinePolicy,
  };
}
function verify(fixture: ReturnType<typeof readback>, component = "web") {
  const directory = mkdtempSync(join(tmpdir(), "wallie-execution-role-"));
  try {
    for (const [name, value] of Object.entries(fixture))
      writeFileSync(join(directory, `${name}.json`), JSON.stringify(value));
    return run("verify", component, ["--readback-dir", directory]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("AWS execution-role bootstrap", () => {
  it.each(["web", "worker"])(
    "renders only the fixed %s role and its own image/log permissions offline",
    (component) => {
      const create = artifact("create-role-input", component);
      const put = artifact("put-role-policy-input", component);
      const manifest = artifact("manifest", component);
      expect(create.RoleName).toBe(`wallie-staging-${component}-execution`);
      expect(create.Path).toBe("/");
      expect(create.MaxSessionDuration).toBe(3600);
      expect(create.PermissionsBoundary).toBeUndefined();
      expect(create.Tags).toContainEqual({ Key: "ManagedBy", Value: "Administrator" });
      expect(put.RoleName).toBe(create.RoleName);
      expect(put.PolicyName).toBe("WallieStagingExecution");
      const trust = JSON.parse(create.AssumeRolePolicyDocument);
      expect(trust).toEqual({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
            Action: "sts:AssumeRole",
            Condition: {
              StringEquals: { "aws:SourceAccount": account },
              ArnLike: { "aws:SourceArn": `arn:aws:ecs:${region}:${account}:*` },
            },
          },
        ],
      });
      const policy = JSON.parse(put.PolicyDocument);
      const array = (x: string | string[]) => (Array.isArray(x) ? x : [x]);
      expect(policy.Statement).toHaveLength(3);
      expect(policy.Statement.map((s: { Resource: string }) => s.Resource)).toEqual([
        "*",
        `arn:aws:ecr:${region}:${account}:repository/wallie-staging/${component}`,
        `arn:aws:logs:${region}:${account}:log-group:/wallie/staging/${component}:log-stream:*`,
      ]);
      expect(
        policy.Statement.flatMap((s: { Action: string | string[] }) => array(s.Action)),
      ).toEqual([
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ]);
      for (const statement of policy.Statement) {
        expect(statement.Effect).toBe("Allow");
        expect(statement.Condition).toEqual({
          StringEquals: { "aws:PrincipalAccount": account, "aws:RequestedRegion": region },
        });
      }
      expect(manifest.role.Arn).toBe(`arn:aws:iam::${account}:role/${create.RoleName}`);
      expect(manifest.role.AssumeRolePolicyDocument).toEqual(trust);
      expect(manifest.inlinePolicy.PolicyDocument).toEqual(policy);
      expect(manifest.inlinePolicyNames).toEqual([put.PolicyName]);
      expect(manifest.attachedPolicyArns).toEqual([]);
      expect(JSON.stringify(manifest)).not.toMatch(
        /secretsmanager:|ssm:|kms:|iam:PassRole|s3:|ecr:PutImage|logs:CreateLogGroup/,
      );
    },
  );

  it.each(["web", "worker"])(
    "accepts exact %s readback while disclaiming live runtime qualification",
    (component) => {
      const result = verify(readback(component), component);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "readback-matches-manifest",
        component,
        region,
      });
      expect(JSON.parse(result.stdout).limitation).toContain("remain unqualified");
    },
  );

  it("accepts IAM encoding, statement order, and scalar/singleton representation changes only", () => {
    const fixture = readback();
    const trust = fixture["get-role"].Role.AssumeRolePolicyDocument;
    trust.Statement[0].Action = [trust.Statement[0].Action];
    trust.Statement[0].Principal.Service = [trust.Statement[0].Principal.Service];
    trust.Statement[0].Condition.StringEquals["aws:SourceAccount"] = [account];
    trust.Statement = trust.Statement[0];
    fixture["get-role"].Role.AssumeRolePolicyDocument = encodeURIComponent(JSON.stringify(trust));
    fixture["get-role"].Role.Tags.reverse();
    const policy = fixture["get-role-policy"].PolicyDocument;
    policy.Statement.reverse();
    for (const statement of policy.Statement) statement.Resource = [statement.Resource];
    fixture["get-role-policy"].PolicyDocument = JSON.stringify(policy);
    expect(verify(fixture).status).toBe(0);
  });

  const mutations: [string, (fixture: ReturnType<typeof readback>) => void][] = [
    [
      "wrong account",
      (f) => {
        f["get-role"].Role.Arn = f["get-role"].Role.Arn.replace(account, "999999999999");
      },
    ],
    [
      "wrong role name",
      (f) => {
        f["get-role"].Role.RoleName = "another-role";
      },
    ],
    [
      "wrong path",
      (f) => {
        f["get-role"].Role.Path = "/service-role/";
      },
    ],
    [
      "wrong session duration",
      (f) => {
        f["get-role"].Role.MaxSessionDuration = 43200;
      },
    ],
    [
      "unexpected boundary",
      (f) => {
        f["get-role"].Role.PermissionsBoundary = {
          PermissionsBoundaryArn: "arn:aws:iam::123456789012:policy/unreviewed",
        };
      },
    ],
    [
      "missing tags",
      (f) => {
        f["get-role"].Role.Tags.pop();
      },
    ],
    [
      "duplicate tags",
      (f) => {
        f["get-role"].Role.Tags.push(f["get-role"].Role.Tags[0]);
      },
    ],
    [
      "extra trusted principal",
      (f) => {
        f["get-role"].Role.AssumeRolePolicyDocument.Statement[0].Principal.AWS =
          `arn:aws:iam::${account}:root`;
      },
    ],
    [
      "wrong service principal",
      (f) => {
        f["get-role"].Role.AssumeRolePolicyDocument.Statement[0].Principal.Service =
          "ecs.amazonaws.com";
      },
    ],
    [
      "missing source account",
      (f) => {
        delete f["get-role"].Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals;
      },
    ],
    [
      "wildcard source region",
      (f) => {
        f["get-role"].Role.AssumeRolePolicyDocument.Statement[0].Condition.ArnLike[
          "aws:SourceArn"
        ] = `arn:aws:ecs:*:${account}:*`;
      },
    ],
    [
      "extra trust action",
      (f) => {
        f["get-role"].Role.AssumeRolePolicyDocument.Statement[0].Action = [
          "sts:AssumeRole",
          "sts:TagSession",
        ];
      },
    ],
    [
      "extra trust statement",
      (f) => {
        f["get-role"].Role.AssumeRolePolicyDocument.Statement.push({
          Effect: "Allow",
          Principal: "*",
          Action: "sts:AssumeRole",
        });
      },
    ],
    [
      "other component repository",
      (f) => {
        f["get-role-policy"].PolicyDocument.Statement[1].Resource =
          `arn:aws:ecr:${region}:${account}:repository/wallie-staging/worker`;
      },
    ],
    [
      "all log groups",
      (f) => {
        f["get-role-policy"].PolicyDocument.Statement[2].Resource = "*";
      },
    ],
    [
      "extra inline action",
      (f) => {
        f["get-role-policy"].PolicyDocument.Statement[1].Action.push("ecr:PutImage");
      },
    ],
    [
      "extra inline statement",
      (f) => {
        f["get-role-policy"].PolicyDocument.Statement.push({
          Effect: "Allow",
          Action: "secretsmanager:GetSecretValue",
          Resource: "*",
        });
      },
    ],
    [
      "missing permissions condition",
      (f) => {
        delete f["get-role-policy"].PolicyDocument.Statement[1].Condition;
      },
    ],
    [
      "another inline policy name",
      (f) => {
        f["get-role-policy"].PolicyName = "unreviewed";
      },
    ],
    [
      "wrong inline role",
      (f) => {
        f["get-role-policy"].RoleName = "wallie-staging-worker-execution";
      },
    ],
    [
      "additional inline policy",
      (f) => {
        f["list-role-policies"].PolicyNames.push("unreviewed");
      },
    ],
    [
      "managed attachment",
      (f) => {
        f["list-attached-role-policies"].AttachedPolicies.push({
          PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
          PolicyName: "AdministratorAccess",
        });
      },
    ],
    [
      "truncated inline policies",
      (f) => {
        f["list-role-policies"].IsTruncated = true;
      },
    ],
    [
      "truncated managed policies",
      (f) => {
        f["list-attached-role-policies"].IsTruncated = true;
      },
    ],
    [
      "pagination continuation",
      (f) => {
        (f["list-attached-role-policies"] as Record<string, unknown>).NextToken = "more";
      },
    ],
    [
      "malformed encoded policy",
      (f) => {
        f["get-role-policy"].PolicyDocument = "%broken";
      },
    ],
  ];
  it.each(mutations)("rejects %s without emitting a verified result", (_name, mutate) => {
    const fixture = readback();
    mutate(fixture);
    const result = verify(fixture);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-execution-roles]");
  });

  it.each([undefined, null, "true", "false", true, 0])(
    "rejects ambiguous or incomplete list pagination %j",
    (flag) => {
      for (const name of ["list-role-policies", "list-attached-role-policies"] as const) {
        const fixture = readback();
        (fixture[name] as Record<string, unknown>).IsTruncated = flag;
        const result = verify(fixture);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Incomplete readback pagination");
      }
    },
  );

  it("fails closed on missing files and does not print malformed input contents", () => {
    const directory = mkdtempSync(join(tmpdir(), "wallie-execution-role-"));
    try {
      let result = run("verify", "web", ["--readback-dir", directory]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("get-role.json");
      writeFileSync(join(directory, "get-role.json"), "private-input-must-not-appear");
      result = run("verify", "web", ["--readback-dir", directory]);
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain("private-input");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["apply", "web", [], common],
    ["manifest", "api", [], common],
    ["manifest", "web", [], ["--account-id", "123", "--region", region]],
    ...["cn-north-1", "us-gov-west-1", "us-iso-east-1", "us-west-2\n"].map((value) => [
      "manifest",
      "web",
      [],
      ["--account-id", account, "--region", value],
    ]),
    ["manifest", "web", [], ["--account-id", `${account}\n`, "--region", region]],
    ["manifest", "web", ["--component", "worker"], common],
    ["manifest", "web", ["--role-name", "arbitrary"], common],
    ["manifest", "web", ["--profile", "root"], common],
    ["manifest", "web", ["--readback-dir", "/tmp"], common],
    ["manifest", "web", ["extra"], common],
    ["verify", "web", [], common],
  ] as [string, string, string[], string[]][])(
    "rejects ambiguous or unsupported CLI input %s %s %j",
    (command, component, extra, base) => {
      const result = run(command, component, extra, base);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("[aws-execution-roles]");
    },
  );
});

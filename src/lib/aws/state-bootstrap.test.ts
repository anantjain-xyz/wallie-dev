import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const script = fileURLToPath(new URL("../../../scripts/prepare-aws-state.mjs", import.meta.url));
const account = "123456789012";
const region = "us-west-2";
const bucket = `wallie-staging-tfstate-${account}-${region}`;
const bucketArn = `arn:aws:s3:::${bucket}`;

function render(command: string, args = ["--account-id", account, "--region", region]) {
  return spawnSync(process.execPath, [script, command, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    // Rendering must work without AWS binaries, profiles, credentials, or network access.
    env: { NODE_ENV: "test", PATH: "" },
  });
}

type Statement = {
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition: { StringEquals: Record<string, string> };
};
const array = (value: string | string[]) => (Array.isArray(value) ? value : [value]);

describe("AWS state preparation", () => {
  it.each(["bootstrap-policy", "access-policy"])("renders %s offline", (command) => {
    const result = render(command);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(/<[A-Z_]+>/);
    const policy = JSON.parse(result.stdout);
    expect(policy.Version).toBe("2012-10-17");
    expect(policy.Statement.length).toBeGreaterThan(0);
    for (const statement of policy.Statement as Statement[]) {
      expect(statement.Effect).toBe("Allow");
      expect(statement.Condition.StringEquals["aws:PrincipalAccount"]).toBe(account);
      expect(array(statement.Resource)).not.toContain("*");
      expect(array(statement.Action).every((action) => /^(s3|cloudformation):/.test(action))).toBe(
        true,
      );
    }
  });

  it("scopes bootstrap control to the named stack and bucket without object or deletion grants", () => {
    const { Statement: statements } = JSON.parse(render("bootstrap-policy").stdout);
    for (const statement of statements as Statement[]) {
      for (const action of array(statement.Action)) {
        expect(action).not.toMatch(
          /^(s3:(?:GetObject|PutObject|DeleteObject|DeleteBucket)|cloudformation:DeleteStack)$/,
        );
        expect(action).not.toContain("*");
        expect(array(statement.Resource)).toEqual([
          action.startsWith("cloudformation:")
            ? `arn:aws:cloudformation:${region}:${account}:stack/wallie-staging-state/*`
            : bucketArn,
        ]);
        if (action.startsWith("cloudformation:")) {
          expect(statement.Condition.StringEquals["aws:RequestedRegion"]).toBe(region);
        }
      }
    }
  });

  it("limits backend writes to foundation, registry, and application state and permits deletion only of their locks", () => {
    const { Statement: statements } = JSON.parse(render("access-policy").stdout);
    const objects = new Map<string, Set<string>>();
    for (const statement of statements as Statement[]) {
      for (const action of array(statement.Action)) {
        const resources = objects.get(action) ?? new Set<string>();
        for (const resource of array(statement.Resource)) resources.add(resource);
        objects.set(action, resources);
      }
    }
    expect(objects.get("s3:PutObject")).toEqual(
      new Set([
        `${bucketArn}/staging/foundation.tfstate`,
        `${bucketArn}/staging/foundation.tfstate.tflock`,
        `${bucketArn}/staging/registry.tfstate`,
        `${bucketArn}/staging/application.tfstate`,
        `${bucketArn}/staging/registry.tfstate.tflock`,
        `${bucketArn}/staging/application.tfstate.tflock`,
      ]),
    );
    expect(objects.get("s3:DeleteObject")).toEqual(
      new Set([
        `${bucketArn}/staging/foundation.tfstate.tflock`,
        `${bucketArn}/staging/registry.tfstate.tflock`,
        `${bucketArn}/staging/application.tfstate.tflock`,
      ]),
    );
    expect(objects.get("s3:ListBucket")).toEqual(new Set([bucketArn]));
    expect([...objects.keys()].every((action) => action.startsWith("s3:"))).toBe(true);
  });

  it("generates a locked, encrypted backend with an account guard and no credentials", () => {
    const result = render("backend");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`bucket              = "${bucket}"`);
    expect(result.stdout).toContain(`region              = "${region}"`);
    expect(result.stdout).toContain('key                 = "staging/foundation.tfstate"');
    expect(result.stdout).toContain("encrypt             = true");
    expect(result.stdout).toContain("use_lockfile        = true");
    expect(result.stdout).toContain(`allowed_account_ids = ["${account}"]`);
    expect(result.stdout).not.toMatch(/access_key|secret_key|token|profile/);
  });

  it.each(["foundation", "registry", "application"])(
    "selects only the %s backend without changing other safeguards",
    (component) => {
      const result = render("backend", [
        "--account-id",
        account,
        "--region",
        region,
        "--component",
        component,
      ]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        render("backend").stdout.replace(
          "staging/foundation.tfstate",
          `staging/${component}.tfstate`,
        ),
      );
    },
  );

  it.each([
    ["us-gov-west-1", "aws-us-gov"],
    ["cn-north-1", "aws-cn"],
  ])("uses the matching ARN partition for %s", (awsRegion, partition) => {
    const result = render("bootstrap-policy", ["--account-id", account, "--region", awsRegion]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`arn:${partition}:cloudformation:${awsRegion}:${account}:`);
    expect(result.stdout).not.toContain("arn:aws:");
  });

  it.each([
    ["apply", ["--account-id", account, "--region", region]],
    ["backend", []],
    ["backend", ["--account-id", "123", "--region", region]],
    ["backend", ["--account-id", account, "--region", 'us-west-2"\nprofile="root']],
    ["backend", ["--account-id", account, "--region", region, "--region", region]],
    ["backend", ["--account-id", account, "--region", region, "--profile", "root"]],
    ["backend", ["--account-id", account, "--region", region, "extra"]],
    ["backend", ["--account-id", account, "--region", region, "--component", ""]],
    ["backend", ["--account-id", account, "--region", region, "--component", "../other"]],
    [
      "backend",
      [
        "--account-id",
        account,
        "--region",
        region,
        "--component",
        "registry",
        "--component",
        "foundation",
      ],
    ],
    ["access-policy", ["--account-id", account, "--region", region, "--component", "registry"]],
    [
      "bootstrap-policy",
      ["--account-id", account, "--region", region, "--component", "foundation"],
    ],
  ])("rejects invalid or unsupported inputs: %s %j", (command, args) => {
    const result = render(command as string, args as string[]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-state]");
  });
});

describe("state bucket safeguards", () => {
  const template = parse(
    readFileSync(new URL("../../../infra/aws/state-bootstrap.yaml", import.meta.url), "utf8"),
  );

  it("retains the bucket and its security policy, with no compute or IAM resources", () => {
    expect(Object.keys(template.Resources).sort()).toEqual(["StateBucket", "StateBucketPolicy"]);
    for (const resource of Object.values(template.Resources) as Record<string, unknown>[]) {
      expect(resource.DeletionPolicy).toBe("Retain");
      expect(resource.UpdateReplacePolicy).toBe("Retain");
    }
    const properties = template.Resources.StateBucket.Properties;
    expect(properties.VersioningConfiguration.Status).toBe("Enabled");
    expect(properties.OwnershipControls.Rules).toEqual([
      { ObjectOwnership: "BucketOwnerEnforced" },
    ]);
    expect(properties.BucketEncryption.ServerSideEncryptionConfiguration).toEqual([
      { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
    ]);
    expect(properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(properties).not.toHaveProperty("LifecycleConfiguration");
  });

  it("denies non-TLS access to both bucket and objects without adding public grants", () => {
    const statements = template.Resources.StateBucketPolicy.Properties.PolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      Effect: "Deny",
      Principal: "*",
      Action: "s3:*",
      Condition: { Bool: { "aws:SecureTransport": "false" } },
    });
    expect(statements[0].Resource).toEqual([
      { "Fn::GetAtt": ["StateBucket", "Arn"] },
      { "Fn::Sub": "${StateBucket.Arn}/*" },
    ]);
  });
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-backup-deployment.mjs", import.meta.url),
);
const account = "123456789012";
const region = "us-west-2";
const bucket = `wallie-staging-postgres-backups-${account}-${region}`;
const bucketArn = `arn:aws:s3:::${bucket}`;
const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const args = ["--account-id", account, "--region", region, "--expires-at", expiresAt];

type Statement = {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string;
  Condition: Record<string, Record<string, string | string[]>>;
};

function run(parameters: string[] = args) {
  return spawnSync(process.execPath, [script, ...parameters], {
    encoding: "utf8",
    timeout: 5_000,
    env: { NODE_ENV: "test", PATH: "" },
  });
}

const actions = (statement: Statement) =>
  Array.isArray(statement.Action) ? statement.Action : [statement.Action];

describe("temporary AWS backup destination deployment grant", () => {
  it("limits an expiring grant to one bucket and the exact creation and refresh actions", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(/<[A-Z_]+>/);
    const policy = JSON.parse(result.stdout) as { Version: string; Statement: Statement[] };
    expect(policy.Version).toBe("2012-10-17");
    expect(JSON.stringify(policy).length).toBeLessThanOrEqual(6_144);
    expect(policy.Statement.map((statement) => statement.Sid)).toEqual([
      "CreateOnlyNamedRegionalBackupBucket",
      "InitializeObjectLockBucket",
      "TagOnlyNamedBackupBucket",
      "ConfigureNamedBackupBucket",
      "InspectNamedBackupBucket",
    ]);
    for (const statement of policy.Statement) {
      expect(statement.Effect).toBe("Allow");
      expect(statement.Resource).toBe(bucketArn);
      expect(statement.Condition.StringEquals["aws:PrincipalAccount"]).toBe(account);
      expect(statement.Condition.StringEquals["aws:PrincipalArn"]).toBe(
        `arn:aws:iam::${account}:user/wallie-local`,
      );
      expect(statement.Condition.DateLessThan).toEqual({ "aws:CurrentTime": expiresAt });
      expect(actions(statement).every((action) => action.startsWith("s3:"))).toBe(true);
    }
    expect(policy.Statement[0].Condition.StringEquals["s3:LocationConstraint"]).toBe(region);
    expect(actions(policy.Statement[0])).toEqual(["s3:CreateBucket"]);
    expect(actions(policy.Statement[1])).toEqual([
      "s3:PutBucketVersioning",
      "s3:PutBucketObjectLockConfiguration",
    ]);
    expect(actions(policy.Statement[3])).toEqual([
      "s3:PutEncryptionConfiguration",
      "s3:PutBucketOwnershipControls",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketPolicy",
    ]);
    expect(actions(policy.Statement[4])).toEqual([
      "s3:ListBucket",
      "s3:ListBucketVersions",
      "s3:ListTagsForResource",
      "s3:GetBucketTagging",
      "s3:GetBucketLocation",
      "s3:GetBucketPolicy",
      "s3:GetBucketAcl",
      "s3:GetBucketCORS",
      "s3:GetBucketWebsite",
      "s3:GetBucketVersioning",
      "s3:GetAccelerateConfiguration",
      "s3:GetBucketRequestPayment",
      "s3:GetBucketLogging",
      "s3:GetLifecycleConfiguration",
      "s3:GetReplicationConfiguration",
      "s3:GetEncryptionConfiguration",
      "s3:GetBucketObjectLockConfiguration",
      "s3:GetBucketOwnershipControls",
      "s3:GetBucketPublicAccessBlock",
    ]);
    for (const forbidden of [
      "s3:PutObject",
      "s3:ReplicateObject",
      "s3:DeleteBucket",
      "s3:DeleteObject",
      "s3:PutBucketAcl",
      "s3:PutBucketTagging",
    ]) {
      expect(policy.Statement.flatMap(actions)).not.toContain(forbidden);
    }
  });

  it("requires the six reviewed creation tags and no extra tag keys", () => {
    const result = run();
    expect(result.status).toBe(0);
    const tag = (JSON.parse(result.stdout) as { Statement: Statement[] }).Statement[2];
    expect(actions(tag)).toEqual(["s3:TagResource"]);
    expect(tag.Condition.StringEquals).toMatchObject({
      "aws:RequestTag/Name": bucket,
      "aws:RequestTag/Project": "Wallie",
      "aws:RequestTag/Environment": "staging",
      "aws:RequestTag/ManagedBy": "Terraform",
      "aws:RequestTag/WallieStack": "wallie-staging-backup",
      "aws:RequestTag/Component": "postgres-backup",
    });
    expect(tag.Condition["ForAllValues:StringEquals"]["aws:TagKeys"]).toEqual([
      "Name",
      "Project",
      "Environment",
      "ManagedBy",
      "Component",
      "WallieStack",
    ]);
  });

  it.each(
    [
      [],
      ["--account-id", account],
      [...args, "--region", region],
      ["--account-id", account, "--region", region, "--expires-at", "2026-02-30T10:00:00Z"],
      ["--account-id", account, "--region", "us-east-1", "--expires-at", expiresAt],
      ["--account-id", account, "--region", "us-gov-west-1", "--expires-at", expiresAt],
      ["--account-id", "bad", "--region", region, "--expires-at", expiresAt],
      [
        "--account-id",
        account,
        "--region",
        region,
        "--expires-at",
        new Date(Date.now() - 1).toISOString().replace(/\.\d{3}Z$/, "Z"),
      ],
      [
        "--account-id",
        account,
        "--region",
        region,
        "--expires-at",
        new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      ],
    ].map((parameters) => ({ parameters })),
  )("rejects invalid or unbounded inputs: $parameters", ({ parameters }) => {
    const result = run(parameters);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-backup-deployment]");
  });
});

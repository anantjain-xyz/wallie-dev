import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-runtime-config.mjs", import.meta.url),
);
const account = "123456789012";
const region = "us-west-2";
const versionId = "1".repeat(32);
const secretArn = (component: string) =>
  `arn:aws:secretsmanager:${region}:${account}:secret:/wallie/staging/${component}/runtime-AbC123`;
const args = [
  "--account-id",
  account,
  "--region",
  region,
  "--web-secret-arn",
  secretArn("web"),
  "--worker-secret-arn",
  secretArn("worker"),
  "--web-version-id",
  versionId,
  "--worker-version-id",
  "2".repeat(32),
];
function run(input = args) {
  return spawnSync(process.execPath, [script, ...input], {
    encoding: "utf8",
    timeout: 5_000,
    env: {
      NODE_ENV: "test",
      PATH: "",
      AWS_PROFILE: "must-not-be-used",
      AWS_ACCESS_KEY_ID: "ambient-not-used",
    },
  });
}
function replace(name: string, value: string) {
  const result = [...args];
  result[result.indexOf(name) + 1] = value;
  return result;
}

describe("offline AWS runtime configuration contract", () => {
  it("renders only the existing public settings and pinned own-component secret selectors", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const rendered = JSON.parse(result.stdout);
    expect(rendered).toEqual({
      schemaVersion: 1,
      account,
      region,
      deployable: false,
      publicEnvironmentNames: [
        "NEXT_PUBLIC_APP_URL",
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      ],
      plainEnvironmentNames: ["WALLIE_DEPLOY_ENV"],
      components: {
        web: {
          secretArn: secretArn("web"),
          versionId,
          secrets: ["SUPABASE_SECRET_KEY", "WALLIE_ENCRYPTION_KEY"].map((name) => ({
            name,
            valueFrom: `${secretArn("web")}:${name}::${versionId}`,
          })),
        },
        worker: {
          secretArn: secretArn("worker"),
          versionId: "2".repeat(32),
          secrets: ["SUPABASE_SECRET_KEY", "WALLIE_ENCRYPTION_KEY"].map((name) => ({
            name,
            valueFrom: `${secretArn("worker")}:${name}::${"2".repeat(32)}`,
          })),
        },
      },
    });
    expect(result.stdout).not.toMatch(/SecretString|SecretBinary|WALLIE_SMOKE_CANARY|iam:PassRole/);
  });

  it("accepts an existing version ID containing an underscore without changing the selector", () => {
    const customVersionId = `${"a".repeat(31)}_`;
    const result = run(replace("--web-version-id", customVersionId));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).components.web.secrets[0].valueFrom).toBe(
      `${secretArn("web")}:SUPABASE_SECRET_KEY::${customVersionId}`,
    );
  });

  it.each([
    ["wrong account", "--account-id", "111"],
    ["China partition", "--region", "cn-north-1"],
    ["wrong component", "--web-secret-arn", secretArn("worker")],
    ["partial ARN", "--web-secret-arn", `/wallie/staging/web/runtime`],
    ["wrong account ARN", "--web-secret-arn", secretArn("web").replace(account, "999999999999")],
    ["missing suffix", "--worker-secret-arn", secretArn("worker").slice(0, -7)],
    ["short version", "--web-version-id", "short"],
    ["stage label", "--worker-version-id", "AWSCURRENT"],
    ["selector injection", "--web-version-id", `${versionId}:AWSCURRENT`],
  ])("rejects %s without output", (_case, option, value) => {
    const result = run(replace(option, value));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-runtime-config]");
    expect(result.stderr).not.toContain(value);
  });

  it("rejects extra options, repeated options, missing inputs, and supplied values", () => {
    for (const input of [
      args.slice(0, -2),
      [...args, "--web-version-id", versionId],
      [...args, "--secret-string", "do-not-print-me"],
      [...args, "--public-value", "do-not-print-me"],
    ]) {
      const result = run(input);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("do-not-print-me");
    }
  });
});

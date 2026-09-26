import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// AWS responses here are deliberately minimal; no secret value is ever read back.
const script = fileURLToPath(
  new URL("../../../scripts/populate-aws-hosted-web-secret.mjs", import.meta.url),
);
const { hostedConfig, hostedPutRequest, populateHostedWebSecret } = await import(
  new URL(`file://${script}`).href
);
const versionId = "a".repeat(32);
const origin = "https://production.supabase.co";
const existingOrigin = origin;
const arn =
  "arn:aws:secretsmanager:us-west-2:111614490109:secret:/wallie/staging/web/runtime-vDeDr4";

function fixture(populated = false) {
  const identity = { ARN: arn, Name: "/wallie/staging/web/runtime" };
  return {
    description: {
      ...identity,
      Description:
        "Wallie staging web runtime secret configuration; values managed outside Terraform.",
      Tags: Object.entries({
        Project: "Wallie",
        Environment: "staging",
        ManagedBy: "Terraform",
        WallieStack: "wallie-staging-application",
        Component: "runtime-secrets",
        Name: "/wallie/staging/web/runtime",
      }).map(([Key, Value]) => ({ Key, Value })),
      VersionIdsToStages: populated ? { [versionId]: ["AWSCURRENT"] } : {},
    },
    policy: identity,
    versions: {
      ...identity,
      Versions: populated ? [{ VersionId: versionId, VersionStages: ["AWSCURRENT"] }] : [],
    },
  };
}

describe("hosted Supabase web-only secret write", () => {
  it("requires an exact Cloud project origin and one version token", () => {
    expect(hostedConfig(versionId, origin, existingOrigin).secrets).toEqual({
      web: { arn, versionId },
    });
    for (const bad of [
      "http://production.supabase.co",
      "https://supabase.co",
      "https://production.supabase.co/path",
      "https://production.example.com",
    ])
      expect(() => hostedConfig(versionId, bad, existingOrigin)).toThrow();
    expect(() =>
      hostedConfig(versionId, "https://isolated-staging.supabase.co", existingOrigin),
    ).toThrow();
    expect(() => hostedConfig("AWSCURRENT", origin, existingOrigin)).toThrow();
  });

  it("constructs only web credentials and accepts the existing key encoding", () => {
    const config = hostedConfig(versionId, origin, existingOrigin);
    const request = hostedPutRequest(config, {
      supabaseSecretKey: "sb_secret_hosted-project",
      wallieEncryptionKey: "A".repeat(64),
    });
    expect(request.SecretId).toBe(arn);
    expect(request.SecretString).toBe(
      JSON.stringify({
        SUPABASE_SECRET_KEY: "sb_secret_hosted-project",
        WALLIE_ENCRYPTION_KEY: "A".repeat(64),
      }),
    );
    expect(
      hostedPutRequest(config, {
        supabaseSecretKey: "sb_secret_hosted-project",
        wallieEncryptionKey: "A".repeat(43),
      }).SecretId,
    ).toBe(arn);
    expect(() =>
      hostedPutRequest(config, {
        supabaseSecretKey: "sb_publishable_public",
        wallieEncryptionKey: "A".repeat(64),
      }),
    ).toThrow();
  });

  it("refuses existing versions and writes only the exact web ARN via stdin", async () => {
    const config = hostedConfig(versionId, origin, existingOrigin);
    const calls: Array<{ action: string; args: string[]; input?: string }> = [];
    let populated = false;
    const call = (
      _config: unknown,
      service: string,
      action: string,
      args: string[] = [],
      input?: string,
    ) => {
      calls.push({ action, args, input });
      if (service === "sts")
        return { Account: "111614490109", Arn: "arn:aws:iam::111614490109:user/wallie-local" };
      expect(args).toContain(arn);
      if (action === "put-secret-value") {
        expect(args).toContain("file:///dev/stdin");
        expect(JSON.stringify(args)).not.toContain("sb_secret_hosted-project");
        expect(input).toContain("sb_secret_hosted-project");
        populated = true;
        return {
          ARN: arn,
          Name: "/wallie/staging/web/runtime",
          VersionId: versionId,
          VersionStages: ["AWSCURRENT"],
        };
      }
      const state = fixture(populated);
      if (action === "describe-secret") return state.description;
      if (action === "get-resource-policy") return state.policy;
      if (action === "list-secret-version-ids") return state.versions;
      throw new Error("Unexpected AWS call");
    };
    const reports: unknown[] = [];
    await populateHostedWebSecret(config, {
      call,
      prompt: async (readOrigin: string) => {
        expect(readOrigin).toBe(origin);
        return {
          supabaseSecretKey: "sb_secret_hosted-project",
          wallieEncryptionKey: "A".repeat(64),
        };
      },
      report: (value: unknown) => reports.push(value),
    });
    expect(calls.filter((item) => item.action === "put-secret-value")).toHaveLength(1);
    expect(reports).toEqual([{ secretArn: arn, versionId, status: "version-metadata-matched" }]);
    await expect(
      populateHostedWebSecret(config, {
        call,
        prompt: async () => {
          throw new Error("Should not prompt");
        },
        report: () => {},
      }),
    ).rejects.toThrow();
    expect(calls.filter((item) => item.action === "put-secret-value")).toHaveLength(1);
  });
});

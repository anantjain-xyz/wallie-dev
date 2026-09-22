import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-image-signing.mjs", import.meta.url),
);
const account = "123456789012";
const region = "us-west-2";
const profileVersion = "Ab12Cd34Ef";
const common = ["--account-id", account, "--region", region, "--profile-version", profileVersion];
const commands = ["policy", "trust-policy"];
const array = (value: string | string[]) => (Array.isArray(value) ? value : [value]);
const actions = [
  "ecr:GetDownloadUrlForLayer",
  "signer:GetRevocationStatus",
  "signer:GetSigningProfile",
  "signer:ListTagsForResource",
  "signer:SignPayload",
];
const regions = [
  [region, "aws", "aws-signer-ts"],
  ["ap-southeast-2", "aws", "aws-signer-ts"],
  ["us-gov-west-1", "aws-us-gov", "aws-us-gov-signer-ts"],
  ["us-gov-east-1", "aws-us-gov", "aws-us-gov-signer-ts"],
];

type Statement = {
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition: Record<string, Record<string, string>>;
};

function render(command: string, args = common, environment: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, command, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    env: { NODE_ENV: "test", PATH: "", ...environment },
  });
}

function withValue(flag: string, value: string) {
  return common.map((item, index) => (common[index - 1] === flag ? value : item));
}

describe("AWS image signing preparation", () => {
  it.each(regions)(
    "limits the signing policy to the reviewed resources in %s",
    (awsRegion, partition) => {
      const result = render("policy", withValue("--region", awsRegion));
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const policy = JSON.parse(result.stdout);
      expect(policy.Version).toBe("2012-10-17");
      expect(JSON.stringify(policy).length).toBeLessThanOrEqual(6_144);
      const statements = policy.Statement as Statement[];
      expect(
        [...new Set(statements.flatMap((statement) => array(statement.Action)))].sort(),
      ).toEqual(actions);
      const profileArn = `arn:${partition}:signer:${awsRegion}:${account}:/signing-profiles/wallie_staging_images`;
      const signingJobsArn = `arn:${partition}:signer:${awsRegion}:${account}:/signing-jobs/*`;
      const repositories = ["web", "worker"].map(
        (component) =>
          `arn:${partition}:ecr:${awsRegion}:${account}:repository/wallie-staging/${component}`,
      );
      const accountAndRegion = {
        "aws:PrincipalAccount": account,
        "aws:RequestedRegion": awsRegion,
      };
      const ownedProfile = {
        ...accountAndRegion,
        "aws:ResourceTag/WallieStack": "wallie-staging-registry",
        "aws:ResourceTag/Component": "signing",
      };

      // Structural authorization boundaries, not an AWS IAM authorization simulator.
      for (const statement of statements) {
        expect(statement.Effect).toBe("Allow");
        expect(statement).not.toHaveProperty("NotAction");
        expect(statement).not.toHaveProperty("NotResource");
        const statementActions = array(statement.Action);
        const resources = array(statement.Resource);
        expect(statementActions.every((action) => actions.includes(action))).toBe(true);
        if (statementActions.includes("ecr:GetDownloadUrlForLayer")) {
          expect(statementActions).toEqual(["ecr:GetDownloadUrlForLayer"]);
          expect(resources).toEqual(repositories);
          expect(statement.Condition).toEqual({
            StringEquals: {
              ...accountAndRegion,
              "aws:ResourceTag/WallieStack": "wallie-staging-registry",
            },
          });
        } else if (resources.includes(signingJobsArn)) {
          expect(statementActions).toEqual(["signer:GetRevocationStatus"]);
          expect(resources).toEqual([signingJobsArn]);
          expect(statement.Condition).toEqual({ StringEquals: accountAndRegion });
        } else {
          expect(resources).toEqual([profileArn]);
          const needsVersion = statementActions.some((action) =>
            ["signer:SignPayload", "signer:GetSigningProfile"].includes(action),
          );
          expect(statement.Condition).toEqual({
            StringEquals: needsVersion
              ? { ...ownedProfile, "signer:ProfileVersion": profileVersion }
              : ownedProfile,
          });
        }
      }

      for (const action of ["signer:SignPayload", "signer:GetSigningProfile"]) {
        const grants = statements.filter((statement) => array(statement.Action).includes(action));
        expect(grants).toHaveLength(1);
        expect(grants[0].Condition.StringEquals["signer:ProfileVersion"]).toBe(profileVersion);
      }
      const revocationResources = statements
        .filter((statement) => array(statement.Action).includes("signer:GetRevocationStatus"))
        .flatMap((statement) => array(statement.Resource));
      expect(revocationResources.sort()).toEqual([profileArn, signingJobsArn].sort());
    },
  );

  it.each(regions)(
    "requires strict verification of the exact version and two repositories in %s",
    (awsRegion, partition, trustStore) => {
      const result = render("trust-policy", withValue("--region", awsRegion));
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const policy = JSON.parse(result.stdout);
      expect(policy.version).toBe("1.0");
      expect(policy.trustPolicies).toHaveLength(1);
      const [trust] = policy.trustPolicies;
      expect(trust.registryScopes).toEqual(
        ["web", "worker"].map(
          (component) =>
            `${account}.dkr.ecr.${awsRegion}.amazonaws.com/wallie-staging/${component}`,
        ),
      );
      expect(trust.signatureVerification).toEqual({ level: "strict" });
      expect(trust.trustStores).toEqual([`signingAuthority:${trustStore}`]);
      expect(trust.trustedIdentities).toEqual([
        `arn:${partition}:signer:${awsRegion}:${account}:/signing-profiles/wallie_staging_images/${profileVersion}`,
      ]);
      expect(result.stdout).not.toContain("*");
    },
  );

  it("replaces the pinned version in both outputs without broadening either policy", () => {
    const replacement = "9876543210";
    const args = withValue("--profile-version", replacement);
    const iam = JSON.parse(render("policy", args).stdout);
    const grants = (iam.Statement as Statement[]).filter((statement) =>
      array(statement.Action).includes("signer:SignPayload"),
    );
    expect(grants).toHaveLength(1);
    expect(grants[0].Condition.StringEquals["signer:ProfileVersion"]).toBe(replacement);
    expect(JSON.stringify(iam)).not.toContain(profileVersion);
    const trust = JSON.parse(render("trust-policy", args).stdout);
    expect(trust.trustPolicies[0].trustedIdentities).toEqual([
      `arn:aws:signer:${region}:${account}:/signing-profiles/wallie_staging_images/${replacement}`,
    ]);
    expect(JSON.stringify(trust)).not.toContain(profileVersion);
  });

  it.each(commands)("renders %s offline without credentials or external commands", (command) => {
    const clean = render(command);
    expect(clean.status).toBe(0);
    expect(clean.stderr).toBe("");
    expect(() => JSON.parse(clean.stdout)).not.toThrow();
    expect(clean.stdout).not.toMatch(/<[A-Z_]+>/);

    const ambient = render(command, common, {
      AWS_ACCESS_KEY_ID: "unused-test-access-key",
      AWS_SECRET_ACCESS_KEY: "unused-test-secret",
      AWS_SESSION_TOKEN: "unused-test-token",
      AWS_PROFILE: "unrelated-profile",
      AWS_REGION: "cn-north-1",
      AWS_DEFAULT_REGION: "cn-north-1",
      AWS_ACCOUNT_ID: "999999999999",
      AWS_CONFIG_FILE: "/does-not-exist/config",
      AWS_SHARED_CREDENTIALS_FILE: "/does-not-exist/credentials",
    });
    expect(ambient.status).toBe(0);
    expect(ambient.stderr).toBe("");
    expect(ambient.stdout).toBe(clean.stdout);
  });

  const invalidArguments: [string, string[]][] = [
    ["all inputs missing", []],
    ["account missing", common.slice(2)],
    ["region missing", [...common.slice(0, 2), ...common.slice(4)]],
    ["profile version missing", common.slice(0, 4)],
    ["short account", withValue("--account-id", "123")],
    ["long account", withValue("--account-id", `${account}3`)],
    ["account trailing newline", withValue("--account-id", `${account}\n`)],
    ["account JSON injection", withValue("--account-id", `${account}\",\"Resource\":\"*`)],
    ["region trailing newline", withValue("--region", `${region}\n`)],
    ["region JSON injection", withValue("--region", 'us-west-2","Resource":"*')],
    ["China partition", withValue("--region", "cn-north-1")],
    ["China northwest partition", withValue("--region", "cn-northwest-1")],
    ["isolated partition", withValue("--region", "us-iso-east-1")],
    ["wildcard region", withValue("--region", "*")],
    ["empty profile version", withValue("--profile-version", "")],
    ["short profile version", withValue("--profile-version", "Ab12Cd34E")],
    ["long profile version", withValue("--profile-version", "Ab12Cd34Ef5")],
    ["profile version trailing newline", withValue("--profile-version", `${profileVersion}\n`)],
    ["non-ASCII profile version", withValue("--profile-version", "Ab12Cd34Eé")],
    ["profile version punctuation", withValue("--profile-version", "Ab12Cd34E_")],
    ["profile version wildcard", withValue("--profile-version", "*")],
    ["profile version path", withValue("--profile-version", "../profile")],
    ["profile version JSON injection", withValue("--profile-version", 'x","x":"*')],
    ["duplicate account", [...common, "--account-id", account]],
    ["duplicate different account", [...common, "--account-id", "999999999999"]],
    ["duplicate region", [...common, "--region", region]],
    ["duplicate profile version", [...common, "--profile-version", profileVersion]],
    ["profile name override", [...common, "--profile-name", "other"]],
    ["repository override", [...common, "--repository", "other"]],
    ["trust level override", [...common, "--verification-level", "skip"]],
    ["trust store override", [...common, "--trust-store", "other"]],
    ["partition override", [...common, "--partition", "aws-cn"]],
    ["credential argument", [...common, "--access-key-id", "unused-test-key"]],
    ["extra positional argument", [...common, "extra"]],
    ["option without value", [...common.slice(0, 4), "--profile-version"]],
  ];

  describe.each(commands)("%s input validation", (command) => {
    it.each(invalidArguments)("rejects %s without emitting a document", (_label, args) => {
      const result = render(command, args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("[aws-image-signing]");
    });
  });

  it.each(["", "apply", "sign", "verify", "variables"])(
    "rejects unsupported command %j",
    (command) => {
      const result = render(command);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("[aws-image-signing]");
    },
  );
});

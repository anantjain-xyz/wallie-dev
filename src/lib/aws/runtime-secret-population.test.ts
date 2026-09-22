import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Raw AWS response fixtures intentionally include malformed fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = Record<string, any>;
let validateConfig: (input: Data) => Data;
let verifyMetadata: (
  config: Data,
  component: string,
  description: Data,
  policy: Data,
  versions: Data,
  state: string,
) => void;
let buildPutRequest: (config: Data, component: string, credentials: Data) => Data;
let populateRuntimeSecrets: (config: Data, adapters: Data) => Promise<void>;
let awsCommand: (
  args: string[],
  input: string,
  spawn: (name: string, args: string[], options: Data) => Data,
) => Data;
const script = fileURLToPath(
  new URL("../../../scripts/populate-aws-runtime-secrets.mjs", import.meta.url),
);
beforeAll(async () => {
  ({ validateConfig, verifyMetadata, buildPutRequest, populateRuntimeSecrets, awsCommand } =
    await import(new URL(`file://${script}`).href));
});
afterEach(() => vi.unstubAllEnvs());

const account = "111614490109";
const region = "us-west-2";
const secretArn = (component: string) =>
  component === "web"
    ? "arn:aws:secretsmanager:us-west-2:111614490109:secret:/wallie/staging/web/runtime-vDeDr4"
    : "arn:aws:secretsmanager:us-west-2:111614490109:secret:/wallie/staging/worker/runtime-4C4k43";
const input = () => ({
  webVersionId: "1".repeat(32),
  workerVersionId: "2".repeat(32),
});
const credentials = () => ({
  supabaseSecretKey: "sb_secret_synthetic-staging-secret-key",
  wallieEncryptionKey: "a".repeat(64),
});

function metadata(config: Data, component: string, populated = false) {
  const arn = config.secrets[component].arn;
  const id = config.secrets[component].versionId;
  const identity = { ARN: arn, Name: `/wallie/staging/${component}/runtime` };
  const tags = {
    Name: identity.Name,
    Component: "runtime-secrets",
    WallieStack: "wallie-staging-application",
    ManagedBy: "Terraform",
    Environment: "staging",
    Project: "Wallie",
  };
  return {
    description: {
      ...identity,
      Description: `Wallie staging ${component} runtime secret configuration; values managed outside Terraform.`,
      Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
      VersionIdsToStages: populated ? { [id]: ["AWSCURRENT"] } : {},
    },
    policy: { ...identity },
    versions: {
      ...identity,
      Versions: populated ? [{ VersionId: id, VersionStages: ["AWSCURRENT"] }] : [],
    },
  };
}

function fakeAws(config: Data, overrides: Data = {}) {
  const written = new Set<string>();
  const calls: Data[] = [];
  const aws = (
    _config: Data,
    service: string,
    action: string,
    args: string[] = [],
    request?: string,
  ) => {
    calls.push({ service, action, args, request });
    if (service === "sts")
      return {
        Account: config.account,
        Arn: `arn:aws:iam::${config.account}:user/wallie-local`,
      };
    const arn = args[args.indexOf("--secret-id") + 1];
    const component = arn.includes("/web/") ? "web" : "worker";
    if (action === "put-secret-value") {
      if (overrides.failWrite === component)
        throw new Error("synthetic hidden input must not print");
      written.add(component);
      return {
        ARN: arn,
        Name: `/wallie/staging/${component}/runtime`,
        VersionId: args[args.indexOf("--client-request-token") + 1],
        VersionStages: ["AWSCURRENT"],
      };
    }
    const state = metadata(
      config,
      component,
      written.has(component) || overrides.preexisting === component,
    );
    if (action === "describe-secret") return state.description;
    if (action === "get-resource-policy") return state.policy;
    if (action === "list-secret-version-ids") return state.versions;
    throw new Error("Unexpected AWS command");
  };
  return { aws, calls, written };
}

describe("isolated AWS runtime secret population", () => {
  it("pins the exact staging account, region, component ARNs, and distinct version IDs", () => {
    const config = validateConfig(input());
    expect(config).toEqual({
      account,
      region,
      secrets: {
        web: { arn: secretArn("web"), versionId: "1".repeat(32) },
        worker: { arn: secretArn("worker"), versionId: "2".repeat(32) },
      },
    });
    for (const bad of [
      { account: "999999999999" },
      { region: "cn-north-1" },
      { webSecretArn: secretArn("worker") },
      { workerSecretArn: secretArn("worker").slice(0, -7) },
      { webVersionId: "AWSCURRENT" },
      { workerVersionId: "1".repeat(32) },
    ])
      expect(() => validateConfig({ ...input(), ...bad })).toThrow();
  });

  it("requires empty, owned metadata before writing and one exact current version after", () => {
    const config = validateConfig(input());
    const initial = metadata(config, "web");
    expect(() =>
      verifyMetadata(config, "web", initial.description, initial.policy, initial.versions, "empty"),
    ).not.toThrow();
    const after = metadata(config, "web", true);
    expect(() =>
      verifyMetadata(config, "web", after.description, after.policy, after.versions, "populated"),
    ).not.toThrow();
    for (const change of [
      (f: Data) => (f.description.Tags[0].Value = "other"),
      (f: Data) => (f.description.KmsKeyId = "custom-key"),
      (f: Data) => (f.policy.ResourcePolicy = "{}"),
    ]) {
      const fixture = metadata(config, "web");
      change(fixture);
      expect(() =>
        verifyMetadata(
          config,
          "web",
          fixture.description,
          fixture.policy,
          fixture.versions,
          "empty",
        ),
      ).toThrow();
    }
    const existing = metadata(config, "web", true);
    expect(() =>
      verifyMetadata(
        config,
        "web",
        existing.description,
        existing.policy,
        existing.versions,
        "empty",
      ),
    ).toThrow();
    const paginated = metadata(config, "web");
    Object.assign(paginated.versions, { NextToken: "more" });
    expect(() =>
      verifyMetadata(
        config,
        "web",
        paginated.description,
        paginated.policy,
        paginated.versions,
        "empty",
      ),
    ).toThrow();
  });

  it("builds only the two required JSON keys and never reads app credentials from the environment", () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "ambient-prod-key");
    vi.stubEnv("WALLIE_ENCRYPTION_KEY", "f".repeat(64));
    const config = validateConfig(input());
    const request = buildPutRequest(config, "web", credentials());
    expect(request).toEqual({
      SecretId: secretArn("web"),
      ClientRequestToken: "1".repeat(32),
      SecretString: JSON.stringify({
        SUPABASE_SECRET_KEY: "sb_secret_synthetic-staging-secret-key",
        WALLIE_ENCRYPTION_KEY: "a".repeat(64),
      }),
      VersionStages: ["AWSCURRENT"],
    });
    for (const invalid of ["legacy-service-role", "sb_secret_", "sb_secret_has space"])
      expect(() =>
        buildPutRequest(config, "web", { ...credentials(), supabaseSecretKey: invalid }),
      ).toThrow();
    expect(() =>
      buildPutRequest(config, "web", { ...credentials(), wallieEncryptionKey: "short" }),
    ).toThrow();
  });

  it("passes values only via stdin, with no values in process arguments or child environment", () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "ambient-prod-key");
    vi.stubEnv("WALLIE_ENCRYPTION_KEY", "f".repeat(64));
    vi.stubEnv("AWS_ENDPOINT_URL", "https://global-redirect.example");
    vi.stubEnv("AWS_ENDPOINT_URL_SECRETS_MANAGER", "https://secret-redirect.example");
    vi.stubEnv("AWS_CONFIG_FILE", "/tmp/attacker-config");
    vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", "/tmp/attacker-credentials");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "ambient-credential");
    vi.stubEnv("HTTPS_PROXY", "https://proxy-redirect.example");
    const request = buildPutRequest(validateConfig(input()), "web", credentials());
    const spawn = vi.fn((_name: string, args: string[], options: Data) => {
      expect(_name).toBe("aws");
      expect(args).toContain("file:///dev/stdin");
      expect(JSON.stringify(args)).not.toContain("sb_secret_synthetic-staging-secret-key");
      expect(options.env.SUPABASE_SECRET_KEY).toBeUndefined();
      expect(options.env.WALLIE_ENCRYPTION_KEY).toBeUndefined();
      expect(options.env.AWS_PROFILE).toBe("wallie-staging");
      expect(options.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS).toBe("true");
      for (const name of [
        "AWS_ENDPOINT_URL",
        "AWS_ENDPOINT_URL_SECRETS_MANAGER",
        "AWS_CONFIG_FILE",
        "AWS_SHARED_CREDENTIALS_FILE",
        "AWS_ACCESS_KEY_ID",
        "HTTPS_PROXY",
      ])
        expect(options.env[name]).toBeUndefined();
      expect(options.input).toBe(request.SecretString);
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify({ VersionId: request.ClientRequestToken }),
      };
    });
    expect(
      awsCommand(
        ["secretsmanager", "put-secret-value", "--secret-string", "file:///dev/stdin"],
        request.SecretString,
        spawn,
      ),
    ).toEqual({ VersionId: request.ClientRequestToken });
    expect(spawn).toHaveBeenCalledOnce();
    expect(() =>
      awsCommand([], request.SecretString, () => ({
        status: 1,
        stderr: request.SecretString,
        stdout: "",
      })),
    ).toThrow("Runtime secret metadata or input did not match the reviewed contract");
  });

  it("writes the same typed credentials to both owned secrets and reports metadata only", async () => {
    const config = validateConfig(input());
    const fake = fakeAws(config);
    const report = vi.fn();
    await populateRuntimeSecrets(config, {
      aws: fake.aws,
      prompt: async () => credentials(),
      report,
    });
    expect([...fake.written]).toEqual(["web", "worker"]);
    const puts = fake.calls.filter((call) => call.action === "put-secret-value");
    expect(puts).toHaveLength(2);
    expect(puts[0].args).toContain("file:///dev/stdin");
    expect(JSON.parse(puts[0].request)).toEqual(JSON.parse(puts[1].request));
    expect(report.mock.calls.map(([record]) => record.component)).toEqual(["web", "worker"]);
    expect(JSON.stringify(report.mock.calls)).not.toContain(
      "sb_secret_synthetic-staging-secret-key",
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain("a".repeat(64));
  });

  it("stops before prompting on an existing version and never retries an ambiguous write", async () => {
    const config = validateConfig(input());
    const existing = fakeAws(config, { preexisting: "worker" });
    const prompt = vi.fn(async () => credentials());
    await expect(
      populateRuntimeSecrets(config, { aws: existing.aws, prompt, report: vi.fn() }),
    ).rejects.toThrow();
    expect(prompt).not.toHaveBeenCalled();
    expect(existing.calls.some((call) => call.action === "put-secret-value")).toBe(false);

    const failed = fakeAws(config, { failWrite: "worker" });
    const report = vi.fn();
    await expect(
      populateRuntimeSecrets(config, { aws: failed.aws, prompt, report }),
    ).rejects.toThrow();
    expect(failed.calls.filter((call) => call.action === "put-secret-value")).toHaveLength(2);
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0][0].component).toBe("web");
  });

  it("rejects a tampered imported config before any AWS request", async () => {
    const config = validateConfig(input());
    config.secrets.worker.arn = secretArn("web");
    const aws = vi.fn();
    await expect(
      populateRuntimeSecrets(config, { aws, prompt: vi.fn(), report: vi.fn() }),
    ).rejects.toThrow();
    expect(aws).not.toHaveBeenCalled();
  });

  it("rejects piped input and secret-bearing flags without echoing their text", () => {
    const result = spawnSync(process.execPath, [script, "--secret-string", "must-not-print-me"], {
      input: "must-not-print-me",
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Stopped");
    expect(result.stderr).not.toContain("must-not-print-me");
  });
});

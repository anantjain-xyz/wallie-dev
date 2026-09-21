import { devNull } from "node:os";
import { beforeAll, describe, expect, it, vi } from "vitest";

type RunOptions = { env: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; timeout: number };
type Runner = (command: string, args: string[], options: RunOptions) => Promise<string>;
let resolveTemporaryAwsCredentials: (options: {
  profile: string;
  run: Runner;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  now?: () => number;
}) => Promise<{ env: NodeJS.ProcessEnv; expiration: string }>;
beforeAll(async () => {
  const script = new URL("../../../scripts/lib/aws-image-credentials.mjs", import.meta.url).href;
  ({ resolveTemporaryAwsCredentials } = await import(script));
});

const now = () => Date.parse("2026-01-01T00:00:00Z");
const temporary = {
  Version: 1,
  AccessKeyId: "ASIA_SYNTHETIC_TEST_KEY",
  SecretAccessKey: "synthetic-secret-access-key",
  SessionToken: "synthetic-session-token",
  Expiration: "2026-01-01T01:00:00Z",
};
const ambient = {
  NODE_ENV: "test" as const,
  PATH: "/tools",
  HOME: "/synthetic-home",
  AWS_PROFILE: "another-profile",
  AWS_DEFAULT_PROFILE: "default-profile",
  AWS_ACCESS_KEY_ID: "ambient-access-key",
  AWS_SECRET_ACCESS_KEY: "ambient-secret-key",
  AWS_SESSION_TOKEN: "ambient-session-token",
  AWS_SECURITY_TOKEN: "legacy-session-token",
  AWS_CREDENTIAL_EXPIRATION: "2099-01-01T00:00:00Z",
  AWS_ROLE_ARN: "ambient-role",
  AWS_ROLE_SESSION_NAME: "ambient-session",
  AWS_WEB_IDENTITY_TOKEN_FILE: "/ambient-token",
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/ambient-container",
  AWS_CONTAINER_CREDENTIALS_FULL_URI: "https://synthetic.invalid/credentials",
  AWS_CONTAINER_CREDENTIALS_AUTHORIZATION_TOKEN: "ambient-container-token",
  AWS_CONTAINER_CREDENTIALS_AUTHORIZATION_TOKEN_FILE: "/ambient-container-token",
  AWS_CREDENTIAL_FILE: "/legacy-credential-file",
  AWS_CONFIG_FILE: "/selected/config",
  AWS_SHARED_CREDENTIALS_FILE: "/selected/credentials",
  AWS_LOGIN_CACHE_DIRECTORY: "/selected/login/cache",
  AWS_EC2_METADATA_DISABLED: "false",
  AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "false",
  AWS_PAGER: "pager-command",
  AWS_CLI_AUTO_PROMPT: "on",
  BOTO_CONFIG: "/legacy-boto-config",
};

function resolveOutput(output: unknown, env: NodeJS.ProcessEnv = { NODE_ENV: "test" }) {
  const run = vi.fn<Runner>().mockResolvedValue(JSON.stringify(output));
  return {
    run,
    result: resolveTemporaryAwsCredentials({ profile: "wallie-staging", run, env, now }),
  };
}

describe("temporary AWS image publishing credentials", () => {
  it("resolves only the named profile and binds a separate environment to the exported session", async () => {
    const original = { ...ambient };
    const run = vi.fn<Runner>().mockResolvedValue(JSON.stringify(temporary));
    const signal = new AbortController().signal;
    const result = await resolveTemporaryAwsCredentials({
      profile: "wallie-staging",
      run,
      env: ambient,
      cwd: "/reviewed/source",
      signal,
      now,
    });
    expect(run).toHaveBeenCalledTimes(1);
    const [command, args, options] = run.mock.calls[0];
    expect(command).toBe("aws");
    expect(args.slice(0, 6)).toEqual([
      "configure",
      "export-credentials",
      "--format",
      "process",
      "--profile",
      "wallie-staging",
    ]);
    expect(args).not.toContain("--debug");
    expect(options).toMatchObject({ cwd: "/reviewed/source", signal, timeout: 60_000 });
    expect(options.env).toMatchObject({
      PATH: ambient.PATH,
      HOME: ambient.HOME,
      AWS_CONFIG_FILE: ambient.AWS_CONFIG_FILE,
      AWS_SHARED_CREDENTIALS_FILE: ambient.AWS_SHARED_CREDENTIALS_FILE,
      AWS_LOGIN_CACHE_DIRECTORY: ambient.AWS_LOGIN_CACHE_DIRECTORY,
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
      AWS_PAGER: "",
      AWS_CLI_AUTO_PROMPT: "off",
      BOTO_CONFIG: devNull,
    });
    const providerKeys = Object.keys(ambient).filter(
      (key) =>
        /(?:TOKEN|ACCESS_KEY|PROFILE|ROLE|CREDENTIAL)/.test(key) &&
        key !== "AWS_SHARED_CREDENTIALS_FILE",
    );
    for (const key of providerKeys) expect(options.env).not.toHaveProperty(key);
    expect(result.expiration).toBe("2026-01-01T01:00:00.000Z");
    expect(result.env).toMatchObject({
      AWS_ACCESS_KEY_ID: temporary.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: temporary.SecretAccessKey,
      AWS_SESSION_TOKEN: temporary.SessionToken,
      AWS_CONFIG_FILE: devNull,
      AWS_SHARED_CREDENTIALS_FILE: devNull,
      BOTO_CONFIG: devNull,
    });
    for (const key of providerKeys.filter(
      (key) => !["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"].includes(key),
    ))
      expect(result.env).not.toHaveProperty(key);
    expect(result.env).not.toHaveProperty("AWS_LOGIN_CACHE_DIRECTORY");
    expect(ambient).toEqual(original);
    expect(result.env).not.toBe(ambient);
    expect(result.env).not.toBe(options.env);
  });

  it("does not reread or retain an ambient credential source after export", async () => {
    const env = { ...ambient };
    const { run, result } = resolveOutput(temporary, env);
    const snapshot = await result;
    env.AWS_ACCESS_KEY_ID = "changed-key";
    env.AWS_PROFILE = "changed-profile";
    run.mockResolvedValue(JSON.stringify({ ...temporary, AccessKeyId: "changed-provider-key" }));
    expect(snapshot.env.AWS_ACCESS_KEY_ID).toBe(temporary.AccessKeyId);
    expect(snapshot.env).not.toHaveProperty("AWS_PROFILE");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["long-lived keys", { SessionToken: undefined, Expiration: undefined }],
    ["missing token", { SessionToken: undefined }],
    ["empty token", { SessionToken: "" }],
    ["invalid token", { SessionToken: "secret\nextra" }],
    ["missing access key", { AccessKeyId: undefined }],
    ["empty secret", { SecretAccessKey: "" }],
    ["non-string secret", { SecretAccessKey: 123 }],
    ["missing expiration", { Expiration: undefined }],
    ["expired", { Expiration: "2025-12-31T23:59:59Z" }],
    ["expires now", { Expiration: "2026-01-01T00:00:00Z" }],
    ["invalid expiration", { Expiration: "synthetic-secret" }],
    ["invalid calendar date", { Expiration: "2026-02-30T01:00:00Z" }],
    ["numeric expiration", { Expiration: 9999999999999 }],
    ["timezone missing", { Expiration: "2026-01-01T01:00:00" }],
    ["unsupported version", { Version: 2 }],
    ["missing version", { Version: undefined }],
  ])("rejects %s without exposing provider values", async (_name, overrides) => {
    await expect(resolveOutput({ ...temporary, ...overrides }).result).rejects.toThrow(
      /^The selected AWS profile must provide unexpired temporary session credentials$/,
    );
  });

  it.each([null, [], "synthetic-secret", {}])(
    "rejects malformed credential objects: %j",
    async (value) => {
      await expect(resolveOutput(value).result).rejects.toThrow(
        "must provide unexpired temporary session credentials",
      );
    },
  );

  it.each(["synthetic-secret: invalid JSON", "x".repeat(128 * 1024 + 1)])(
    "redacts malformed or oversized output",
    async (output) => {
      const run = vi.fn<Runner>().mockResolvedValue(output);
      await expect(
        resolveTemporaryAwsCredentials({ profile: "wallie-staging", run, now }),
      ).rejects.toThrow(
        /^The selected AWS profile must provide unexpired temporary session credentials$/,
      );
    },
  );

  it("redacts provider failures without preserving their cause", async () => {
    const run = vi.fn<Runner>().mockRejectedValue(new Error(JSON.stringify(temporary)));
    const error = await resolveTemporaryAwsCredentials({
      profile: "wallie-staging",
      run,
      now,
    }).catch((failure: Error) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Could not resolve the selected AWS profile; renew its temporary login",
    );
    expect(error).not.toHaveProperty("cause");
  });

  it("rejects an invalid profile before invoking a provider", async () => {
    const run = vi.fn<Runner>();
    await expect(resolveTemporaryAwsCredentials({ profile: "", run, now })).rejects.toThrow(
      "A named temporary AWS login profile is required",
    );
    expect(run).not.toHaveBeenCalled();
  });
});

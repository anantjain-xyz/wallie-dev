import { beforeAll, describe, expect, it } from "vitest";

type Environment = Record<string, string | undefined>;
let withoutAwsProviderEnvironment: (env: Readonly<Environment>) => Environment;
beforeAll(async () => {
  const script = new URL("../../../scripts/lib/aws-image-environment.mjs", import.meta.url).href;
  ({ withoutAwsProviderEnvironment } = await import(script));
});

describe("non-AWS image publishing environment", () => {
  it.each([
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_ACCESS_KEY",
    "AWS_SECRET_KEY",
    "AWS_CREDENTIAL_EXPIRATION",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CREDENTIAL_FILE",
    "AWS_LOGIN_CACHE_DIRECTORY",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_CREDENTIALS_AUTHORIZATION_TOKEN_FILE",
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_ECR",
    "AWS_FUTURE_PROVIDER_HINT",
    "BOTO_CONFIG",
    "aws_session_token",
    "Boto_Config",
  ])("removes %s from tool environments", (key) => {
    expect(withoutAwsProviderEnvironment({ [key]: "synthetic-value", PATH: "/tools" })).toEqual({
      PATH: "/tools",
    });
  });

  it("preserves ordinary Git, Docker, SSH, and shell settings without mutating the input", () => {
    const ordinary = {
      PATH: "/tools",
      HOME: "/synthetic-home",
      NODE_ENV: "test",
      DOCKER_HOST: "unix:///synthetic/docker.sock",
      DOCKER_CONTEXT: "desktop-linux",
      DOCKER_CONFIG: "/synthetic/docker-config",
      BUILDX_BUILDER: "wallie-builder",
      SSH_AUTH_SOCK: "/synthetic/agent.sock",
      GIT_SSH_COMMAND: "ssh -F /synthetic/ssh-config",
      TMPDIR: "/synthetic/tmp",
      HTTPS_PROXY: "https://synthetic.invalid",
      UNSET_VALUE: undefined,
    };
    const input = Object.freeze({
      ...ordinary,
      AWS_ACCESS_KEY_ID: "synthetic-key",
      AWS_PROFILE: "selected-profile",
      BOTO_CONFIG: "/synthetic/boto-config",
    });
    const result = withoutAwsProviderEnvironment(input);
    expect(result).toEqual(ordinary);
    expect(result).not.toBe(input);
    result.PATH = "/changed-tools";
    expect(input.PATH).toBe(ordinary.PATH);
    expect(input.AWS_ACCESS_KEY_ID).toBe("synthetic-key");
    expect(input.AWS_PROFILE).toBe("selected-profile");
    expect(input.BOTO_CONFIG).toBe("/synthetic/boto-config");
  });

  it("returns a fresh empty environment when all inputs are AWS-specific", () => {
    expect(
      withoutAwsProviderEnvironment({ AWS_SESSION_TOKEN: undefined, BOTO_CONFIG: "legacy" }),
    ).toEqual({});
  });
});

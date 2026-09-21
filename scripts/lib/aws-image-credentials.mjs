import { devNull } from "node:os";

const providerKeys = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_CREDENTIAL_EXPIRATION",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CREDENTIAL_FILE",
]);

function isolatedEnvironment(env) {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([key]) => !providerKeys.has(key) && !key.startsWith("AWS_CONTAINER_CREDENTIALS_"),
      ),
    ),
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
    AWS_PAGER: "",
    AWS_CLI_AUTO_PROMPT: "off",
    BOTO_CONFIG: devNull,
  };
}

/** Return an in-memory credential snapshot. Use its env only for AWS commands, without --profile. */
export async function resolveTemporaryAwsCredentials({
  profile,
  run,
  env = process.env,
  cwd,
  signal,
  now = Date.now,
}) {
  if (!/^[\w][\w.-]{0,127}$/.test(profile ?? ""))
    throw new Error("A named temporary AWS login profile is required");

  let output;
  try {
    output = await run(
      "aws",
      [
        "configure",
        "export-credentials",
        "--format",
        "process",
        "--profile",
        profile,
        "--no-cli-pager",
        "--no-cli-auto-prompt",
        "--cli-connect-timeout",
        "15",
        "--cli-read-timeout",
        "30",
      ],
      { cwd, signal, env: isolatedEnvironment(env), timeout: 60_000 },
    );
  } catch {
    // Provider errors may contain credentials; do not preserve their message or cause.
    throw new Error("Could not resolve the selected AWS profile; renew its temporary login");
  }

  let credentials;
  try {
    if (typeof output !== "string" || output.length > 128 * 1024) throw new Error();
    credentials = JSON.parse(output);
    const printable = (value) => typeof value === "string" && /^[\x21-\x7e]+$/.test(value);
    const expiry = credentials.Expiration;
    const currentTime = now();
    if (
      credentials.Version !== 1 ||
      ![credentials.AccessKeyId, credentials.SecretAccessKey, credentials.SessionToken].every(
        printable,
      ) ||
      typeof expiry !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(expiry) ||
      new Date(`${expiry.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !==
        expiry.slice(0, 10) ||
      !Number.isFinite(currentTime) ||
      !(Date.parse(expiry) > currentTime)
    )
      throw new Error();
  } catch {
    throw new Error(
      "The selected AWS profile must provide unexpired temporary session credentials",
    );
  }

  const scopedEnv = isolatedEnvironment(env);
  delete scopedEnv.AWS_LOGIN_CACHE_DIRECTORY;
  return {
    expiration: new Date(credentials.Expiration).toISOString(),
    env: {
      ...scopedEnv,
      AWS_CONFIG_FILE: devNull,
      AWS_SHARED_CREDENTIALS_FILE: devNull,
      AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
      AWS_SESSION_TOKEN: credentials.SessionToken,
    },
  };
}

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import {
  awsCommand,
  cliEnv,
  hiddenPrompt,
  verifyMetadata,
} from "./populate-aws-runtime-secrets.mjs";

const account = "111614490109";
const region = "us-west-2";
const arn =
  "arn:aws:secretsmanager:us-west-2:111614490109:secret:/wallie/staging/web/runtime-vDeDr4";
const versionPattern = /^[A-Za-z0-9_-]{32,64}$/;
const hexKey = /^[0-9a-fA-F]{64,}$/;
const base64Key = /^[A-Za-z0-9+/_-]{43,}={0,2}$/;

function check(condition) {
  if (!condition)
    throw new Error("Hosted web secret input or AWS metadata differs from the reviewed contract");
}

export function hostedConfig(versionId, hostedOrigin, existingOrigin) {
  check(versionPattern.test(versionId ?? ""));
  let origin, existing;
  try {
    origin = new URL(hostedOrigin);
    existing = new URL(existingOrigin);
  } catch {
    throw new Error("Invalid hosted Supabase origin");
  }
  check(
    origin.protocol === "https:" &&
      origin.origin === hostedOrigin &&
      /^[a-z0-9-]+\.supabase\.co$/.test(origin.hostname) &&
      existing.protocol === "https:" &&
      existing.origin === existingOrigin &&
      /^[a-z0-9-]+\.supabase\.co$/.test(existing.hostname) &&
      origin.origin === existing.origin,
  );
  return { account, region, hostedOrigin, existingOrigin, secrets: { web: { arn, versionId } } };
}

export function hostedPutRequest(config, values) {
  check(config.account === account && config.region === region && config.secrets?.web?.arn === arn);
  check(versionPattern.test(config.secrets.web.versionId));
  check(
    typeof values.supabaseSecretKey === "string" &&
      values.supabaseSecretKey.startsWith("sb_secret_") &&
      values.supabaseSecretKey.length > "sb_secret_".length &&
      values.supabaseSecretKey.length <= 4096 &&
      !/\s/.test(values.supabaseSecretKey),
  );
  check(
    typeof values.wallieEncryptionKey === "string" &&
      (hexKey.test(values.wallieEncryptionKey) || base64Key.test(values.wallieEncryptionKey)),
  );
  return {
    SecretId: arn,
    ClientRequestToken: config.secrets.web.versionId,
    SecretString: JSON.stringify({
      SUPABASE_SECRET_KEY: values.supabaseSecretKey,
      WALLIE_ENCRYPTION_KEY: values.wallieEncryptionKey,
    }),
    VersionStages: ["AWSCURRENT"],
  };
}

function aws(config, service, action, args = [], input) {
  return awsCommand(
    ["--region", config.region, "--no-cli-pager", "--output", "json", service, action, ...args],
    input,
  );
}

function metadata(config, call) {
  const args = ["--secret-id", arn];
  return {
    description: call(config, "secretsmanager", "describe-secret", args),
    policy: call(config, "secretsmanager", "get-resource-policy", args),
    versions: call(config, "secretsmanager", "list-secret-version-ids", [
      ...args,
      "--include-deprecated",
      "--no-paginate",
    ]),
  };
}

export async function populateHostedWebSecret(config, { call = aws, prompt, report }) {
  check(config.account === account && config.region === region && config.secrets?.web?.arn === arn);
  check(
    Object.keys(config.secrets).length === 1 && versionPattern.test(config.secrets.web.versionId),
  );
  check(
    hostedConfig(config.secrets.web.versionId, config.hostedOrigin, config.existingOrigin)
      .hostedOrigin === config.hostedOrigin,
  );
  const identity = call(config, "sts", "get-caller-identity");
  check(
    identity.Account === account && identity.Arn === `arn:aws:iam::${account}:user/wallie-local`,
  );
  const before = metadata(config, call);
  verifyMetadata(config, "web", before.description, before.policy, before.versions, "empty");
  const values = await prompt(config.hostedOrigin);
  const request = hostedPutRequest(config, values);
  const fresh = metadata(config, call);
  verifyMetadata(config, "web", fresh.description, fresh.policy, fresh.versions, "empty");
  const response = call(
    config,
    "secretsmanager",
    "put-secret-value",
    [
      "--secret-id",
      request.SecretId,
      "--client-request-token",
      request.ClientRequestToken,
      "--version-stages",
      "AWSCURRENT",
      "--secret-string",
      "file:///dev/stdin",
    ],
    request.SecretString,
  );
  check(response.ARN === arn && response.Name === "/wallie/staging/web/runtime");
  check(response.VersionId === request.ClientRequestToken);
  check(JSON.stringify(response.VersionStages) === '["AWSCURRENT"]');
  check(response.SecretString === undefined && response.SecretBinary === undefined);
  const after = metadata(config, call);
  verifyMetadata(config, "web", after.description, after.policy, after.versions, "populated");
  report({
    secretArn: arn,
    versionId: request.ClientRequestToken,
    status: "version-metadata-matched",
  });
}

async function promptValues(origin) {
  const supabaseSecretKey = await hiddenPrompt(`${origin} active sb_secret key (hidden)`);
  const wallieEncryptionKey = await hiddenPrompt(
    "EXISTING production WALLIE_ENCRYPTION_KEY (hidden)",
  );
  const confirmation = await hiddenPrompt(
    "Repeat EXISTING production WALLIE_ENCRYPTION_KEY (hidden)",
  );
  check(wallieEncryptionKey === confirmation);
  return { supabaseSecretKey, wallieEncryptionKey };
}

function parseConfig(argv) {
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    tokens: true,
    options: {
      "version-id": { type: "string" },
      "hosted-origin": { type: "string" },
      "existing-origin": { type: "string" },
    },
  });
  check(positionals.length === 0 && tokens.length === 3 && Object.keys(values).length === 3);
  return hostedConfig(values["version-id"], values["hosted-origin"], values["existing-origin"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = parseConfig(process.argv.slice(2));
    check(process.stdin.isTTY && process.stdout.isTTY);
    const history = spawnSync("aws", ["configure", "get", "cli_history"], {
      encoding: "utf8",
      env: cliEnv(),
      timeout: 10_000,
    });
    check(!history.error && !history.stderr && [0, 1].includes(history.status));
    check(history.stdout.trim() === "" || history.stdout.trim() === "disabled");
    await populateHostedWebSecret(config, {
      prompt: promptValues,
      report: (record) => console.log(JSON.stringify(record)),
    });
  } catch {
    console.error(
      "[aws-hosted-web-secret] Stopped. No values were printed. Inspect version metadata before any retry; a write may have succeeded.",
    );
    process.exitCode = 1;
  }
}

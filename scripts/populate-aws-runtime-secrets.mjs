import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const components = ["web", "worker"];
const account = "111614490109";
const region = "us-west-2";
const secretArns = {
  web: "arn:aws:secretsmanager:us-west-2:111614490109:secret:/wallie/staging/web/runtime-vDeDr4",
  worker:
    "arn:aws:secretsmanager:us-west-2:111614490109:secret:/wallie/staging/worker/runtime-4C4k43",
};
const encryptionKey = /^[0-9a-fA-F]{64}$/;
const versionId = /^[A-Za-z0-9_-]{32,64}$/;
const expectedTags = (component) => ({
  Project: "Wallie",
  Environment: "staging",
  ManagedBy: "Terraform",
  WallieStack: "wallie-staging-application",
  Component: "runtime-secrets",
  Name: `/wallie/staging/${component}/runtime`,
});

function requireCondition(condition) {
  if (!condition)
    throw new Error("Runtime secret metadata or input did not match the reviewed contract");
}

export function validateConfig(input) {
  requireCondition(
    input &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      JSON.stringify(Object.keys(input).sort()) ===
        JSON.stringify(["webVersionId", "workerVersionId"]),
  );
  const result = { account, region, secrets: {} };
  for (const component of components) {
    const id = input[`${component}VersionId`];
    requireCondition(versionId.test(id ?? ""));
    result.secrets[component] = { arn: secretArns[component], versionId: id };
  }
  requireCondition(result.secrets.web.versionId !== result.secrets.worker.versionId);
  return result;
}

function verifySecretDescription(config, component, response) {
  const { arn } = config.secrets[component];
  requireCondition(response?.ARN === arn);
  requireCondition(response.Name === `/wallie/staging/${component}/runtime`);
  requireCondition(
    response.Description ===
      `Wallie staging ${component} runtime secret configuration; values managed outside Terraform.`,
  );
  requireCondition(Array.isArray(response.Tags) && response.Tags.length === 6);
  const tags = Object.fromEntries(response.Tags.map(({ Key, Value }) => [Key, Value]));
  requireCondition(Object.keys(tags).length === 6);
  requireCondition(
    Object.entries(expectedTags(component)).every(([key, value]) => tags[key] === value),
  );
  for (const field of [
    "DeletedDate",
    "KmsKeyId",
    "RotationLambdaARN",
    "OwningService",
    "PrimaryRegion",
  ])
    requireCondition(response[field] === undefined);
  requireCondition(response.RotationEnabled === undefined || response.RotationEnabled === false);
  requireCondition(
    response.RotationRules === undefined || Object.keys(response.RotationRules).length === 0,
  );
  requireCondition(
    response.ReplicationStatus === undefined || response.ReplicationStatus.length === 0,
  );
  requireCondition(response.SecretString === undefined && response.SecretBinary === undefined);
}

export function verifyMetadata(config, component, description, policy, versions, state) {
  verifySecretDescription(config, component, description);
  const { arn, versionId: id } = config.secrets[component];
  for (const response of [policy, versions]) {
    requireCondition(response?.ARN === arn);
    requireCondition(response.Name === `/wallie/staging/${component}/runtime`);
    requireCondition(response.SecretString === undefined && response.SecretBinary === undefined);
  }
  requireCondition(policy.ResourcePolicy === undefined);
  requireCondition(Array.isArray(versions.Versions) && versions.NextToken === undefined);
  if (state === "empty") {
    requireCondition(versions.Versions.length === 0);
    requireCondition(Object.keys(description.VersionIdsToStages ?? {}).length === 0);
  } else {
    requireCondition(versions.Versions.length === 1);
    requireCondition(versions.Versions[0].VersionId === id);
    requireCondition(JSON.stringify(versions.Versions[0].VersionStages) === '["AWSCURRENT"]');
    requireCondition(
      JSON.stringify(description.VersionIdsToStages) === JSON.stringify({ [id]: ["AWSCURRENT"] }),
    );
  }
}

export function buildPutRequest(config, component, credentials) {
  requireCondition(
    typeof credentials.supabaseSecretKey === "string" &&
      credentials.supabaseSecretKey.startsWith("sb_secret_") &&
      credentials.supabaseSecretKey.length > "sb_secret_".length &&
      credentials.supabaseSecretKey.length <= 4096 &&
      !/\s/.test(credentials.supabaseSecretKey),
  );
  requireCondition(encryptionKey.test(credentials.wallieEncryptionKey ?? ""));
  return {
    SecretId: config.secrets[component].arn,
    ClientRequestToken: config.secrets[component].versionId,
    SecretString: JSON.stringify({
      SUPABASE_SECRET_KEY: credentials.supabaseSecretKey,
      WALLIE_ENCRYPTION_KEY: credentials.wallieEncryptionKey,
    }),
    VersionStages: ["AWSCURRENT"],
  };
}

function cliEnv() {
  // Keep only the local CLI login context. In particular, ambient endpoint and
  // proxy overrides must never redirect a request that carries SecretString.
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    AWS_PROFILE: "wallie-staging",
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_PAGER: "",
    AWS_CLI_AUTO_PROMPT: "off",
  };
}

export function awsCommand(args, input, spawn = spawnSync) {
  const result = spawn("aws", args, {
    encoding: "utf8",
    input,
    env: cliEnv(),
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  // Do not emit AWS CLI stderr: a CLI error might include request parameters.
  requireCondition(!result.error && result.status === 0 && !result.stderr);
  return JSON.parse(result.stdout);
}

function command(config, service, action, additional = [], input) {
  return awsCommand(
    [
      "--region",
      config.region,
      "--no-cli-pager",
      "--output",
      "json",
      service,
      action,
      ...additional,
    ],
    input,
  );
}

function readMetadata(config, component, aws) {
  const arn = config.secrets[component].arn;
  return {
    description: aws(config, "secretsmanager", "describe-secret", ["--secret-id", arn]),
    policy: aws(config, "secretsmanager", "get-resource-policy", ["--secret-id", arn]),
    versions: aws(config, "secretsmanager", "list-secret-version-ids", [
      "--secret-id",
      arn,
      "--include-deprecated",
      "--no-paginate",
    ]),
  };
}

export async function populateRuntimeSecrets(config, { aws = command, prompt, report }) {
  requireCondition(config.account === account && config.region === region);
  for (const component of components) {
    requireCondition(config.secrets?.[component]?.arn === secretArns[component]);
    requireCondition(versionId.test(config.secrets[component].versionId ?? ""));
  }
  requireCondition(config.secrets.web.versionId !== config.secrets.worker.versionId);
  const identity = aws(config, "sts", "get-caller-identity");
  requireCondition(identity.Account === config.account);
  requireCondition(identity.Arn === `arn:aws:iam::${config.account}:user/wallie-local`);
  for (const component of components) {
    const { description, policy, versions } = readMetadata(config, component, aws);
    verifyMetadata(config, component, description, policy, versions, "empty");
  }

  const credentials = await prompt();
  // Construct both payloads before the first write. They contain the same key.
  const requests = Object.fromEntries(
    components.map((component) => [component, buildPutRequest(config, component, credentials)]),
  );
  for (const component of components) {
    // A fresh check narrows the race window; Secrets Manager has no conditional write here.
    const before = readMetadata(config, component, aws);
    verifyMetadata(config, component, before.description, before.policy, before.versions, "empty");
    const response = aws(
      config,
      "secretsmanager",
      "put-secret-value",
      [
        "--secret-id",
        requests[component].SecretId,
        "--client-request-token",
        requests[component].ClientRequestToken,
        "--version-stages",
        "AWSCURRENT",
        "--secret-string",
        "file:///dev/stdin",
      ],
      requests[component].SecretString,
    );
    requireCondition(response.ARN === config.secrets[component].arn);
    requireCondition(response.Name === `/wallie/staging/${component}/runtime`);
    requireCondition(response.VersionId === config.secrets[component].versionId);
    requireCondition(JSON.stringify(response.VersionStages) === '["AWSCURRENT"]');
    requireCondition(response.SecretString === undefined && response.SecretBinary === undefined);
    const after = readMetadata(config, component, aws);
    verifyMetadata(config, component, after.description, after.policy, after.versions, "populated");
    report({
      component,
      secretArn: config.secrets[component].arn,
      versionId: config.secrets[component].versionId,
      status: "version-metadata-matched",
    });
  }
}

async function hiddenPrompt(label) {
  requireCondition(process.stdin.isTTY && process.stdout.isTTY && process.stdin.setRawMode);
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = process.stdin.isRaw ?? false;
    function finish(error) {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    }
    function onData(data) {
      for (const byte of data) {
        if (byte === 3) return finish(new Error("Interrupted"));
        if (byte === 10 || byte === 13) return finish();
        if (byte === 8 || byte === 127) value = value.slice(0, -1);
        else if (byte >= 33 && byte <= 126 && value.length < 4096)
          value += String.fromCharCode(byte);
        else return finish(new Error("Invalid secret input"));
      }
    }
    process.stdin.setRawMode(true);
    process.stdin.on("data", onData);
    process.stdout.write(`${label}: `);
    process.stdin.resume();
  });
}

async function promptSecrets() {
  const supabaseSecretKey = await hiddenPrompt("Isolated staging SUPABASE_SECRET_KEY (hidden)");
  const wallieEncryptionKey = await hiddenPrompt("Fresh staging WALLIE_ENCRYPTION_KEY (hidden)");
  const confirmation = await hiddenPrompt("Repeat fresh staging WALLIE_ENCRYPTION_KEY (hidden)");
  requireCondition(wallieEncryptionKey === confirmation);
  return { supabaseSecretKey, wallieEncryptionKey };
}

function parseConfig(argv) {
  const names = ["web-version-id", "worker-version-id"];
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    tokens: true,
    options: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
  });
  requireCondition(positionals.length === 0 && tokens.length === names.length);
  requireCondition(Object.keys(values).length === names.length);
  return validateConfig({
    webVersionId: values["web-version-id"],
    workerVersionId: values["worker-version-id"],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = parseConfig(process.argv.slice(2));
    requireCondition(process.stdin.isTTY && process.stdout.isTTY);
    const history = spawnSync("aws", ["configure", "get", "cli_history"], {
      encoding: "utf8",
      env: cliEnv(),
      timeout: 10_000,
    });
    requireCondition(!history.error && !history.stderr && [0, 1].includes(history.status));
    requireCondition(history.stdout.trim() === "" || history.stdout.trim() === "disabled");
    await populateRuntimeSecrets(config, {
      prompt: promptSecrets,
      report: (record) => console.log(JSON.stringify(record)),
    });
  } catch {
    console.error(
      "[aws-runtime-secret-population] Stopped. No values were printed. Inspect version metadata before any retry; a write may have succeeded.",
    );
    process.exitCode = 1;
  }
}

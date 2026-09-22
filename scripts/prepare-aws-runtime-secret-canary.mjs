import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const equal = (actual, expected, name) =>
  check(isDeepStrictEqual(actual, expected), `Unexpected ${name}`);
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys, name) => {
  check(object(value), `Invalid ${name}`);
  equal(Object.keys(value).sort(), [...keys].sort(), `${name} fields`);
};
const matches = (value, pattern) =>
  typeof value === "string" && value === value.trim() && pattern.test(value);
const time = (value) => {
  check(matches(value, /^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/), "Invalid capture time");
  const result = Date.parse(value);
  check(Number.isFinite(result), "Invalid capture time");
  return result;
};

export function validateInputs(input) {
  exactKeys(
    input,
    ["schemaVersion", "account", "region", "component", "runId", "secretArn"],
    "canary inputs",
  );
  check(
    input.schemaVersion === 1 && matches(input.account, /^\d{12}$/),
    "Invalid canary account or version",
  );
  check(
    matches(input.region, /^(?!cn-)[a-z]{2}-[a-z]+-\d+$/),
    "A commercial AWS region is required",
  );
  check(["web", "worker"].includes(input.component), "Invalid canary component");
  check(
    matches(input.runId, /^[a-f0-9]{32}$/),
    "A new 32-character lowercase hex run ID is required",
  );
  check(
    matches(
      input.secretArn,
      new RegExp(
        `^arn:aws:secretsmanager:${input.region}:${input.account}:secret:/wallie/staging/${input.component}/runtime-[A-Za-z0-9]{6}$`,
      ),
    ),
    "Expected this component's full runtime secret ARN",
  );
  return structuredClone(input);
}

function capture(envelope, now, request) {
  exactKeys(
    envelope,
    ["requestStartedAt", "capturedAt", "response", ...(request ? ["request"] : [])],
    "capture envelope",
  );
  if (request) equal(envelope.request, request, "version inventory request");
  const started = time(envelope.requestStartedAt),
    received = time(envelope.capturedAt);
  check(
    Number.isFinite(now) && started <= received && received <= now && now - started <= 15 * 60_000,
    "Recollect fresh metadata within 15 minutes",
  );
  check(object(envelope.response), "Invalid metadata response");
  check(
    !["SecretString", "SecretBinary"].some((field) => Object.hasOwn(envelope.response, field)),
    "Value-bearing responses are not metadata",
  );
  return envelope.response;
}

function identity(input, response) {
  equal(response.ARN, input.secretArn, "secret ARN");
  equal(response.Name, `/wallie/staging/${input.component}/runtime`, "secret name");
}

function verifyMetadata(input, evidence, state, now) {
  const description = capture(evidence.secret, now);
  const policy = capture(evidence.resourcePolicy, now);
  const versions = capture(evidence.versions, now, {
    SecretId: input.secretArn,
    IncludeDeprecated: true,
  });
  for (const response of [description, policy, versions]) identity(input, response);
  check(!Object.hasOwn(versions, "NextToken"), "Incomplete version pagination");
  equal(
    description.Description,
    `Wallie staging ${input.component} runtime secret configuration; values managed outside Terraform.`,
    "secret description",
  );
  check(Array.isArray(description.Tags), "Missing secret tags");
  const tags = Object.fromEntries(description.Tags.map((tag) => [tag?.Key, tag?.Value]));
  equal(Object.keys(tags).length, description.Tags.length, "duplicate secret tags");
  equal(
    tags,
    {
      Project: "Wallie",
      Environment: "staging",
      ManagedBy: "Terraform",
      WallieStack: "wallie-staging-application",
      Component: "runtime-secrets",
      Name: `/wallie/staging/${input.component}/runtime`,
    },
    "secret ownership tags",
  );
  for (const field of [
    "DeletedDate",
    "KmsKeyId",
    "RotationLambdaARN",
    "OwningService",
    "PrimaryRegion",
  ])
    check(
      !Object.hasOwn(description, field),
      "Secret deletion, encryption, ownership, or replication changed",
    );
  check(
    description.RotationEnabled === undefined || description.RotationEnabled === false,
    "Secret rotation is enabled or invalid",
  );
  equal(
    description.RotationRules === undefined ? {} : description.RotationRules,
    {},
    "rotation rules",
  );
  equal(
    description.ReplicationStatus === undefined ? [] : description.ReplicationStatus,
    [],
    "secret replicas",
  );
  check(!Object.hasOwn(policy, "ResourcePolicy"), "Unexpected secret resource policy");
  check(
    Array.isArray(versions.Versions),
    "Missing version inventory including deprecated versions",
  );
  const stages = state === "active" ? ["AWSCURRENT"] : [];
  if (state === "empty") {
    equal(
      versions.Versions,
      [],
      "initial version inventory must be empty including deprecated versions",
    );
    equal(
      description.VersionIdsToStages === undefined ? {} : description.VersionIdsToStages,
      {},
      "initial version labels",
    );
  } else {
    check(
      versions.Versions.length === 1,
      "Expected exactly the canary version including deprecated versions",
    );
    const version = versions.Versions[0];
    equal(version.VersionId, input.runId, "canary version ID");
    check(
      version.KmsKeyIds === undefined ||
        (Array.isArray(version.KmsKeyIds) &&
          version.KmsKeyIds.every((key) => typeof key === "string" && key.length <= 2048)),
      "Invalid informational version encryption metadata",
    );
    equal(
      version.VersionStages === undefined ? [] : version.VersionStages,
      stages,
      "canary version labels",
    );
    const mapping =
      description.VersionIdsToStages === undefined ? {} : description.VersionIdsToStages;
    if (state === "retired" && isDeepStrictEqual(mapping, {})) return;
    equal(mapping, { [input.runId]: stages }, "described version labels");
  }
}

// These are offline metadata checks. Operators must preserve real captures,
// explicitly include deprecated versions, and serialize all writes to the secret.
export function prepareCanary(mode, supplied, evidence, now = Date.now()) {
  check(
    ["put-input", "verify", "cleanup-input", "verify-cleanup"].includes(mode),
    "Invalid canary command",
  );
  const input = validateInputs(supplied);
  const retired = mode === "verify-cleanup";
  verifyMetadata(
    input,
    evidence,
    mode === "put-input" ? "empty" : retired ? "retired" : "active",
    now,
  );
  if (mode === "put-input")
    return {
      SecretId: input.secretArn,
      ClientRequestToken: input.runId,
      SecretString: JSON.stringify({
        WALLIE_SMOKE_CANARY: `wallie-smoke:${input.component}:${input.runId}`,
      }),
      VersionStages: ["AWSCURRENT"],
    };
  if (mode === "cleanup-input")
    return {
      SecretId: input.secretArn,
      VersionStage: "AWSCURRENT",
      RemoveFromVersionId: input.runId,
    };
  const operation = capture(evidence.operation, now);
  identity(input, operation);
  if (!retired) {
    equal(operation.VersionId, input.runId, "written version ID");
    equal(operation.VersionStages, ["AWSCURRENT"], "written version labels");
  }
  for (const name of ["secret", "resourcePolicy", "versions"])
    check(
      time(evidence[name].requestStartedAt) >= time(evidence.operation.capturedAt),
      "Recapture metadata after the operation response",
    );
  return {
    schemaVersion: 1,
    status: retired ? "canary-label-removed" : "canary-version-metadata-matched",
    component: input.component,
    secretArn: input.secretArn,
    versionId: input.runId,
    deployable: false,
    limitation: retired
      ? "The deprecated canary version remains; this does not restore an empty secret."
      : "Offline metadata cannot authenticate captures or prove value contents; live injection must compare the derived canary without logging it.",
  };
}

function readJson(path) {
  try {
    const info = lstatSync(path);
    check(info.isFile() && info.size <= 1024 * 1024, "Invalid input file");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Expected a bounded regular JSON input file without symlinks");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals, tokens } = parseArgs({
      allowPositionals: true,
      tokens: true,
      options: { manifest: { type: "string" }, "readback-dir": { type: "string" } },
    });
    check(
      positionals.length === 1 &&
        tokens.filter((token) => token.kind === "option").length === Object.keys(values).length,
      "Use one canary command and each option once",
    );
    exactKeys(values, ["manifest", "readback-dir"], "command options");
    check(
      Object.values(values).every((value) => value.length > 0 && value === value.trim()),
      "Invalid command paths",
    );
    const input = validateInputs(readJson(values.manifest));
    const files = {
      secret: `${input.component}-secret`,
      versions: `${input.component}-versions`,
      resourcePolicy: `${input.component}-resource-policy`,
      ...(positionals[0] === "verify" ? { operation: `${input.component}-put` } : {}),
      ...(positionals[0] === "verify-cleanup" ? { operation: `${input.component}-cleanup` } : {}),
    };
    const evidence = Object.fromEntries(
      Object.entries(files).map(([key, name]) => [
        key,
        readJson(join(values["readback-dir"], `${name}.json`)),
      ]),
    );
    console.log(JSON.stringify(prepareCanary(positionals[0], input, evidence), null, 2));
  } catch {
    // Arguments and input may have been supplied incorrectly. Never echo them.
    console.error(
      "[aws-runtime-secret-canary] Preparation failed: check command, exact metadata, version state, and capture freshness; no AWS action was performed.",
    );
    process.exitCode = 1;
  }
}

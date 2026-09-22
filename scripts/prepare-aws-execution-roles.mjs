import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";

const usage =
  "Usage: node scripts/prepare-aws-execution-roles.mjs create-role-input|put-role-policy-input|manifest|verify --account-id <12 digits> --region <commercial AWS region> --component web|worker [--runtime-secret-arn <full own-component runtime secret ARN>] [--readback-dir <directory> (verify only)]";

function renderTemplate(name, account, region, component) {
  return JSON.parse(
    readFileSync(new URL(`../infra/aws/${name}.template.json`, import.meta.url), "utf8")
      .replaceAll("<ACCOUNT_ID>", account)
      .replaceAll("<REGION>", region)
      .replaceAll("<COMPONENT>", component),
  );
}

function artifacts(account, region, component, runtimeSecretArn) {
  const name = `wallie-staging-${component}-execution`;
  const role = {
    RoleName: name,
    Path: "/",
    Description: `Wallie staging ${component}: ECS image pull and log delivery`,
    MaxSessionDuration: 3600,
    Tags: Object.entries({
      Project: "Wallie",
      Environment: "staging",
      ManagedBy: "Administrator",
      Component: "execution-role",
      WallieStack: "wallie-staging-application",
      Name: name,
    }).map(([Key, Value]) => ({ Key, Value })),
    AssumeRolePolicyDocument: renderTemplate(
      "execution-role-trust-policy",
      account,
      region,
      component,
    ),
  };
  const inline = {
    RoleName: name,
    PolicyName: "WallieStagingExecution",
    PolicyDocument: renderTemplate("execution-role-policy", account, region, component),
  };
  if (runtimeSecretArn !== undefined)
    inline.PolicyDocument.Statement.push({
      Sid: "ReadOwnRuntimeSecret",
      Effect: "Allow",
      Action: "secretsmanager:GetSecretValue",
      Resource: runtimeSecretArn,
      Condition: {
        StringEquals: { "aws:PrincipalAccount": account, "aws:RequestedRegion": region },
      },
    });
  return {
    createRole: {
      ...role,
      AssumeRolePolicyDocument: JSON.stringify(role.AssumeRolePolicyDocument),
    },
    putRolePolicy: { ...inline, PolicyDocument: JSON.stringify(inline.PolicyDocument) },
    manifest: {
      schemaVersion: 1,
      account,
      region,
      component,
      ...(runtimeSecretArn === undefined ? {} : { runtimeSecretArn }),
      role: { ...role, Arn: `arn:aws:iam::${account}:role/${name}`, PermissionsBoundary: null },
      inlinePolicy: inline,
      inlinePolicyNames: [inline.PolicyName],
      attachedPolicyArns: [],
    },
  };
}

function requireEqual(actual, expected, field) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`Readback mismatch: ${field}`);
}

// IAM may return encoded JSON or decoded objects, and scalar/one-element lists.
// Normalize representation only; retain every policy field and list entry.
function canonical(value) {
  if (Array.isArray(value))
    return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

function policy(value) {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value.trim().startsWith("{") ? value : decodeURIComponent(value));
    } catch {
      throw new Error("Readback contains an invalid IAM policy document");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Readback contains an invalid IAM policy document");
  const document = structuredClone(value);
  const array = (item) => (Array.isArray(item) ? item : [item]);
  document.Statement = array(document.Statement);
  for (const statement of document.Statement) {
    if (!statement || typeof statement !== "object" || Array.isArray(statement))
      throw new Error("Readback contains an invalid IAM policy statement");
    for (const key of ["Action", "Resource"])
      if (key in statement) statement[key] = array(statement[key]);
    if (statement.Principal && typeof statement.Principal === "object")
      for (const key of Object.keys(statement.Principal))
        statement.Principal[key] = array(statement.Principal[key]);
    if (statement.Condition && typeof statement.Condition === "object")
      for (const condition of Object.values(statement.Condition))
        if (condition && typeof condition === "object")
          for (const key of Object.keys(condition)) condition[key] = array(condition[key]);
  }
  return canonical(document);
}

function readJson(directory, name) {
  const path = join(directory, `${name}.json`);
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error();
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Missing or invalid readback file: ${name}.json`);
  }
}

function verify(manifest, directory) {
  const role = readJson(directory, "get-role").Role;
  if (!role || typeof role !== "object") throw new Error("Missing Role in get-role.json");
  for (const field of ["Arn", "RoleName", "Path", "Description", "MaxSessionDuration"])
    requireEqual(role[field], manifest.role[field], field);
  requireEqual(role.PermissionsBoundary ?? null, null, "PermissionsBoundary must be absent");
  requireEqual(canonical(role.Tags), canonical(manifest.role.Tags), "Tags");
  requireEqual(
    policy(role.AssumeRolePolicyDocument),
    policy(manifest.role.AssumeRolePolicyDocument),
    "AssumeRolePolicyDocument",
  );
  for (const [name, field, expected] of [
    ["list-role-policies", "PolicyNames", manifest.inlinePolicyNames],
    ["list-attached-role-policies", "AttachedPolicies", []],
  ]) {
    const response = readJson(directory, name);
    if (response?.IsTruncated !== false || response.Marker || response.NextToken)
      throw new Error(`Incomplete readback pagination: ${name}`);
    requireEqual(canonical(response[field]), canonical(expected), field);
  }
  const inline = readJson(directory, "get-role-policy");
  requireEqual(inline.RoleName, manifest.role.RoleName, "inline RoleName");
  requireEqual(inline.PolicyName, manifest.inlinePolicy.PolicyName, "inline PolicyName");
  requireEqual(
    policy(inline.PolicyDocument),
    policy(manifest.inlinePolicy.PolicyDocument),
    "inline PolicyDocument",
  );
  return {
    schemaVersion: 1,
    status: "readback-matches-manifest",
    roleArn: manifest.role.Arn,
    component: manifest.component,
    region: manifest.region,
    ...(manifest.runtimeSecretArn === undefined
      ? {}
      : { runtimeSecretArn: manifest.runtimeSecretArn }),
    limitation:
      manifest.runtimeSecretArn === undefined
        ? "Offline metadata comparison; live task image pull and log delivery remain unqualified."
        : "Offline metadata comparison; live image pull, log delivery and secret injection remain unqualified.",
  };
}

try {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: Object.fromEntries(
      ["account-id", "region", "component", "runtime-secret-arn", "readback-dir"].map((name) => [
        name,
        { type: "string" },
      ]),
    ),
  });
  const [command] = positionals;
  const account = values["account-id"],
    region = values.region,
    component = values.component,
    runtimeSecretArn = values["runtime-secret-arn"];
  if (
    positionals.length !== 1 ||
    !["create-role-input", "put-role-policy-input", "manifest", "verify"].includes(command) ||
    tokens.filter((token) => token.kind === "option").length !== Object.keys(values).length ||
    Object.values(values).some((value) => value !== value.trim() || value === "") ||
    !/^\d{12}$/.test(account ?? "") ||
    !/^(?!cn-)[a-z]{2}-[a-z]+-\d+$/.test(region ?? "") ||
    !["web", "worker"].includes(component) ||
    (command === "verify") !== (values["readback-dir"] !== undefined)
  )
    throw new Error(usage);

  if (
    runtimeSecretArn !== undefined &&
    !new RegExp(
      `^arn:aws:secretsmanager:${region}:${account}:secret:/wallie/staging/${component}/runtime-[A-Za-z0-9]{6}$`,
    ).test(runtimeSecretArn)
  )
    throw new Error(
      "Expected the full own-component runtime secret ARN, including its six-character suffix",
    );

  const result = artifacts(account, region, component, runtimeSecretArn);
  const output =
    command === "create-role-input"
      ? result.createRole
      : command === "put-role-policy-input"
        ? result.putRolePolicy
        : command === "verify"
          ? verify(result.manifest, values["readback-dir"])
          : result.manifest;
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(`[aws-execution-roles] ${error.message}`);
  process.exitCode = 1;
}

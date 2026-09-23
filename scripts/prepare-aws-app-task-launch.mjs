import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { taskDefinition, validateManifest } from "./prepare-aws-app-task-definition.mjs";

const components = ["web", "worker"];
const tagKeys = ["Project", "Environment", "ManagedBy", "Component", "WallieStack", "Name"];
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const equal = (actual, expected, name) =>
  check(isDeepStrictEqual(actual, expected), `Unexpected ${name}`);
const clusterArn = ({ account, region }) =>
  `arn:aws:ecs:${region}:${account}:cluster/wallie-staging`;
const familyArn = ({ account, region }, component) =>
  `arn:aws:ecs:${region}:${account}:task-definition/wallie-staging-${component}-app:*`;
const taskArnPattern = ({ account, region }) =>
  `arn:aws:ecs:${region}:${account}:task/wallie-staging/*`;
const executionRoleArn = ({ account }, component) =>
  `arn:aws:iam::${account}:role/wallie-staging-${component}-execution`;
function definitionTags(manifest, component) {
  return Object.fromEntries(
    taskDefinition(manifest, component).tags.map(({ key, value }) => [key, value]),
  );
}

function policyCondition(manifest, expiresAt) {
  return {
    StringEquals: {
      "aws:PrincipalAccount": manifest.account,
      "aws:RequestedRegion": manifest.region,
    },
    DateLessThan: { "aws:CurrentTime": expiresAt },
  };
}

function requestTags(tags) {
  return Object.fromEntries(
    Object.entries(tags).map(([key, value]) => [`aws:RequestTag/${key}`, value]),
  );
}

function tagCondition(manifest, expiresAt, tags, createAction) {
  return {
    ...policyCondition(manifest, expiresAt),
    StringEquals: {
      ...policyCondition(manifest, expiresAt).StringEquals,
      ...requestTags(tags),
      ...(createAction ? { "ecs:CreateAction": createAction } : {}),
    },
    "ForAllValues:StringEquals": { "aws:TagKeys": Object.keys(tags) },
  };
}

function validateExpiry(value, now) {
  check(
    typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value),
    "Expected UTC expiry with whole seconds",
  );
  const deadline = Date.parse(value);
  check(
    Number.isFinite(deadline) &&
      new Date(deadline).toISOString() === value.replace(/Z$/, ".000Z") &&
      deadline > now + 5 * 60_000 &&
      deadline <= now + 24 * 60 * 60_000,
    "Expiry must be 5 minutes to 24 hours ahead",
  );
  return value;
}

function validateRunId(value) {
  check(typeof value === "string" && /^[a-f0-9]{32}$/.test(value), "Expected a 32-hex run ID");
  return value;
}

function policy(statements) {
  const result = { Version: "2012-10-17", Statement: statements };
  check(JSON.stringify(result).length <= 6144, "Grant exceeds the IAM managed-policy size limit");
  return result;
}

export function registrationPolicy(rawManifest, expiry, now = Date.now()) {
  const manifest = validateManifest(rawManifest);
  const expiresAt = validateExpiry(expiry, now);
  const statements = [];
  for (const component of components) {
    const tags = definitionTags(manifest, component);
    statements.push({
      Sid: `Register${component === "web" ? "Web" : "Worker"}FamilyOnly`,
      Effect: "Allow",
      Action: "ecs:RegisterTaskDefinition",
      Resource: familyArn(manifest, component),
      Condition: {
        ...tagCondition(manifest, expiresAt, tags),
        NumericEquals: { "ecs:task-cpu": 512, "ecs:task-memory": 1024 },
        "ForAllValues:StringEquals": {
          "aws:TagKeys": tagKeys,
          "ecs:compute-compatibility": ["FARGATE"],
        },
        "ForAnyValue:StringEquals": { "ecs:compute-compatibility": "FARGATE" },
        StringEqualsIfExists: { "ecs:privileged": "false" },
      },
    });
    statements.push({
      Sid: `TagNew${component === "web" ? "Web" : "Worker"}Definition`,
      Effect: "Allow",
      Action: "ecs:TagResource",
      Resource: familyArn(manifest, component),
      Condition: tagCondition(manifest, expiresAt, tags, "RegisterTaskDefinition"),
    });
  }
  statements.push({
    Sid: "PassOnlyApplicationExecutionRoles",
    Effect: "Allow",
    Action: "iam:PassRole",
    Resource: components.map((component) => executionRoleArn(manifest, component)),
    Condition: {
      StringEquals: {
        "aws:PrincipalAccount": manifest.account,
        "iam:PassedToService": "ecs-tasks.amazonaws.com",
      },
      DateLessThan: { "aws:CurrentTime": expiresAt },
    },
  });
  statements.push({
    Sid: "ReadDefinitionMetadata",
    Effect: "Allow",
    Action: ["ecs:DescribeTaskDefinition", "ecs:ListTaskDefinitions"],
    Resource: "*",
    Condition: policyCondition(manifest, expiresAt),
  });
  return policy(statements);
}

function tagsObject(tags) {
  check(Array.isArray(tags), "Missing task-definition tags");
  const result = Object.fromEntries(tags.map(({ key, value }) => [key, value]));
  check(Object.keys(result).length === tags.length, "Duplicate task-definition tags");
  return result;
}

export function verifyDefinition(rawManifest, component, response) {
  const manifest = validateManifest(rawManifest);
  check(components.includes(component), "Expected web or worker");
  const expected = taskDefinition(manifest, component);
  const actual = structuredClone(response?.taskDefinition);
  check(actual?.status === "ACTIVE", "Task definition is not ACTIVE");
  check(Number.isSafeInteger(actual.revision) && actual.revision > 0, "Invalid revision");
  const arn = familyArn(manifest, component).replace(/\*$/, String(actual.revision));
  equal(actual.taskDefinitionArn, arn, "task-definition ARN");
  equal(tagsObject(response.tags), definitionTags(manifest, component), "task-definition tags");

  for (const key of [
    "taskDefinitionArn",
    "revision",
    "status",
    "requiresAttributes",
    "compatibilities",
    "registeredAt",
    "registeredBy",
  ])
    delete actual[key];
  for (const key of ["volumes", "placementConstraints"])
    if (isDeepStrictEqual(actual[key], [])) delete actual[key];
  if (isDeepStrictEqual(actual.ephemeralStorage, { sizeInGiB: 20 })) delete actual.ephemeralStorage;
  if (actual.enableFaultInjection === false) delete actual.enableFaultInjection;
  for (const container of actual.containerDefinitions ?? []) {
    for (const key of [
      "environmentFiles",
      "mountPoints",
      "volumesFrom",
      "systemControls",
      "resourceRequirements",
      "ulimits",
      "dependsOn",
    ])
      if (isDeepStrictEqual(container[key], [])) delete container[key];
    if (container.cpu === 0) delete container.cpu;
    if (container.privileged === false) delete container.privileged;
    if (container.versionConsistency === "enabled") delete container.versionConsistency;
    if (isDeepStrictEqual(container.logConfiguration?.secretOptions, []))
      delete container.logConfiguration.secretOptions;
    if (isDeepStrictEqual(container.linuxParameters?.capabilities?.add, []))
      delete container.linuxParameters.capabilities.add;
  }
  const { tags: _tags, ...definition } = expected;
  void _tags;
  equal(actual, definition, "complete task definition");
  return arn;
}

function verifiedArns(manifest, definitions) {
  check(
    definitions && typeof definitions === "object" && !Array.isArray(definitions),
    "Missing readbacks",
  );
  equal(Object.keys(definitions).sort(), components, "readback components");
  return Object.fromEntries(
    components.map((component) => [
      component,
      verifyDefinition(manifest, component, definitions[component]),
    ]),
  );
}

export function runPolicy(rawManifest, definitions, runId, expiry, now = Date.now()) {
  const manifest = validateManifest(rawManifest);
  const arns = verifiedArns(manifest, definitions);
  const run = validateRunId(runId);
  const expiresAt = validateExpiry(expiry, now);
  const statements = [];
  for (const component of components) {
    const tags = { ...definitionTags(manifest, component), WallieRun: run };
    statements.push({
      Sid: `RunReviewed${component === "web" ? "Web" : "Worker"}Revision`,
      Effect: "Allow",
      Action: "ecs:RunTask",
      Resource: arns[component],
      Condition: {
        ...tagCondition(manifest, expiresAt, tags),
        ArnEquals: { "ecs:cluster": clusterArn(manifest) },
        StringEquals: {
          ...tagCondition(manifest, expiresAt, tags).StringEquals,
          "aws:ResourceTag/WallieStack": "wallie-staging-application",
          "ecs:enable-execute-command": "false",
        },
        StringEqualsIfExists: { "ecs:enable-ebs-volumes": "false" },
      },
    });
    statements.push({
      Sid: `TagNew${component === "web" ? "Web" : "Worker"}Task`,
      Effect: "Allow",
      Action: "ecs:TagResource",
      Resource: taskArnPattern(manifest),
      Condition: tagCondition(manifest, expiresAt, tags, "RunTask"),
    });
  }
  statements.push({
    Sid: "PassOnlyApplicationExecutionRoles",
    Effect: "Allow",
    Action: "iam:PassRole",
    Resource: components.map((component) => executionRoleArn(manifest, component)),
    Condition: {
      StringEquals: {
        "aws:PrincipalAccount": manifest.account,
        "iam:PassedToService": "ecs-tasks.amazonaws.com",
      },
      DateLessThan: { "aws:CurrentTime": expiresAt },
    },
  });
  statements.push({
    Sid: "InspectAndStopThisRun",
    Effect: "Allow",
    Action: ["ecs:DescribeTasks", "ecs:StopTask"],
    Resource: taskArnPattern(manifest),
    Condition: {
      ...policyCondition(manifest, expiresAt),
      StringEquals: {
        ...policyCondition(manifest, expiresAt).StringEquals,
        "aws:ResourceTag/WallieStack": "wallie-staging-application",
        "aws:ResourceTag/WallieRun": run,
      },
      ArnEquals: { "ecs:cluster": clusterArn(manifest) },
    },
  });
  statements.push({
    Sid: "ReadThisRunTaskTags",
    Effect: "Allow",
    Action: "ecs:ListTagsForResource",
    Resource: taskArnPattern(manifest),
    Condition: {
      ...policyCondition(manifest, expiresAt),
      StringEquals: {
        ...policyCondition(manifest, expiresAt).StringEquals,
        "aws:ResourceTag/WallieStack": "wallie-staging-application",
        "aws:ResourceTag/WallieRun": run,
      },
    },
  });
  statements.push({
    Sid: "ListOnlyStagingTasks",
    Effect: "Allow",
    Action: "ecs:ListTasks",
    Resource: "*",
    Condition: {
      ...policyCondition(manifest, expiresAt),
      ArnEquals: { "ecs:cluster": clusterArn(manifest) },
    },
  });
  statements.push({
    Sid: "ReadTaskDefinitions",
    Effect: "Allow",
    Action: "ecs:DescribeTaskDefinition",
    Resource: "*",
    Condition: policyCondition(manifest, expiresAt),
  });
  statements.push({
    Sid: "ReadApplicationTaskLogs",
    Effect: "Allow",
    Action: "logs:GetLogEvents",
    Resource: components.map(
      (component) =>
        `arn:aws:logs:${manifest.region}:${manifest.account}:log-group:/wallie/staging/${component}:log-stream:app/${component}/*`,
    ),
    Condition: policyCondition(manifest, expiresAt),
  });
  return policy(statements);
}

function validateNetwork(output) {
  const value = output?.runtime_https_egress?.value;
  check(value && typeof value === "object", "Enable staging runtime HTTPS egress first");
  const subnet = value.services_subnet_id;
  const groups = value.task_security_group_ids;
  check(/^subnet-[a-f0-9]{8,17}$/.test(subnet), "Invalid services-a subnet ID");
  check(
    Array.isArray(groups) &&
      groups.length === 2 &&
      groups.every((id) => /^sg-[a-f0-9]{8,17}$/.test(id)) &&
      new Set(groups).size === 2,
    "Expected both distinct reviewed task security groups",
  );
  equal(output.subnets?.value?.["services-a"]?.id, subnet, "services-a subnet output");
  equal(output.application_connectivity?.value?.task_security_group_id, groups[0], "base task SG");
  return { subnet, groups };
}

export function runInput(rawManifest, definitions, network, component, runId) {
  const manifest = validateManifest(rawManifest);
  const arns = verifiedArns(manifest, definitions);
  check(components.includes(component), "Expected web or worker");
  const run = validateRunId(runId);
  const { subnet, groups } = validateNetwork(network);
  return {
    cluster: clusterArn(manifest),
    taskDefinition: arns[component],
    launchType: "FARGATE",
    platformVersion: "1.4.0",
    count: 1,
    clientToken: `${run}-${component}`,
    startedBy: `wa-${run}`,
    group: "wallie-staging-app",
    enableExecuteCommand: false,
    enableECSManagedTags: false,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: [subnet],
        securityGroups: groups,
        assignPublicIp: "DISABLED",
      },
    },
    tags: Object.entries({ ...definitionTags(manifest, component), WallieRun: run }).map(
      ([key, value]) => ({ key, value }),
    ),
  };
}

function readJson(path) {
  const info = lstatSync(path);
  check(info.isFile() && info.size <= 1024 * 1024, "Expected a regular JSON file at most 1 MiB");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Invalid JSON input");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals, tokens } = parseArgs({
      allowPositionals: true,
      tokens: true,
      options: Object.fromEntries(
        ["manifest", "definitions", "network", "component", "run-id", "expires-at"].map((key) => [
          key,
          { type: "string" },
        ]),
      ),
    });
    const [mode] = positionals;
    const modes = {
      "register-policy": ["manifest", "expires-at"],
      "run-policy": ["manifest", "definitions", "run-id", "expires-at"],
      run: ["manifest", "definitions", "network", "component", "run-id"],
    };
    check(positionals.length === 1 && Object.hasOwn(modes, mode), "Invalid launch mode");
    equal(Object.keys(values).sort(), [...modes[mode]].sort(), "command arguments");
    check(
      tokens.filter((token) => token.kind === "option").length === modes[mode].length &&
        Object.values(values).every((value) => value.length > 0 && value === value.trim()),
      "Invalid or ambiguous launch command",
    );
    const manifest = readJson(values.manifest);
    const definitions = values.definitions ? readJson(values.definitions) : undefined;
    let result;
    if (mode === "register-policy") result = registrationPolicy(manifest, values["expires-at"]);
    else if (mode === "run-policy")
      result = runPolicy(manifest, definitions, values["run-id"], values["expires-at"]);
    else
      result = runInput(
        manifest,
        definitions,
        readJson(values.network),
        values.component,
        values["run-id"],
      );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      `[aws-app-task-launch] ${error instanceof Error ? error.message : "Invalid input"}`,
    );
    process.exitCode = 1;
  }
}

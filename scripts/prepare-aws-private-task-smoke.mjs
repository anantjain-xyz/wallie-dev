import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

const components = ["web", "worker"];
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const equal = (actual, expected, field) =>
  check(isDeepStrictEqual(actual, expected), `Unexpected ${field}`);
const exactKeys = (value, keys, field) => {
  check(value && typeof value === "object" && !Array.isArray(value), `Invalid ${field}`);
  equal(Object.keys(value).sort(), [...keys].sort(), `${field} fields`);
};
const matches = (value, pattern) =>
  typeof value === "string" && value === value.trim() && pattern.test(value);
const time = (value) => {
  check(matches(value, /^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/), "Invalid evidence time");
  const result = Date.parse(value);
  check(Number.isFinite(result), "Invalid evidence time");
  return result;
};
const smokeDeadline = (evidence) => time(evidence.run?.requestStartedAt) + 10 * 60_000;
const tagsObject = (tags) => {
  check(Array.isArray(tags), "Missing resource tags");
  const result = Object.fromEntries(tags.map(({ key, value }) => [key, value]));
  equal(Object.keys(result).length, tags.length, "duplicate tags");
  return result;
};
const family = (component) => `wallie-staging-${component}-connectivity-smoke`;
const roleArn = (plan, component) =>
  `arn:aws:iam::${plan.account}:role/wallie-staging-${component}-execution`;
const reference = (plan, component) =>
  `${plan.account}.dkr.ecr.${plan.region}.amazonaws.com/wallie-staging/${component}@${plan.images[component].digest}`;
const clusterArn = (plan) => `arn:aws:ecs:${plan.region}:${plan.account}:cluster/wallie-staging`;
const tagValues = (plan) => ({
  Project: "Wallie",
  Environment: "staging",
  ManagedBy: "ManualQualification",
  Component: "private-task-smoke",
  WallieStack: "wallie-staging-application",
  Name: "wallie-staging-connectivity-smoke",
  WallieSmokeRun: plan.runId,
});
const tags = (plan) => Object.entries(tagValues(plan)).map(([key, value]) => ({ key, value }));
const marker = (plan, component, phase) =>
  JSON.stringify({ kind: "wallie-private-smoke", run: plan.runId, component, phase });

function verifyPrivateNetwork(plan) {
  const network = plan.network;
  const vpcs = network.vpcs?.Vpcs;
  check(
    vpcs?.length === 1 &&
      vpcs[0].VpcId === plan.vpcId &&
      vpcs[0].OwnerId === plan.account &&
      vpcs[0].State === "available",
    "Unexpected VPC readback",
  );
  const subnets = network.subnets?.Subnets;
  check(
    subnets?.length === 2 && new Set(subnets.map((subnet) => subnet.AvailabilityZone)).size === 2,
    "Two service availability zones are required",
  );
  equal(
    subnets.map((subnet) => subnet.SubnetId).sort(),
    [...plan.subnetIds].sort(),
    "service subnet set",
  );
  for (const subnet of subnets)
    check(
      subnet.VpcId === plan.vpcId &&
        subnet.OwnerId === plan.account &&
        subnet.State === "available" &&
        subnet.MapPublicIpOnLaunch === false &&
        subnet.AssignIpv6AddressOnCreation === false &&
        (subnet.Ipv6CidrBlockAssociationSet ?? []).length === 0,
      "Service subnet is not private IPv4",
    );
  const endpoints = network.endpoints?.VpcEndpoints;
  check(endpoints?.length === 4, "Exactly four reviewed AWS endpoints are required");
  const endpoint = (service, type) => {
    const found = endpoints.filter(
      (item) => item.ServiceName === `com.amazonaws.${plan.region}.${service}`,
    );
    check(
      found.length === 1 &&
        found[0].VpcId === plan.vpcId &&
        found[0].OwnerId === plan.account &&
        found[0].State === "available" &&
        found[0].VpcEndpointType === type &&
        found[0].IpAddressType === "ipv4",
      "Endpoint identity or availability differs",
    );
    return found[0];
  };
  const s3 = endpoint("s3", "Gateway");
  const prefixes = network.prefixList?.PrefixLists;
  check(
    prefixes?.length === 1 &&
      prefixes[0].OwnerId === "AWS" &&
      prefixes[0].PrefixListName === `com.amazonaws.${plan.region}.s3` &&
      prefixes[0].AddressFamily === "IPv4" &&
      matches(prefixes[0].PrefixListId, /^pl-(?:[a-f0-9]{8}|[a-f0-9]{17})$/),
    "Expected AWS-managed regional S3 prefix list",
  );
  const prefixId = prefixes[0].PrefixListId;
  const routeTables = network.routeTables?.RouteTables;
  check(routeTables?.length === 2, "Two exact private route-table snapshots are required");
  equal(
    [...s3.RouteTableIds].sort(),
    routeTables.map((table) => table.RouteTableId).sort(),
    "S3 route-table associations",
  );
  const seenSubnets = [];
  for (const table of routeTables) {
    check(
      table.VpcId === plan.vpcId &&
        table.OwnerId === plan.account &&
        table.Associations?.length === 1 &&
        table.Associations[0].Main === false &&
        table.Associations[0].AssociationState?.State === "associated",
      "Unexpected private route-table association",
    );
    seenSubnets.push(table.Associations[0].SubnetId);
    check(
      table.Routes?.length === 2,
      "Private service routes must contain only local and S3 routes",
    );
    const local = table.Routes.filter((route) => route.GatewayId === "local");
    const layer = table.Routes.filter((route) => route.GatewayId === s3.VpcEndpointId);
    check(
      local.length === 1 &&
        local[0].State === "active" &&
        local[0].DestinationCidrBlock === vpcs[0].CidrBlock &&
        layer.length === 1 &&
        layer[0].State === "active" &&
        layer[0].DestinationPrefixListId === prefixId,
      "Unexpected private service routes",
    );
  }
  equal(seenSubnets.sort(), [...plan.subnetIds].sort(), "private subnet routing");
  equal(
    JSON.parse(s3.PolicyDocument),
    {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "ReadRegionalEcrImageLayers",
          Effect: "Allow",
          Principal: "*",
          Action: "s3:GetObject",
          Resource: `arn:aws:s3:::prod-${plan.region}-starport-layer-bucket/*`,
        },
      ],
    },
    "S3 endpoint policy",
  );
  const accountCondition = {
    StringEquals: { "aws:PrincipalAccount": plan.account, "aws:RequestedRegion": plan.region },
  };
  const repositories = components.map(
    (component) =>
      `arn:aws:ecr:${plan.region}:${plan.account}:repository/wallie-staging/${component}`,
  );
  const groups = network.securityGroups?.SecurityGroups;
  check(groups?.length === 2, "Exactly two connectivity security groups are required");
  const taskGroup = groups.find((group) => group.GroupId === plan.taskSecurityGroupId);
  const endpointGroup = groups.find((group) => group.GroupId !== plan.taskSecurityGroupId);
  check(
    taskGroup &&
      endpointGroup &&
      groups.every((group) => group.VpcId === plan.vpcId && group.OwnerId === plan.account),
    "Unexpected connectivity security groups",
  );
  const rules = (permissions) =>
    permissions
      .flatMap((permission) => {
        check(
          permission.IpProtocol === "tcp" &&
            permission.FromPort === 443 &&
            permission.ToPort === 443 &&
            permission.IpRanges?.length === 0 &&
            permission.Ipv6Ranges?.length === 0,
          "Only private TCP443 rules are allowed",
        );
        const targets = [
          ...(permission.UserIdGroupPairs ?? []).map((pair) => {
            check(
              pair.UserId === plan.account && (!pair.VpcId || pair.VpcId === plan.vpcId),
              "Unexpected SG-rule account or VPC",
            );
            return pair.GroupId;
          }),
          ...(permission.PrefixListIds ?? []).map((prefix) => prefix.PrefixListId),
        ];
        check(targets.length > 0, "Missing SG-rule destinations");
        return targets;
      })
      .sort();
  equal(taskGroup.IpPermissions, [], "task inbound access");
  equal(endpointGroup.IpPermissionsEgress, [], "endpoint outbound access");
  equal(
    rules(taskGroup.IpPermissionsEgress),
    [endpointGroup.GroupId, prefixId].sort(),
    "task egress rules",
  );
  equal(rules(endpointGroup.IpPermissions), [plan.taskSecurityGroupId], "endpoint ingress rules");
  for (const service of ["ecr.api", "ecr.dkr", "logs"]) {
    const item = endpoint(service, "Interface");
    check(item.PrivateDnsEnabled === true, "Endpoint private DNS must be enabled");
    equal([...item.SubnetIds].sort(), [...plan.subnetIds].sort(), "interface endpoint subnets");
    equal(
      item.Groups.map((group) => group.GroupId),
      [endpointGroup.GroupId],
      "interface endpoint groups",
    );
    const statements =
      service === "logs"
        ? [
            {
              Sid: "WriteApplicationLogs",
              Effect: "Allow",
              Principal: "*",
              Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
              Resource: components.map(
                (component) =>
                  `arn:aws:logs:${plan.region}:${plan.account}:log-group:/wallie/staging/${component}:log-stream:*`,
              ),
              Condition: accountCondition,
            },
          ]
        : [
            {
              Sid: "AuthenticateExpectedAccount",
              Effect: "Allow",
              Principal: "*",
              Action: "ecr:GetAuthorizationToken",
              Resource: "*",
              Condition: accountCondition,
            },
            {
              Sid: "PullApplicationImages",
              Effect: "Allow",
              Principal: "*",
              Action: [
                "ecr:BatchCheckLayerAvailability",
                "ecr:BatchGetImage",
                "ecr:GetDownloadUrlForLayer",
              ],
              Resource: repositories,
              Condition: accountCondition,
            },
          ];
    equal(
      JSON.parse(item.PolicyDocument),
      { Version: "2012-10-17", Statement: statements },
      "interface endpoint policy",
    );
  }
  for (const response of [
    network.vpcs,
    network.subnets,
    network.endpoints,
    network.routeTables,
    network.securityGroups,
    network.prefixList,
  ])
    check(!response.NextToken, "Incomplete network pagination");
}

// This validates captured evidence, not its provenance. Live collection and
// administrator review remain required; publisher receipts alone are insufficient.
export function validateManifest(input, now = Date.now(), retrospective = false) {
  exactKeys(
    input,
    [
      "schemaVersion",
      "account",
      "region",
      "runId",
      "createdAt",
      "identity",
      "vpcId",
      "subnetIds",
      "taskSecurityGroupId",
      "profileVersion",
      "images",
      "network",
    ],
    "manifest",
  );
  check(
    input.schemaVersion === 1 && matches(input.account, /^\d{12}$/),
    "Invalid account or manifest version",
  );
  check(
    matches(input.region, /^(?!cn-)[a-z]{2}-[a-z]+-\d+$/),
    "A commercial AWS region is required",
  );
  check(
    matches(input.runId, /^[a-f0-9]{32}$/) && matches(input.profileVersion, /^[a-zA-Z0-9]{10}$/),
    "Invalid run or signing-profile version",
  );
  for (const [value, prefix] of [
    [input.vpcId, "vpc"],
    [input.taskSecurityGroupId, "sg"],
  ])
    check(
      matches(value, new RegExp(`^${prefix}-(?:[a-f0-9]{8}|[a-f0-9]{17})$`)),
      "Invalid network identity",
    );
  check(
    Array.isArray(input.subnetIds) &&
      input.subnetIds.length === 2 &&
      new Set(input.subnetIds).size === 2 &&
      input.subnetIds.every((id) => matches(id, /^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/)),
    "Two distinct reviewed service subnets are required",
  );
  check(
    input.identity?.Account === input.account &&
      matches(
        input.identity.Arn,
        new RegExp(`^arn:aws:(?:iam|sts)::${input.account}:(?:user/|assumed-role/).+$`),
      ),
    "Expected non-root caller evidence is required",
  );
  const created = time(input.createdAt);
  check(
    created <= now && (retrospective || now - created <= 15 * 60_000),
    "Recollect qualification evidence: manifest is not fresh",
  );
  const fresh = (value) => {
    const captured = time(value);
    check(
      captured <= created &&
        created - captured <= 15 * 60_000 &&
        (retrospective || now - captured <= 15 * 60_000),
      "Recollect fresh qualification evidence",
    );
  };
  fresh(input.network?.capturedAt);
  verifyPrivateNetwork(input);
  exactKeys(input.images, components, "images");
  for (const component of components) {
    const image = input.images[component];
    exactKeys(
      image,
      ["digest", "sourceRevision", "publishId", "scan", "verification"],
      "qualified image",
    );
    check(
      matches(image.digest, /^sha256:[a-f0-9]{64}$/) &&
        matches(image.sourceRevision, /^[a-f0-9]{40}$/) &&
        matches(image.publishId, /^[a-f0-9]{32}$/),
      "Invalid immutable image identity",
    );
    fresh(image.scan?.capturedAt);
    const scan = image.scan.response;
    check(
      scan?.registryId === input.account &&
        scan.repositoryName === `wallie-staging/${component}` &&
        scan.imageId?.imageDigest === image.digest &&
        scan.imageScanStatus?.status === "COMPLETE",
      "Scan does not confirm the exact image",
    );
    const completed = time(scan.imageScanFindings?.imageScanCompletedAt);
    check(
      completed <= time(image.scan.capturedAt) &&
        (retrospective ? created : now) - completed <= 24 * 60 * 60_000,
      "A completed scan from the last 24 hours is required",
    );
    const counts = scan.imageScanFindings.findingSeverityCounts;
    check(
      counts &&
        typeof counts === "object" &&
        !Array.isArray(counts) &&
        Object.keys(counts).every((key) =>
          ["INFORMATIONAL", "LOW", "MEDIUM", "HIGH", "CRITICAL", "UNDEFINED"].includes(key),
        ) &&
        Object.values(counts).every((count) => Number.isInteger(count) && count >= 0) &&
        (counts.HIGH ?? 0) === 0 &&
        (counts.CRITICAL ?? 0) === 0,
      "Image scan has High/Critical findings or invalid counts",
    );
    fresh(image.verification?.capturedAt);
    equal(image.verification.exitCode, 0, "strict verification exit code");
    equal(
      image.verification.args,
      [
        "verify",
        reference(input, component),
        "--plugin-config",
        `aws-region=${input.region}`,
        "--max-signatures",
        "100",
        "--user-metadata",
        `wallie.dev/publish-id=${image.publishId}`,
      ],
      "strict verification arguments",
    );
    check(
      typeof image.verification.stdout === "string" &&
        image.verification.stdout.trim().split(/\r?\n/)[0] ===
          `Successfully verified signature for ${reference(input, component)}`,
      "Strict verification did not confirm the exact digest",
    );
    equal(
      image.verification.trustPolicy,
      {
        version: "1.0",
        trustPolicies: [
          {
            name: "wallie-staging-images",
            registryScopes: components.map(
              (name) =>
                `${input.account}.dkr.ecr.${input.region}.amazonaws.com/wallie-staging/${name}`,
            ),
            signatureVerification: { level: "strict" },
            trustStores: ["signingAuthority:aws-signer-ts"],
            trustedIdentities: [
              `arn:aws:signer:${input.region}:${input.account}:/signing-profiles/wallie_staging_images/${input.profileVersion}`,
            ],
          },
        ],
      },
      "strict signature trust policy",
    );
  }
  return structuredClone(input);
}

// Captures stay separate until all reads/verification have succeeded. Assembly
// uses the earliest network capture so a sequence of reads cannot extend its TTL.
export function assembleManifest(input, readback, now = Date.now()) {
  exactKeys(
    input,
    [
      "schemaVersion",
      "account",
      "region",
      "runId",
      "vpcId",
      "subnetIds",
      "taskSecurityGroupId",
      "profileVersion",
      "images",
    ],
    "reviewed inputs",
  );
  exactKeys(input.images, components, "image identities");
  const freshCapture = (capture) => {
    const started = time(capture?.requestStartedAt);
    const captured = time(capture?.capturedAt);
    check(
      started <= captured && captured <= now && now - started <= 15 * 60_000,
      "Recollect fresh qualification evidence",
    );
    return started;
  };
  freshCapture(readback.identity);
  const network = Object.fromEntries(
    ["vpcs", "subnets", "routeTables", "endpoints", "securityGroups", "prefixList"].map((name) => {
      freshCapture(readback[name]);
      return [name, readback[name].response];
    }),
  );
  network.capturedAt = new Date(
    Math.min(
      ...["vpcs", "subnets", "routeTables", "endpoints", "securityGroups", "prefixList"].map(
        (name) => time(readback[name].requestStartedAt),
      ),
    ),
  ).toISOString();
  const images = Object.fromEntries(
    components.map((component) => {
      exactKeys(
        input.images[component],
        ["digest", "sourceRevision", "publishId"],
        "image identity",
      );
      const scanStarted = freshCapture(readback[`${component}-scan`]);
      return [
        component,
        {
          ...input.images[component],
          scan: {
            capturedAt: new Date(scanStarted).toISOString(),
            response: readback[`${component}-scan`].response,
          },
          verification: readback[`${component}-verification`],
        },
      ];
    }),
  );
  return validateManifest(
    {
      ...input,
      createdAt: new Date(now).toISOString(),
      identity: readback.identity.response,
      network,
      images,
    },
    now,
  );
}

export function taskDefinition(plan, component) {
  check(components.includes(component), "Invalid component");
  const program = `if(process.platform!=="linux"||process.arch!=="x64"||["AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN","AWS_CONTAINER_CREDENTIALS_RELATIVE_URI","AWS_CONTAINER_CREDENTIALS_FULL_URI","SUPABASE_SECRET_KEY","WALLIE_ENCRYPTION_KEY"].some(k=>process.env[k]))process.exit(70);console.log(${JSON.stringify(marker(plan, component, "started"))});setTimeout(()=>{console.log(${JSON.stringify(marker(plan, component, "completed"))});},60000);`;
  return {
    family: family(component),
    executionRoleArn: roleArn(plan, component),
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "256",
    memory: "512",
    runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
    containerDefinitions: [
      {
        name: "smoke",
        image: reference(plan, component),
        entryPoint: ["node"],
        command: ["-e", program],
        user: "1000:1000",
        essential: true,
        readonlyRootFilesystem: true,
        stopTimeout: 30,
        linuxParameters: { capabilities: { drop: ["ALL"] } },
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": `/wallie/staging/${component}`,
            "awslogs-region": plan.region,
            "awslogs-stream-prefix": `wallie-smoke-${plan.runId}`,
            mode: "blocking",
          },
        },
      },
    ],
    tags: tags(plan),
  };
}

export function verifyDefinition(plan, component, response) {
  const expected = taskDefinition(plan, component);
  const actual = structuredClone(response?.taskDefinition);
  check(actual && actual.status === "ACTIVE", "Task definition is not ACTIVE");
  check(
    Number.isSafeInteger(actual.revision) && actual.revision > 0,
    "Invalid task-definition revision",
  );
  const arn = `arn:aws:ecs:${plan.region}:${plan.account}:task-definition/${family(component)}:${actual.revision}`;
  equal(actual.taskDefinitionArn, arn, "task-definition ARN");
  equal(tagsObject(response.tags), tagValues(plan), "task-definition tags");
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
  // AWS adds these harmless defaults to otherwise identical definitions.
  for (const key of ["volumes", "placementConstraints"])
    if (isDeepStrictEqual(actual[key], [])) delete actual[key];
  if (isDeepStrictEqual(actual.ephemeralStorage, { sizeInGiB: 20 })) delete actual.ephemeralStorage;
  if (actual.enableFaultInjection === false) delete actual.enableFaultInjection;
  for (const container of actual.containerDefinitions ?? []) {
    for (const key of [
      "environment",
      "environmentFiles",
      "secrets",
      "mountPoints",
      "volumesFrom",
      "portMappings",
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

export function runInput(plan, component, subnetIndex, definitions) {
  check(subnetIndex === 0 || subnetIndex === 1, "Invalid subnet index");
  return {
    cluster: clusterArn(plan),
    taskDefinition: verifyDefinition(plan, component, definitions[component]),
    launchType: "FARGATE",
    platformVersion: "1.4.0",
    count: 1,
    clientToken: `${plan.runId}-${component}-${subnetIndex}`,
    startedBy: `ws-${plan.runId}`,
    group: "wallie-private-smoke",
    enableExecuteCommand: false,
    enableECSManagedTags: false,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: [plan.subnetIds[subnetIndex]],
        securityGroups: [plan.taskSecurityGroupId],
        assignPublicIp: "DISABLED",
      },
    },
    tags: tags(plan),
  };
}

export function smokePolicy(plan, definitions) {
  const replacements = {
    ACCOUNT_ID: plan.account,
    REGION: plan.region,
    RUN_ID: plan.runId,
    WEB_DEFINITION_ARN: verifyDefinition(plan, "web", definitions.web),
    WORKER_DEFINITION_ARN: verifyDefinition(plan, "worker", definitions.worker),
  };
  let source = readFileSync(
    new URL("../infra/aws/private-task-smoke-policy.template.json", import.meta.url),
    "utf8",
  );
  for (const [key, value] of Object.entries(replacements))
    source = source.replaceAll(`<${key}>`, value);
  const result = JSON.parse(source);
  check(
    JSON.stringify(result).length <= 6144,
    "Smoke policy exceeds IAM's managed-policy size limit",
  );
  return result;
}

function oneTask(envelope, plan, request, now, deadline) {
  check(
    time(envelope?.requestStartedAt) >= time(plan.createdAt) &&
      time(envelope.capturedAt) >= time(envelope.requestStartedAt) &&
      time(envelope.capturedAt) <= now,
    "Invalid task evidence capture time",
  );
  check(time(envelope.capturedAt) <= deadline, "Task evidence exceeds smoke deadline");
  const response = envelope.response;
  equal(response?.failures, [], "ECS task failures");
  check(
    Array.isArray(response.tasks) && response.tasks.length === 1,
    "Exactly one task must be returned",
  );
  const task = response.tasks[0];
  check(
    matches(
      task.taskArn,
      new RegExp(`^arn:aws:ecs:${plan.region}:${plan.account}:task/wallie-staging/[a-f0-9]{32}$`),
    ),
    "Unexpected task ARN",
  );
  for (const [key, value] of Object.entries({
    clusterArn: request.cluster,
    taskDefinitionArn: request.taskDefinition,
    launchType: "FARGATE",
    platformVersion: "1.4.0",
    cpu: "256",
    memory: "512",
    enableExecuteCommand: false,
    startedBy: request.startedBy,
    group: request.group,
  }))
    equal(task[key], value, `task ${key}`);
  equal(tagsObject(task.tags), tagValues(plan), "task tags");
  const overrides = structuredClone(task.overrides ?? {});
  if (
    isDeepStrictEqual(overrides.containerOverrides, [{ name: "smoke" }]) ||
    isDeepStrictEqual(overrides.containerOverrides, [])
  )
    delete overrides.containerOverrides;
  if (isDeepStrictEqual(overrides.inferenceAcceleratorOverrides, []))
    delete overrides.inferenceAcceleratorOverrides;
  equal(overrides, {}, "task overrides");
  check(
    Array.isArray(task.containers) &&
      task.containers.length === 1 &&
      task.containers[0].name === "smoke",
    "Unexpected task containers",
  );
  check(
    time(task.createdAt) >= time(plan.createdAt) &&
      time(task.createdAt) <= time(envelope.capturedAt),
    "Task was not created for this qualification",
  );
  const captures = [
    plan.network.capturedAt,
    ...components.flatMap((component) => [
      plan.images[component].scan.capturedAt,
      plan.images[component].verification.capturedAt,
    ]),
  ];
  check(
    captures.every(
      (captured) =>
        time(task.createdAt) >= time(captured) &&
        time(task.createdAt) - time(captured) <= 15 * 60_000,
    ) &&
      components.every((component) => {
        const scanAge =
          time(task.createdAt) -
          time(plan.images[component].scan.response.imageScanFindings.imageScanCompletedAt);
        return scanAge >= 0 && scanAge <= 24 * 60 * 60_000;
      }),
    "Task launch occurred outside its image or network qualification window",
  );
  return task;
}

export function verifyNetwork(
  plan,
  component,
  subnetIndex,
  definitions,
  evidence,
  now = Date.now(),
) {
  const request = runInput(plan, component, subnetIndex, definitions);
  const deadline = smokeDeadline(evidence);
  const launch = oneTask(evidence.run, plan, request, now, deadline);
  check(
    time(launch.createdAt) >= time(evidence.run.requestStartedAt),
    "Task predates this RunTask request",
  );
  const task = oneTask(evidence.running, plan, request, now, deadline);
  check(
    time(evidence.running.requestStartedAt) >= time(evidence.run.capturedAt),
    "RUNNING capture must follow the RunTask response",
  );
  equal(task.taskArn, launch.taskArn, "launched task identity");
  equal(task.createdAt, launch.createdAt, "task creation time");
  equal(task.lastStatus, "RUNNING", "network capture task state");
  equal(task.desiredStatus, "RUNNING", "network capture desired state");
  const container = task.containers[0];
  equal(container.lastStatus, "RUNNING", "running container state");
  equal(container.image, reference(plan, component), "running image reference");
  equal(container.imageDigest, plan.images[component].digest, "running image digest");
  const attachments = task.attachments?.filter((item) => item.type === "ElasticNetworkInterface");
  check(
    attachments?.length === 1 && attachments[0].status === "ATTACHED",
    "One attached task ENI is required",
  );
  const details = Object.fromEntries(
    attachments[0].details.map(({ name, value }) => [name, value]),
  );
  equal(details.subnetId, plan.subnetIds[subnetIndex], "task subnet");
  check(
    matches(details.networkInterfaceId, /^eni-(?:[a-f0-9]{8}|[a-f0-9]{17})$/),
    "Invalid task ENI",
  );
  check(
    Array.isArray(container.networkInterfaces) &&
      container.networkInterfaces.length === 1 &&
      container.networkInterfaces[0].attachmentId === attachments[0].id &&
      container.networkInterfaces[0].privateIpv4Address === details.privateIPv4Address,
    "Container and task network identity differ",
  );
  const snapshot = evidence.eni;
  check(
    time(snapshot?.requestStartedAt) >= time(evidence.running.capturedAt) &&
      time(snapshot.capturedAt) >= time(snapshot.requestStartedAt) &&
      time(snapshot.capturedAt) <= now,
    "Invalid ENI capture time",
  );
  check(time(snapshot.capturedAt) <= deadline, "ENI evidence exceeds smoke deadline");
  const enis = snapshot.response?.NetworkInterfaces;
  check(
    Array.isArray(enis) && enis.length === 1 && !snapshot.response.NextToken,
    "Exactly one complete ENI response is required",
  );
  const eni = enis[0];
  for (const [key, value] of Object.entries({
    NetworkInterfaceId: details.networkInterfaceId,
    VpcId: plan.vpcId,
    SubnetId: plan.subnetIds[subnetIndex],
    OwnerId: plan.account,
    Status: "in-use",
    PrivateIpAddress: details.privateIPv4Address,
  }))
    equal(eni[key], value, `ENI ${key}`);
  equal(
    eni.Groups?.map((group) => group.GroupId),
    [plan.taskSecurityGroupId],
    "ENI security groups",
  );
  check(
    !eni.Association &&
      (!eni.Ipv6Addresses || eni.Ipv6Addresses.length === 0) &&
      eni.PrivateIpAddresses?.length === 1 &&
      eni.PrivateIpAddresses[0].PrivateIpAddress === details.privateIPv4Address &&
      eni.PrivateIpAddresses[0].Primary === true &&
      !eni.PrivateIpAddresses[0].Association &&
      eni.Attachment?.Status === "attached",
    "Task ENI must have only its private IPv4 address",
  );
  return {
    taskArn: task.taskArn,
    eniId: eni.NetworkInterfaceId,
    privateIp: eni.PrivateIpAddress,
    subnetId: eni.SubnetId,
  };
}

export function verifyResult(
  plan,
  component,
  subnetIndex,
  definitions,
  evidence,
  now = Date.now(),
) {
  const network = verifyNetwork(plan, component, subnetIndex, definitions, evidence, now);
  const request = runInput(plan, component, subnetIndex, definitions);
  const deadline = smokeDeadline(evidence);
  const task = oneTask(evidence.stopped, plan, request, now, deadline);
  check(
    time(evidence.stopped.requestStartedAt) >= time(evidence.eni.capturedAt),
    "STOPPED capture must follow the ENI response",
  );
  equal(task.taskArn, network.taskArn, "stopped task identity");
  equal(task.createdAt, evidence.running.response.tasks[0].createdAt, "stopped task creation time");
  equal(task.lastStatus, "STOPPED", "final task state");
  equal(task.desiredStatus, "STOPPED", "final desired state");
  equal(task.stopCode, "EssentialContainerExited", "task stop reason code");
  const container = task.containers[0];
  equal(container.lastStatus, "STOPPED", "final container state");
  equal(container.exitCode, 0, "smoke exit code");
  equal(container.image, reference(plan, component), "final image reference");
  equal(container.imageDigest, plan.images[component].digest, "final image digest");
  const stopped = time(task.stoppedAt);
  check(
    time(task.startedAt) <= time(evidence.running.capturedAt) &&
      time(evidence.eni.capturedAt) < stopped &&
      stopped <= time(evidence.stopped.capturedAt) &&
      stopped <= deadline,
    "Missing live ENI capture or exceeded smoke deadline",
  );
  const stream = `wallie-smoke-${plan.runId}/smoke/${task.taskArn.split("/").at(-1)}`;
  const pages = evidence.logs;
  check(
    Array.isArray(pages) && pages.length >= 2 && pages.length <= 20,
    "Bounded complete log pagination is required",
  );
  const events = [];
  let token;
  let previousCapture = time(evidence.stopped.capturedAt);
  for (const [index, page] of pages.entries()) {
    equal(
      page.request,
      {
        logGroupName: `/wallie/staging/${component}`,
        logStreamName: stream,
        startFromHead: true,
        ...(token === undefined ? {} : { nextToken: token }),
      },
      "log request",
    );
    check(
      time(page.requestStartedAt) >= previousCapture &&
        time(page.capturedAt) >= time(page.requestStartedAt) &&
        time(page.capturedAt) <= now,
      "Log pages must be captured in order after the STOPPED response",
    );
    check(time(page.capturedAt) <= deadline, "Log evidence exceeds smoke deadline");
    previousCapture = time(page.capturedAt);
    check(
      Array.isArray(page.response?.events) &&
        page.response.events.length <= 100 &&
        typeof page.response.nextForwardToken === "string" &&
        page.response.nextForwardToken.length > 0,
      "Invalid log response",
    );
    check(
      index === pages.length - 1
        ? token === page.response.nextForwardToken
        : token !== page.response.nextForwardToken,
      "Log pagination has not reached a stable forward token",
    );
    token = page.response.nextForwardToken;
    events.push(...page.response.events);
  }
  equal(
    events.map((event) => event.message),
    [marker(plan, component, "started"), marker(plan, component, "completed")],
    "exact smoke log markers",
  );
  check(
    events.every(
      (event) =>
        Number.isFinite(event.timestamp) &&
        event.timestamp >= time(task.startedAt) &&
        event.timestamp <= stopped,
    ) &&
      events[1].timestamp - events[0].timestamp >= 59_000 &&
      events[1].timestamp - events[0].timestamp <= 90_000,
    "Unexpected smoke log times",
  );
  return {
    schemaVersion: 1,
    status: "offline-smoke-evidence-matches",
    runId: plan.runId,
    component,
    ...network,
    image: reference(plan, component),
    logStream: stream,
    exitCode: 0,
    deployable: false,
    limitation:
      "Offline comparison cannot authenticate evidence or prove capture freshness. Four reviewed live results are required; Wallie startup, secrets and services remain unqualified.",
  };
}

function readJson(path) {
  check(typeof path === "string", "A private JSON input file is required");
  try {
    const stat = lstatSync(path);
    check(stat.isFile() && stat.size <= 2 * 1024 * 1024, "Invalid input file");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Missing, oversized, symlinked, or invalid JSON input");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals, tokens } = parseArgs({
      allowPositionals: true,
      tokens: true,
      options: Object.fromEntries(
        ["manifest", "component", "subnet-index", "definitions", "readback-dir"].map((key) => [
          key,
          { type: "string" },
        ]),
      ),
    });
    const [mode] = positionals;
    const modes = {
      assemble: ["manifest", "readback-dir"],
      definition: ["manifest", "component"],
      policy: ["manifest", "definitions"],
      run: ["manifest", "component", "subnet-index", "definitions"],
      "verify-network": ["manifest", "component", "subnet-index", "definitions", "readback-dir"],
      verify: ["manifest", "component", "subnet-index", "definitions", "readback-dir"],
    };
    check(
      positionals.length === 1 &&
        Object.hasOwn(modes, mode) &&
        tokens.filter((token) => token.kind === "option").length === Object.keys(values).length &&
        Object.values(values).every((value) => value.length > 0 && value === value.trim()),
      "Invalid or ambiguous smoke command",
    );
    equal(Object.keys(values).sort(), [...modes[mode]].sort(), "command arguments");
    if (values.component) check(components.includes(values.component), "Invalid component");
    if (values["subnet-index"] !== undefined)
      check(/^[01]$/.test(values["subnet-index"]), "Invalid subnet index");
    const input = readJson(values.manifest);
    if (mode === "assemble") {
      const names = [
        "identity",
        "vpcs",
        "subnets",
        "routeTables",
        "endpoints",
        "securityGroups",
        "prefixList",
        "web-scan",
        "worker-scan",
        "web-verification",
        "worker-verification",
      ];
      const readback = Object.fromEntries(
        names.map((name) => [name, readJson(join(values["readback-dir"], `${name}.json`))]),
      );
      console.log(JSON.stringify(assembleManifest(input, readback), null, 2));
      process.exit(0);
    }
    const plan = validateManifest(
      input,
      Date.now(),
      mode === "verify" || mode === "verify-network",
    );
    const definitions = values.definitions ? readJson(values.definitions) : undefined;
    let output;
    if (mode === "definition") output = taskDefinition(plan, values.component);
    else if (mode === "policy") output = smokePolicy(plan, definitions);
    else if (mode === "run")
      output = runInput(plan, values.component, Number(values["subnet-index"]), definitions);
    else {
      const names =
        mode === "verify"
          ? ["run", "running", "eni", "stopped", "logs"]
          : ["run", "running", "eni"];
      const evidence = Object.fromEntries(
        names.map((name) => [name, readJson(join(values["readback-dir"], `${name}.json`))]),
      );
      output = (mode === "verify" ? verifyResult : verifyNetwork)(
        plan,
        values.component,
        Number(values["subnet-index"]),
        definitions,
        evidence,
      );
    }
    console.log(JSON.stringify(output, null, 2));
  } catch (error) {
    console.error(`[aws-private-task-smoke] ${error.message}`);
    process.exitCode = 1;
  }
}

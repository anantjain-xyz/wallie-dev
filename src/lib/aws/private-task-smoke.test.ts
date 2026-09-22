import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

type Data = Record<string, unknown>;
let helper: Record<string, (...args: unknown[]) => Data>;
const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-private-task-smoke.mjs", import.meta.url),
);
beforeAll(async () => {
  helper = await import(new URL(`file://${script}`).href);
});
const now = Date.parse("2026-09-22T12:05:00Z");
const createdAt = "2026-09-22T12:00:00Z";
const account = "123456789012",
  region = "us-west-2";
const vpcId = "vpc-00000000000000001",
  taskSg = "sg-00000000000000001",
  endpointSg = "sg-00000000000000002";
const subnetIds = ["subnet-00000000000000001", "subnet-00000000000000002"];
const routeIds = ["rtb-00000000000000001", "rtb-00000000000000002"];
const prefixId = "pl-12345678",
  s3Id = "vpce-00000000000000001";
const runId = "1".repeat(32);
const endpointCondition = {
  StringEquals: { "aws:PrincipalAccount": account, "aws:RequestedRegion": region },
};
const reference = (component: string) =>
  `${account}.dkr.ecr.${region}.amazonaws.com/wallie-staging/${component}@sha256:${component === "web" ? "a".repeat(64) : "b".repeat(64)}`;
function fixture() {
  const ecrPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AuthenticateExpectedAccount",
        Effect: "Allow",
        Principal: "*",
        Action: "ecr:GetAuthorizationToken",
        Resource: "*",
        Condition: endpointCondition,
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
        Resource: ["web", "worker"].map(
          (c) => `arn:aws:ecr:${region}:${account}:repository/wallie-staging/${c}`,
        ),
        Condition: endpointCondition,
      },
    ],
  };
  const logsPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "WriteApplicationLogs",
        Effect: "Allow",
        Principal: "*",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: ["web", "worker"].map(
          (c) => `arn:aws:logs:${region}:${account}:log-group:/wallie/staging/${c}:log-stream:*`,
        ),
        Condition: endpointCondition,
      },
    ],
  };
  const trustPolicy = {
    version: "1.0",
    trustPolicies: [
      {
        name: "wallie-staging-images",
        registryScopes: ["web", "worker"].map(
          (c) => `${account}.dkr.ecr.${region}.amazonaws.com/wallie-staging/${c}`,
        ),
        signatureVerification: { level: "strict" },
        trustStores: ["signingAuthority:aws-signer-ts"],
        trustedIdentities: [
          `arn:aws:signer:${region}:${account}:/signing-profiles/wallie_staging_images/abcdefghij`,
        ],
      },
    ],
  };
  const permission = (group: string, prefix = false) => ({
    IpProtocol: "tcp",
    FromPort: 443,
    ToPort: 443,
    UserIdGroupPairs: [{ UserId: account, GroupId: group }],
    PrefixListIds: prefix ? [{ PrefixListId: prefixId }] : [],
    IpRanges: [],
    Ipv6Ranges: [],
  });
  return {
    schemaVersion: 1,
    account,
    region,
    runId,
    createdAt,
    identity: { Account: account, Arn: `arn:aws:iam::${account}:user/wallie-local` },
    vpcId,
    subnetIds,
    taskSecurityGroupId: taskSg,
    profileVersion: "abcdefghij",
    images: Object.fromEntries(
      ["web", "worker"].map((component) => [
        component,
        {
          digest: reference(component).split("@")[1],
          sourceRevision: "c".repeat(40),
          publishId: "d".repeat(32),
          scan: {
            capturedAt: createdAt,
            response: {
              registryId: account,
              repositoryName: `wallie-staging/${component}`,
              imageId: { imageDigest: reference(component).split("@")[1] },
              imageScanStatus: { status: "COMPLETE" },
              imageScanFindings: {
                imageScanCompletedAt: createdAt,
                findingSeverityCounts: { HIGH: 0, CRITICAL: 0 },
              },
            },
          },
          verification: {
            capturedAt: createdAt,
            exitCode: 0,
            args: [
              "verify",
              reference(component),
              "--plugin-config",
              `aws-region=${region}`,
              "--max-signatures",
              "100",
              "--user-metadata",
              `wallie.dev/publish-id=${"d".repeat(32)}`,
            ],
            stdout: `Successfully verified signature for ${reference(component)}\n`,
            trustPolicy,
          },
        },
      ]),
    ),
    network: {
      capturedAt: createdAt,
      vpcs: {
        Vpcs: [{ VpcId: vpcId, OwnerId: account, State: "available", CidrBlock: "10.42.0.0/16" }],
      },
      subnets: {
        Subnets: subnetIds.map((id, index) => ({
          SubnetId: id,
          VpcId: vpcId,
          OwnerId: account,
          AvailabilityZone: `us-west-2${index ? "b" : "a"}`,
          State: "available",
          MapPublicIpOnLaunch: false,
          AssignIpv6AddressOnCreation: false,
          Ipv6CidrBlockAssociationSet: [],
        })),
      },
      routeTables: {
        RouteTables: routeIds.map((id, index) => ({
          RouteTableId: id,
          VpcId: vpcId,
          OwnerId: account,
          Associations: [
            { Main: false, SubnetId: subnetIds[index], AssociationState: { State: "associated" } },
          ],
          Routes: [
            { GatewayId: "local", DestinationCidrBlock: "10.42.0.0/16", State: "active" },
            { GatewayId: s3Id, DestinationPrefixListId: prefixId, State: "active" },
          ],
        })),
      },
      prefixList: {
        PrefixLists: [
          {
            PrefixListId: prefixId,
            PrefixListName: `com.amazonaws.${region}.s3`,
            OwnerId: "AWS",
            AddressFamily: "IPv4",
          },
        ],
      },
      endpoints: {
        VpcEndpoints: [
          {
            VpcEndpointId: s3Id,
            ServiceName: `com.amazonaws.${region}.s3`,
            VpcId: vpcId,
            OwnerId: account,
            State: "available",
            VpcEndpointType: "Gateway",
            IpAddressType: "ipv4",
            RouteTableIds: routeIds,
            PolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "ReadRegionalEcrImageLayers",
                  Effect: "Allow",
                  Principal: "*",
                  Action: "s3:GetObject",
                  Resource: `arn:aws:s3:::prod-${region}-starport-layer-bucket/*`,
                },
              ],
            }),
          },
          ...["ecr.api", "ecr.dkr", "logs"].map((service, index) => ({
            VpcEndpointId: `vpce-${String(index + 2).padStart(17, "0")}`,
            ServiceName: `com.amazonaws.${region}.${service}`,
            VpcId: vpcId,
            OwnerId: account,
            State: "available",
            VpcEndpointType: "Interface",
            IpAddressType: "ipv4",
            PrivateDnsEnabled: true,
            SubnetIds: subnetIds,
            Groups: [{ GroupId: endpointSg }],
            PolicyDocument: JSON.stringify(service === "logs" ? logsPolicy : ecrPolicy),
          })),
        ],
      },
      securityGroups: {
        SecurityGroups: [
          {
            GroupId: taskSg,
            VpcId: vpcId,
            OwnerId: account,
            IpPermissions: [],
            IpPermissionsEgress: [permission(endpointSg, true)],
          },
          {
            GroupId: endpointSg,
            VpcId: vpcId,
            OwnerId: account,
            IpPermissions: [permission(taskSg)],
            IpPermissionsEgress: [],
          },
        ],
      },
    },
  };
}
function setAt(value: unknown, path: string, replacement: unknown) {
  const parts = path.split(".");
  let target = value as Data;
  for (const part of parts.slice(0, -1)) target = target[part] as Data;
  target[parts.at(-1)!] = replacement;
}
function registered(plan = fixture()) {
  return Object.fromEntries(
    ["web", "worker"].map((component) => {
      const { tags, ...definition } = helper.taskDefinition(plan, component);
      return [
        component,
        {
          tags,
          taskDefinition: {
            ...definition,
            taskDefinitionArn: `arn:aws:ecs:${region}:${account}:task-definition/${definition.family}:1`,
            revision: 1,
            status: "ACTIVE",
            requiresAttributes: [],
            compatibilities: ["FARGATE"],
            registeredAt: createdAt,
            registeredBy: `arn:aws:iam::${account}:user/admin`,
            volumes: [],
            placementConstraints: [],
          },
        },
      ];
    }),
  );
}
function evidence(plan = fixture(), component = "web", index = 0) {
  const definitions = registered(plan);
  const input = helper.runInput(plan, component, index, definitions);
  const taskId = `${index}${component === "web" ? "a" : "b"}`.repeat(16);
  const taskArn = `arn:aws:ecs:${region}:${account}:task/wallie-staging/${taskId}`;
  const attachmentId = "attachment-1",
    eniId = "eni-00000000000000001",
    privateIp = "10.42.16.10";
  const task = {
    taskArn,
    clusterArn: input.cluster,
    taskDefinitionArn: input.taskDefinition,
    launchType: "FARGATE",
    platformVersion: "1.4.0",
    cpu: "256",
    memory: "512",
    enableExecuteCommand: false,
    startedBy: input.startedBy,
    group: input.group,
    tags: input.tags,
    overrides: { containerOverrides: [{ name: "smoke" }], inferenceAcceleratorOverrides: [] },
    createdAt: "2026-09-22T12:00:01Z",
    startedAt: "2026-09-22T12:01:00Z",
    lastStatus: "RUNNING",
    desiredStatus: "RUNNING",
    containers: [
      {
        name: "smoke",
        lastStatus: "RUNNING",
        image: reference(component),
        imageDigest: reference(component).split("@")[1],
        networkInterfaces: [{ attachmentId, privateIpv4Address: privateIp }],
      },
    ],
    attachments: [
      {
        id: attachmentId,
        type: "ElasticNetworkInterface",
        status: "ATTACHED",
        details: [
          { name: "networkInterfaceId", value: eniId },
          { name: "subnetId", value: plan.subnetIds[index] },
          { name: "privateIPv4Address", value: privateIp },
        ],
      },
    ],
  };
  const envelope = (
    capturedAt: string,
    task: unknown,
    requestStartedAt = new Date(Date.parse(capturedAt) - 250).toISOString(),
  ) => ({
    requestStartedAt,
    capturedAt,
    response: { failures: [], tasks: [structuredClone(task)] },
  });
  const stoppedTask = structuredClone(task) as Data;
  setAt(stoppedTask, "lastStatus", "STOPPED");
  setAt(stoppedTask, "desiredStatus", "STOPPED");
  setAt(stoppedTask, "containers.0.lastStatus", "STOPPED");
  setAt(stoppedTask, "containers.0.exitCode", 0);
  stoppedTask.stopCode = "EssentialContainerExited";
  stoppedTask.stoppedAt = "2026-09-22T12:02:05Z";
  const logRequest = {
    logGroupName: `/wallie/staging/${component}`,
    logStreamName: `${"secretInjection" in plan ? "wallie-secret-smoke" : "wallie-smoke"}-${runId}/smoke/${taskId}`,
    startFromHead: true,
  };
  return {
    definitions,
    snapshots: {
      run: envelope(
        "2026-09-22T12:00:02Z",
        {
          ...task,
          startedAt: undefined,
          lastStatus: "PROVISIONING",
        },
        "2026-09-22T12:00:00Z",
      ),
      running: envelope("2026-09-22T12:01:05Z", task),
      eni: {
        requestStartedAt: "2026-09-22T12:01:05Z",
        capturedAt: "2026-09-22T12:01:06Z",
        response: {
          NetworkInterfaces: [
            {
              NetworkInterfaceId: eniId,
              VpcId: vpcId,
              SubnetId: plan.subnetIds[index],
              OwnerId: account,
              Status: "in-use",
              PrivateIpAddress: privateIp,
              PrivateIpAddresses: [{ PrivateIpAddress: privateIp, Primary: true }],
              Ipv6Addresses: [],
              Groups: [{ GroupId: taskSg }],
              Attachment: { Status: "attached" },
            },
          ],
        },
      },
      stopped: envelope("2026-09-22T12:02:10Z", stoppedTask),
      logs: [
        {
          requestStartedAt: "2026-09-22T12:02:10Z",
          capturedAt: "2026-09-22T12:02:11Z",
          request: logRequest,
          response: {
            events: ["started", "completed"].map((phase, index) => ({
              message: JSON.stringify({
                kind:
                  "secretInjection" in plan
                    ? "wallie-secret-injection-smoke"
                    : "wallie-private-smoke",
                run: runId,
                component,
                phase,
              }),
              timestamp: Date.parse(`2026-09-22T12:0${index + 1}:00Z`),
            })),
            nextForwardToken: "end",
          },
        },
        {
          requestStartedAt: "2026-09-22T12:02:11Z",
          capturedAt: "2026-09-22T12:02:12Z",
          request: { ...logRequest, nextToken: "end" },
          response: { events: [], nextForwardToken: "end" },
        },
      ],
    },
  };
}

describe("private ECS smoke preparation", () => {
  it("requires independently captured image and network evidence, then emits only fixed no-app definitions", () => {
    const plan = helper.validateManifest(fixture(), now);
    for (const component of ["web", "worker"]) {
      const definition = helper.taskDefinition(plan, component);
      expect(definition).toMatchObject({
        family: `wallie-staging-${component}-connectivity-smoke`,
        executionRoleArn: `arn:aws:iam::${account}:role/wallie-staging-${component}-execution`,
        networkMode: "awsvpc",
        cpu: "256",
        memory: "512",
        requiresCompatibilities: ["FARGATE"],
        runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
      });
      expect(definition.taskRoleArn).toBeUndefined();
      const container = (definition.containerDefinitions as Data[])[0];
      expect(container).toMatchObject({
        name: "smoke",
        image: reference(component),
        entryPoint: ["node"],
        user: "1000:1000",
        readonlyRootFilesystem: true,
        essential: true,
      });
      for (const field of ["secrets", "environment", "portMappings", "mountPoints"])
        expect(container[field]).toBeUndefined();
      expect((container.command as string[])[1]).not.toMatch(/next|worker\/index|fetch\(|https?:/);
    }
  });

  it.each(
    ["web", "worker"].flatMap((component) => [0, 1].map((index) => [component, index] as const)),
  )("renders and verifies %s in private subnet %s", (component, index) => {
    const plan = fixture(),
      { definitions, snapshots } = evidence(plan, component, index);
    const input = helper.runInput(plan, component, index, definitions);
    expect(input).toMatchObject({
      count: 1,
      launchType: "FARGATE",
      platformVersion: "1.4.0",
      enableExecuteCommand: false,
      enableECSManagedTags: false,
      clientToken: `${runId}-${component}-${index}`,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: [subnetIds[index]],
          securityGroups: [taskSg],
          assignPublicIp: "DISABLED",
        },
      },
    });
    expect(input.overrides).toBeUndefined();
    expect(helper.verifyResult(plan, component, index, definitions, snapshots, now)).toMatchObject({
      status: "offline-smoke-evidence-matches",
      component,
      subnetId: subnetIds[index],
      deployable: false,
      exitCode: 0,
    });
  });

  it.each([
    ["account", "123"],
    ["account", `${account}\n`],
    ["region", "cn-north-1"],
    ["region", "us-gov-west-1"],
    ["region", "us-west-2\n"],
    ["runId", "bad"],
    ["createdAt", "2026-09-22T11:00:00Z"],
    ["createdAt", "2026-09-22T13:00:00Z"],
    ["identity.Arn", `arn:aws:iam::${account}:root`],
    ["subnetIds", [subnetIds[0], subnetIds[0]]],
    ["network.capturedAt", "2026-09-22T11:00:00Z"],
    ["network.subnets.Subnets.0.MapPublicIpOnLaunch", true],
    ["network.subnets.Subnets.0.AssignIpv6AddressOnCreation", true],
    [
      "network.routeTables.RouteTables.0.Routes.1",
      { DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: "nat-12345678", State: "active" },
    ],
    ["network.endpoints.VpcEndpoints.1.PrivateDnsEnabled", false],
    [
      "network.endpoints.VpcEndpoints.1.PolicyDocument",
      JSON.stringify({ Version: "2012-10-17", Statement: [] }),
    ],
    [
      "network.securityGroups.SecurityGroups.0.IpPermissionsEgress.0.IpRanges",
      [{ CidrIp: "0.0.0.0/0" }],
    ],
    ["network.prefixList.PrefixLists.0.OwnerId", account],
    ["network.routeTables.NextToken", "more"],
    ["images.web.scan.response.imageScanStatus.status", "IN_PROGRESS"],
    ["images.web.scan.response.imageId.imageDigest", `sha256:${"0".repeat(64)}`],
    ["images.web.scan.response.imageScanFindings.findingSeverityCounts.HIGH", 1],
    ["images.web.scan.response.imageScanFindings.findingSeverityCounts.CRITICAL", "0"],
    ["images.web.scan.response.imageScanFindings.findingSeverityCounts.UNKNOWN", 0],
    ["images.web.scan.response.imageScanFindings.findingSeverityCounts.LOW", -1],
    ["images.web.scan.response.imageScanFindings.findingSeverityCounts.MEDIUM", 0.5],
    ["images.web.scan.response.imageScanFindings.imageScanCompletedAt", "2026-09-20T12:00:00Z"],
    ["images.web.verification.exitCode", 1],
    ["images.web.verification.stdout", "Successfully verified another image"],
    ["images.web.verification.args", ["verify", reference("web")]],
    [
      "images.web.verification.trustPolicy.trustPolicies.0.signatureVerification.level",
      "permissive",
    ],
  ])("rejects unsafe or stale manifest field %s", (path, replacement) => {
    const plan = fixture();
    setAt(plan, path as string, replacement);
    expect(() => helper.validateManifest(plan, now)).toThrow();
  });

  it("preserves valid old results while refusing to prepare another launch from old evidence", () => {
    const plan = fixture(),
      { definitions, snapshots } = evidence(plan);
    const later = now + 48 * 60 * 60_000;
    expect(() => helper.validateManifest(plan, later)).toThrow(/fresh/);
    const historical = helper.validateManifest(plan, later, true);
    expect(helper.verifyResult(historical, "web", 0, definitions, snapshots, later).exitCode).toBe(
      0,
    );
  });

  it.each([
    "network.capturedAt",
    "images.web.scan.capturedAt",
    "images.worker.verification.capturedAt",
    "images.web.scan.response.imageScanFindings.imageScanCompletedAt",
  ])("rejects qualification captured after launch: %s", (path) => {
    const plan = fixture(),
      { definitions, snapshots } = evidence(plan);
    setAt(plan, path, "2026-09-22T12:00:03Z");
    expect(() => helper.verifyResult(plan, "web", 0, definitions, snapshots, now)).toThrow(
      /qualification window/,
    );
  });

  it("rejects a late task even when retrospectively validating its old evidence", () => {
    const plan = fixture(),
      { definitions, snapshots } = evidence(plan);
    snapshots.run.requestStartedAt = "2026-09-22T12:16:00Z";
    snapshots.run.capturedAt = "2026-09-22T12:16:02Z";
    setAt(snapshots, "run.response.tasks.0.createdAt", "2026-09-22T12:16:01Z");
    expect(() =>
      helper.verifyResult(plan, "web", 0, definitions, snapshots, now + 60 * 60_000),
    ).toThrow(/qualification window/);
  });

  function assemblyFixture(plan = fixture()) {
    const { createdAt: _created, identity, network, images, ...header } = plan;
    void _created;
    return {
      input: {
        ...header,
        images: Object.fromEntries(
          Object.entries(images).map(([component, image]) => [
            component,
            {
              digest: image.digest,
              sourceRevision: image.sourceRevision,
              publishId: image.publishId,
            },
          ]),
        ),
      },
      readback: {
        identity: { requestStartedAt: createdAt, capturedAt: createdAt, response: identity },
        ...Object.fromEntries(
          Object.entries(network)
            .filter(([name]) => name !== "capturedAt")
            .map(([name, response]) => [
              name,
              { requestStartedAt: createdAt, capturedAt: createdAt, response },
            ]),
        ),
        ...Object.fromEntries(
          Object.entries(images).flatMap(([component, image]) => [
            [`${component}-scan`, { requestStartedAt: createdAt, ...image.scan }],
            [`${component}-verification`, image.verification],
          ]),
        ),
      },
    };
  }

  it("assembles independently captured files and conservatively retains the first network read time", () => {
    const { input, readback } = assemblyFixture();
    setAt(readback, "prefixList.capturedAt", "2026-09-22T12:04:00Z");
    setAt(readback, "prefixList.requestStartedAt", "2026-09-22T12:03:59Z");
    const assembled = helper.assembleManifest(input, readback, now);
    expect(assembled).toMatchObject({
      createdAt: new Date(now).toISOString(),
      identity: fixture().identity,
      network: { capturedAt: new Date(createdAt).toISOString() },
    });
    expect(helper.validateManifest(assembled, now)).toEqual(assembled);
  });

  it("assembles raw canary metadata and rejects arbitrary payload inputs", () => {
    const plan = injectionFixture();
    const { input, readback } = assemblyFixture(plan);
    setAt(
      input,
      "secretInjection",
      Object.fromEntries(
        Object.entries(plan.secretInjection).map(([component, secret]) => [
          component,
          { secretArn: secret.secretArn, versionId: secret.versionId },
        ]),
      ),
    );
    Object.assign(
      readback,
      Object.fromEntries(
        Object.entries(plan.secretInjection).flatMap(([component, secret]) => [
          [`${component}-secret`, secret.secret],
          [`${component}-versions`, secret.versions],
          [`${component}-resource-policy`, secret.resourcePolicy],
        ]),
      ),
    );
    const assembled = helper.assembleManifest(input, readback, now);
    expect(assembled.secretInjection).toEqual(plan.secretInjection);
    expect(helper.validateManifest(assembled, now)).toEqual(assembled);
    setAt(input, "secretInjection.web.expectedValue", "private-value-must-not-appear");
    expect(() => helper.assembleManifest(input, readback, now)).toThrow(/reviewed canary identity/);
  });

  it("accepts a task created during RunTask and rejects impossible request/response timing", () => {
    const plan = fixture(),
      { definitions, snapshots } = evidence(plan);
    const taskCreatedAt = (snapshots.run.response.tasks[0] as { createdAt: string }).createdAt;
    expect(Date.parse(snapshots.run.requestStartedAt)).toBeLessThan(Date.parse(taskCreatedAt));
    expect(Date.parse(snapshots.run.capturedAt)).toBeGreaterThan(Date.parse(taskCreatedAt));
    expect(helper.verifyResult(plan, "web", 0, definitions, snapshots, now).exitCode).toBe(0);
    snapshots.run.requestStartedAt = "2026-09-22T12:00:03Z";
    expect(() => helper.verifyResult(plan, "web", 0, definitions, snapshots, now)).toThrow(
      /capture time/,
    );
  });

  it.each([
    ["identity.capturedAt", "2026-09-22T11:00:00Z"],
    ["prefixList.capturedAt", "2026-09-22T12:06:00Z"],
    ["endpoints.capturedAt", "2026-09-22T11:00:00Z"],
  ])("rejects stale/future assembly capture %s", (path, replacement) => {
    const { input, readback } = assemblyFixture();
    setAt(readback, path, replacement);
    expect(() => helper.assembleManifest(input, readback, now)).toThrow(/fresh/);
  });

  it.each(["web", "worker"])(
    "accepts known ECS defaults for %s without changing the readback",
    (component) => {
      const plan = fixture(),
        { definitions, snapshots } = evidence(plan, component);
      for (const definition of Object.values(definitions)) {
        setAt(definition.taskDefinition, "containerDefinitions.0.versionConsistency", "enabled");
        setAt(
          definition.taskDefinition,
          "containerDefinitions.0.logConfiguration.secretOptions",
          [],
        );
        setAt(
          definition.taskDefinition,
          "containerDefinitions.0.linuxParameters.capabilities.add",
          [],
        );
      }
      const original = structuredClone(definitions);
      expect(helper.runInput(plan, component, 0, definitions).count).toBe(1);
      expect(helper.smokePolicy(plan, definitions).Statement).toBeDefined();
      expect(helper.verifyResult(plan, component, 0, definitions, snapshots, now).exitCode).toBe(0);
      expect(definitions).toEqual(original);
    },
  );

  it.each([
    ["taskRoleArn", `arn:aws:iam::${account}:role/wallie-staging-web-execution`],
    ["cpu", "4096"],
    ["containerDefinitions.0.command", ["node", "worker/index.js"]],
    ["containerDefinitions.0.environment", [{ name: "SECRET", value: "hidden" }]],
    ["containerDefinitions.0.secrets", [{ name: "SECRET", valueFrom: "anything" }]],
    ["containerDefinitions.0.image", reference("worker")],
    ["containerDefinitions.0.versionConsistency", "disabled"],
    ["containerDefinitions.0.versionConsistency", null],
    ["containerDefinitions.0.versionConsistency", ["enabled"]],
    ["containerDefinitions.0.logConfiguration.options.mode", "non-blocking"],
    [
      "containerDefinitions.0.logConfiguration.secretOptions",
      [{ name: "token", valueFrom: "secret" }],
    ],
    ["containerDefinitions.0.logConfiguration.secretOptions", null],
    ["containerDefinitions.0.logConfiguration.secretOptions", {}],
    ["containerDefinitions.0.linuxParameters.capabilities.add", ["SYS_ADMIN"]],
    ["containerDefinitions.0.linuxParameters.capabilities.add", null],
    ["containerDefinitions.0.linuxParameters.capabilities.add", "SYS_ADMIN"],
    ["containerDefinitions.0.portMappings", [{ containerPort: 3000 }]],
  ])("rejects unexpected registered-definition field %s", (path, replacement) => {
    const plan = fixture(),
      definitions = registered(plan);
    setAt(definitions.web.taskDefinition, path as string, replacement);
    expect(() => helper.runInput(plan, "web", 0, definitions)).toThrow();
    expect(() => helper.smokePolicy(plan, definitions)).toThrow();
  });

  it.each([
    ["run.response.failures", [{ reason: "CAPACITY" }]],
    ["running.response.tasks.0.lastStatus", "STOPPED"],
    ["running.response.tasks.0.createdAt", "2026-09-22T12:00:02Z"],
    ["stopped.response.tasks.0.createdAt", "2026-09-22T12:00:02Z"],
    [
      "running.response.tasks.0.overrides.taskRoleArn",
      `arn:aws:iam::${account}:role/wallie-staging-web-execution`,
    ],
    ["running.response.tasks.0.overrides.containerOverrides.0.command", ["other"]],
    [
      "running.response.tasks.0.overrides.containerOverrides.0.environment",
      [{ name: "SECRET", value: "hidden" }],
    ],
    ["running.response.tasks.0.containers.0.imageDigest", `sha256:${"f".repeat(64)}`],
    ["running.response.tasks.0.containers.0.networkInterfaces.0.privateIpv4Address", "10.0.0.99"],
    ["eni.response.NetworkInterfaces.0.SubnetId", subnetIds[1]],
    ["eni.response.NetworkInterfaces.0.Groups", [{ GroupId: endpointSg }]],
    ["eni.response.NetworkInterfaces.0.Association", { PublicIp: "1.2.3.4" }],
    ["eni.response.NetworkInterfaces.0.PrivateIpAddresses.0.Association", { PublicIp: "1.2.3.4" }],
    ["eni.response.NetworkInterfaces.0.Ipv6Addresses", [{ Ipv6Address: "2001:db8::1" }]],
    ["eni.capturedAt", "2026-09-22T12:03:00Z"],
    ["stopped.response.tasks.0.containers.0.exitCode", 70],
    ["stopped.response.tasks.0.stopCode", "UserInitiated"],
    [
      "stopped.response.tasks.0.taskArn",
      `arn:aws:ecs:${region}:${account}:task/wallie-staging/${"f".repeat(32)}`,
    ],
    ["logs.0.request.logStreamName", "another-task"],
    ["logs.0.response.events.0.message", "other-marker"],
    ["logs.0.response.events.0.timestamp", 0],
    ["logs.0.response.events.0.timestamp", Date.parse("2026-09-22T12:00:50Z")],
    ["logs.1.request.nextToken", "wrong-token"],
    ["logs.1.response.nextForwardToken", "more"],
  ])("fails closed on mismatched live evidence %s", (path, replacement) => {
    const plan = fixture(),
      { definitions, snapshots } = evidence(plan);
    setAt(snapshots, path as string, replacement);
    expect(() => helper.verifyResult(plan, "web", 0, definitions, snapshots, now)).toThrow();
  });

  it.each(["run", "running", "eni", "stopped"])(
    "rejects %s response receipt after the request-based ten-minute deadline",
    (capture) => {
      const plan = fixture(),
        { definitions, snapshots } = evidence(plan);
      setAt(snapshots, `${capture}.capturedAt`, "2026-09-22T12:10:00.001Z");
      const later = Date.parse("2026-09-22T12:20:00Z");
      if (capture !== "stopped")
        expect(() => helper.verifyNetwork(plan, "web", 0, definitions, snapshots, later)).toThrow(
          /smoke deadline/,
        );
      expect(() => helper.verifyResult(plan, "web", 0, definitions, snapshots, later)).toThrow(
        /smoke deadline/,
      );
    },
  );

  it.each([0, 1])(
    "rejects log page %s received late even if requested before the deadline",
    (page) => {
      const plan = fixture(),
        { definitions, snapshots } = evidence(plan);
      snapshots.logs[page].requestStartedAt = "2026-09-22T12:09:59.999Z";
      snapshots.logs[page].capturedAt = "2026-09-22T12:10:00.001Z";
      expect(() =>
        helper.verifyResult(plan, "web", 0, definitions, snapshots, now + 48 * 60 * 60_000),
      ).toThrow(/Log evidence exceeds smoke deadline/);
    },
  );

  it("accepts a complete log chain received exactly at the deadline when verified later", () => {
    const plan = fixture(),
      { definitions, snapshots } = evidence(plan);
    snapshots.logs[1].requestStartedAt = "2026-09-22T12:09:59.999Z";
    snapshots.logs[1].capturedAt = "2026-09-22T12:10:00.000Z";
    expect(
      helper.verifyResult(plan, "web", 0, definitions, snapshots, now + 48 * 60 * 60_000).exitCode,
    ).toBe(0);
  });

  it("does not restart the deadline when task creation is delayed", () => {
    const plan = fixture(),
      { definitions, snapshots } = evidence(plan);
    const shift = (value: string) => new Date(Date.parse(value) + 8 * 60_000).toISOString();
    for (const [name, capture] of Object.entries({
      run: snapshots.run,
      running: snapshots.running,
      stopped: snapshots.stopped,
    })) {
      if (name !== "run") capture.requestStartedAt = shift(capture.requestStartedAt);
      capture.capturedAt = shift(capture.capturedAt);
      const task = capture.response.tasks[0] as Data;
      for (const key of ["createdAt", "startedAt", "stoppedAt"])
        if (typeof task[key] === "string") task[key] = shift(task[key]);
    }
    snapshots.eni.requestStartedAt = shift(snapshots.eni.requestStartedAt);
    snapshots.eni.capturedAt = shift(snapshots.eni.capturedAt);
    for (const page of snapshots.logs) {
      page.requestStartedAt = shift(page.requestStartedAt);
      page.capturedAt = shift(page.capturedAt);
      for (const event of page.response.events) event.timestamp += 8 * 60_000;
    }
    const later = now + 60 * 60_000;
    expect(
      helper.verifyNetwork(plan, "web", 0, definitions, snapshots, later).taskArn,
    ).toBeDefined();
    expect(() => helper.verifyResult(plan, "web", 0, definitions, snapshots, later)).toThrow(
      /smoke deadline/,
    );
  });

  it.each([
    ["running.requestStartedAt", "2026-09-22T12:00:01Z", /RunTask response/],
    ["stopped.requestStartedAt", "2026-09-22T12:01:05Z", /ENI response/],
    ["logs.0.requestStartedAt", "2026-09-22T12:02:09Z", /in order/],
    ["logs.1.requestStartedAt", "2026-09-22T12:02:10Z", /in order/],
  ])("rejects out-of-order capture %s", (path, replacement, error) => {
    const plan = fixture(),
      { definitions, snapshots } = evidence(plan);
    setAt(snapshots, path as string, replacement);
    expect(() => helper.verifyResult(plan, "web", 0, definitions, snapshots, now)).toThrow(error);
  });

  it("continues through empty log pages and requires an actual stable forward token", () => {
    const plan = fixture(),
      { definitions, snapshots } = evidence(plan);
    const first = snapshots.logs[0];
    snapshots.logs.unshift({
      ...structuredClone(first),
      capturedAt: first.requestStartedAt,
      response: { events: [], nextForwardToken: "empty-page" },
    });
    Object.assign(snapshots.logs[1].request, { nextToken: "empty-page" });
    expect(helper.verifyResult(plan, "web", 0, definitions, snapshots, now).exitCode).toBe(0);
  });

  it("renders only exact revisions/roles/run logs plus documented global metadata reads", () => {
    const plan = fixture(),
      policy = helper.smokePolicy(plan, registered(plan));
    expect(JSON.stringify(policy).length).toBeLessThanOrEqual(6144);
    const statements = policy.Statement as {
      Sid: string;
      Action: string | string[];
      Resource: string | string[];
      Condition: Data;
    }[];
    const actions = statements.flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action],
    );
    expect(actions.sort()).toEqual([
      "ec2:DescribeNetworkInterfaces",
      "ecs:DescribeTaskDefinition",
      "ecs:DescribeTasks",
      "ecs:ListTagsForResource",
      "ecs:RunTask",
      "ecs:StopTask",
      "ecs:TagResource",
      "iam:PassRole",
      "logs:GetLogEvents",
    ]);
    expect(statements.find((item) => item.Sid === "RunReviewedSmokeRevisions")?.Resource).toEqual(
      ["web", "worker"].map(
        (c) =>
          `arn:aws:ecs:${region}:${account}:task-definition/wallie-staging-${c}-connectivity-smoke:1`,
      ),
    );
    expect(
      statements.find((item) => item.Sid === "RunReviewedSmokeRevisions")?.Condition,
    ).toMatchObject({
      Bool: { "ecs:enable-execute-command": "false" },
      BoolIfExists: { "ecs:enable-ebs-volumes": "false" },
    });
    expect(JSON.stringify(statements)).not.toMatch(
      /ecs:subnet|ecs:auto-assign-public-ip|RegisterTaskDefinition|CreateService|secretsmanager:|iam:Create/,
    );
    expect(statements.filter((item) => item.Resource === "*").map((item) => item.Sid)).toEqual([
      "ReadUnscopableQualificationMetadata",
    ]);
  });

  it("assembles fresh envelopes and renders definitions through the credential-free CLI", () => {
    const directory = mkdtempSync(join(tmpdir(), "wallie-private-smoke-"));
    try {
      const { input, readback } = assemblyFixture();
      const current = new Date().toISOString();
      const inputPath = join(directory, "inputs.json"),
        manifestPath = join(directory, "manifest.json");
      writeFileSync(inputPath, JSON.stringify(input));
      for (const [name, response] of Object.entries(readback))
        writeFileSync(
          join(directory, `${name}.json`),
          JSON.stringify(response).replaceAll(createdAt, current),
        );
      const run = (args: string[]) =>
        spawnSync(process.execPath, [script, ...args], {
          encoding: "utf8",
          timeout: 5000,
          env: { NODE_ENV: "test", PATH: "", AWS_PROFILE: "must-not-be-used" },
        });
      const assembled = run(["assemble", "--manifest", inputPath, "--readback-dir", directory]);
      expect(assembled.status).toBe(0);
      expect(assembled.stderr).toBe("");
      writeFileSync(manifestPath, assembled.stdout);
      const definition = run(["definition", "--manifest", manifestPath, "--component", "worker"]);
      expect(definition.status).toBe(0);
      expect(JSON.parse(definition.stdout)).toMatchObject({
        family: "wallie-staging-worker-connectivity-smoke",
        executionRoleArn: `arn:aws:iam::${account}:role/wallie-staging-worker-execution`,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown/duplicate CLI inputs and invalid private files without printing payloads", () => {
    const directory = mkdtempSync(join(tmpdir(), "wallie-private-smoke-"));
    try {
      const path = join(directory, "manifest.json");
      writeFileSync(path, "private-input-must-not-appear");
      for (const args of [
        ["definition", "--manifest", path, "--component", "web"],
        ["run", "--manifest", path, "--profile", "root"],
        ["definition", "--manifest", path, "--manifest", path, "--component", "web"],
      ]) {
        const result = spawnSync(process.execPath, [script, ...args], {
          encoding: "utf8",
          timeout: 5000,
          env: { NODE_ENV: "test", PATH: "" },
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("private-input");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

const canaryArn = (component: string) =>
  `arn:aws:secretsmanager:${region}:${account}:secret:/wallie/staging/${component}/runtime-Ab12Cd`;
function injectionFixture() {
  const plan = fixture();
  const secretInjection = Object.fromEntries(
    ["web", "worker"].map((component) => {
      const identity = { ARN: canaryArn(component), Name: `/wallie/staging/${component}/runtime` };
      const envelope = (response: unknown) => ({
        requestStartedAt: createdAt,
        capturedAt: createdAt,
        response,
      });
      return [
        component,
        {
          secretArn: identity.ARN,
          versionId: runId,
          secret: envelope({
            ...identity,
            Description: `Wallie staging ${component} runtime secret configuration; values managed outside Terraform.`,
            CreatedDate: createdAt,
            LastChangedDate: createdAt,
            Tags: Object.entries({
              Project: "Wallie",
              Environment: "staging",
              ManagedBy: "Terraform",
              WallieStack: "wallie-staging-application",
              Component: "runtime-secrets",
              Name: identity.Name,
            }).map(([Key, Value]) => ({ Key, Value })),
            VersionIdsToStages: { [runId]: ["AWSCURRENT"] },
          }),
          resourcePolicy: envelope(identity),
          versions: {
            ...envelope({
              ...identity,
              Versions: [
                { VersionId: runId, VersionStages: ["AWSCURRENT"], CreatedDate: createdAt },
              ],
            }),
            request: { SecretId: identity.ARN, IncludeDeprecated: true },
          },
        },
      ];
    }),
  );
  const secretEndpoint = {
    VpcEndpointId: "vpce-00000000000000005",
    ServiceName: `com.amazonaws.${region}.secretsmanager`,
    VpcId: vpcId,
    OwnerId: account,
    State: "available",
    VpcEndpointType: "Interface",
    IpAddressType: "ipv4",
    PrivateDnsEnabled: true,
    SubnetIds: subnetIds,
    Groups: [{ GroupId: endpointSg }],
    Tags: Object.entries({
      Project: "Wallie",
      Environment: "staging",
      ManagedBy: "Terraform",
      WallieStack: "wallie-staging-network",
      Component: "private-connectivity",
      Name: "wallie-staging-runtime-secrets",
    }).map(([Key, Value]) => ({ Key, Value })),
    PolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: ["web", "worker"].map((component) => ({
        Sid: `Read${component === "web" ? "Web" : "Worker"}RuntimeSecret`,
        Effect: "Allow",
        Principal: "*",
        Action: "secretsmanager:GetSecretValue",
        Resource: canaryArn(component),
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": `arn:aws:iam::${account}:role/wallie-staging-${component}-execution`,
          },
          ...endpointCondition,
        },
      })),
    }),
  };
  plan.network.endpoints.VpcEndpoints.push(secretEndpoint);
  return { ...plan, secretInjection };
}

describe("private canary secret-injection qualification", () => {
  it.each(["web", "worker"])(
    "pins only the %s canary key and version in its distinct smoke definition",
    (component) => {
      const plan = helper.validateManifest(injectionFixture(), now);
      const definition = helper.taskDefinition(plan, component);
      const containers = definition.containerDefinitions as Data[];
      expect(definition.family).toBe(`wallie-staging-${component}-secret-injection-smoke`);
      expect(containers[0].secrets).toEqual([
        {
          name: "WALLIE_SMOKE_CANARY",
          valueFrom: `${canaryArn(component)}:WALLIE_SMOKE_CANARY::${runId}`,
        },
      ]);
      expect(containers[0].environment).toBeUndefined();
      expect(definition.taskRoleArn).toBeUndefined();
      const { definitions, snapshots } = evidence(injectionFixture(), component);
      const request = helper.runInput(plan, component, 0, definitions);
      expect(request.clientToken).toBe(`${runId}-${component}-0-secret`);
      expect(request.startedBy).toBe(`wi-${runId}`);
      expect(request.group).toBe("wallie-private-secret-smoke");
      const result = helper.verifyResult(plan, component, 0, definitions, snapshots, now);
      expect(result).toMatchObject({
        status: "offline-secret-injection-evidence-matches",
        qualification: "non-sensitive-canary-injection-only",
        secretArn: canaryArn(component),
        versionId: runId,
        deployable: false,
      });
      expect(result.logStream).toContain(`wallie-secret-smoke-${runId}/`);
      expect(JSON.stringify(result)).not.toContain(`wallie-smoke:${component}:${runId}`);
      const policy = helper.smokePolicy(plan, definitions);
      expect(JSON.stringify(policy)).toContain(
        '"aws:RequestTag/Component":"private-secret-injection-smoke"',
      );
      expect(JSON.stringify(policy)).toContain(`wallie-secret-smoke-${runId}/smoke/*`);
      expect(JSON.stringify(policy)).not.toMatch(/secretsmanager:|PutSecretValue|GetSecretValue/);
    },
  );

  it.each([
    undefined,
    "wrong-canary-must-not-be-printed",
    `wallie-smoke:worker:${runId}`,
    `wallie-smoke:web:${"2".repeat(32)}`,
  ])("rejects missing or wrong injected data without printing it (%j)", (value) => {
    const definition = helper.taskDefinition(injectionFixture(), "web");
    const container = (definition.containerDefinitions as Data[])[0];
    const program = (container.command as string[])[1];
    const logs: unknown[] = [];
    const env = { WALLIE_SMOKE_CANARY: value };
    expect(() =>
      runInNewContext(
        program,
        {
          process: {
            platform: "linux",
            arch: "x64",
            env,
            exit: (code: number) => {
              throw new Error(`exit ${code}`);
            },
          },
          console: { log: (message: unknown) => logs.push(message) },
          setTimeout: () => {
            throw new Error("Timer must not start on failed injection");
          },
        },
        { timeout: 1000 },
      ),
    ).toThrow("exit 71");
    expect(logs).toEqual([]);
  });

  it("checks then deletes the canary environment value and prints only two fixed markers", () => {
    const definition = helper.taskDefinition(injectionFixture(), "web");
    const program = ((definition.containerDefinitions as Data[])[0].command as string[])[1];
    const env: Record<string, string> = { WALLIE_SMOKE_CANARY: `wallie-smoke:web:${runId}` };
    const logs: string[] = [];
    runInNewContext(
      program,
      {
        process: {
          platform: "linux",
          arch: "x64",
          env,
          exit: () => {
            throw new Error("Unexpected exit");
          },
        },
        console: { log: (message: string) => logs.push(message) },
        setTimeout: (callback: () => void, duration: number) => {
          expect(duration).toBe(60_000);
          callback();
        },
      },
      { timeout: 1000 },
    );
    expect(env).toEqual({});
    expect(logs.map((message) => JSON.parse(message))).toEqual(
      ["started", "completed"].map((phase) => ({
        kind: "wallie-secret-injection-smoke",
        run: runId,
        component: "web",
        phase,
      })),
    );
    expect(logs.join()).not.toContain("wallie-smoke:web:");
  });

  it.each([
    ["secretInjection", null],
    ["secretInjection", false],
    ["secretInjection.web.secretArn", canaryArn("worker")],
    ["secretInjection.web.secretArn", canaryArn("web").replace(account, "999999999999")],
    ["secretInjection.web.secretArn", canaryArn("web").replace(region, "us-east-1")],
    ["secretInjection.web.secretArn", canaryArn("web").replace("Ab12Cd", "??????")],
    ["secretInjection.web.secretArn", `${canaryArn("web")}:WALLIE_SMOKE_CANARY::${runId}`],
    ["secretInjection.web.versionId", "2".repeat(32)],
    ["secretInjection.web.expectedValue", "must-not-be-accepted"],
    ["secretInjection.web.secret.requestStartedAt", "2026-09-22T11:40:00Z"],
    ["secretInjection.web.versions.capturedAt", "2026-09-22T12:01:00Z"],
    ["secretInjection.web.secret.response.KmsKeyId", "custom-key"],
    ["secretInjection.web.secret.response.RotationEnabled", true],
    ["secretInjection.web.secret.response.RotationEnabled", null],
    ["secretInjection.web.secret.response.RotationRules", null],
    ["secretInjection.web.secret.response.DeletedDate", createdAt],
    ["secretInjection.web.secret.response.ReplicationStatus", [{ Region: "us-east-1" }]],
    ["secretInjection.web.secret.response.Tags", []],
    [
      "secretInjection.web.secret.response.VersionIdsToStages",
      { [runId]: ["AWSCURRENT", "AWSPENDING"] },
    ],
    ["secretInjection.web.secret.response.SecretString", "must-not-be-printed"],
    ["secretInjection.web.resourcePolicy.response.ResourcePolicy", "{}"],
    ["secretInjection.web.resourcePolicy.response.SecretBinary", null],
    ["secretInjection.web.versions.response.SecretString", "must-not-be-printed"],
    ["secretInjection.web.versions.response.Versions.0.SecretBinary", ""],
    ["secretInjection.web.versions.response.Versions.0.KmsKeyIds", null],
    ["secretInjection.web.versions.request.IncludeDeprecated", false],
    ["secretInjection.web.versions.request.IncludeDeprecated", undefined],
    ["secretInjection.web.versions.request.SecretId", canaryArn("worker")],
    ["secretInjection.web.versions.response.NextToken", "more"],
    ["secretInjection.web.versions.response.Versions", []],
    [
      "secretInjection.web.versions.response.Versions",
      [
        { VersionId: runId, VersionStages: ["AWSCURRENT"], CreatedDate: createdAt },
        { VersionId: "2".repeat(32), VersionStages: [], CreatedDate: createdAt },
      ],
    ],
    ["secretInjection.web.versions.response.Versions.0.VersionId", "2".repeat(32)],
    ["secretInjection.web.versions.response.Versions.0.VersionStages", ["AWSPREVIOUS"]],
    ["network.endpoints.VpcEndpoints.4.PrivateDnsEnabled", false],
    ["network.endpoints.VpcEndpoints.4.VpcEndpointId", "vpce-invalid"],
    ["network.endpoints.VpcEndpoints.4.VpcEndpointId", s3Id],
    ["network.endpoints.VpcEndpoints.4.Tags", []],
    ["network.endpoints.VpcEndpoints.4.Tags.0.Value", "OtherProject"],
    ["network.endpoints.VpcEndpoints.4.Groups.0.GroupId", taskSg],
    ["network.endpoints.VpcEndpoints.4.SubnetIds", [subnetIds[0]]],
    [
      "network.endpoints.VpcEndpoints.4.PolicyDocument",
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "secretsmanager:GetSecretValue",
            Principal: "*",
            Resource: "*",
          },
        ],
      }),
    ],
  ])("rejects canary metadata or endpoint drift at %s", (path, replacement) => {
    const plan = injectionFixture();
    setAt(plan, path as string, replacement);
    expect(() => helper.validateManifest(plan, now)).toThrow();
  });

  it("keeps the four-endpoint connectivity gate separate from secret injection", () => {
    const plan = injectionFixture();
    const { secretInjection: _secretInjection, ...withoutOptIn } = plan;
    void _secretInjection;
    expect(() => helper.validateManifest(withoutOptIn, now)).toThrow(/endpoints/);
    plan.network.endpoints.VpcEndpoints.pop();
    expect(() => helper.validateManifest(plan, now)).toThrow(/endpoints/);
  });

  it("accepts only harmless optional secret metadata representations without altering evidence", () => {
    const plan = injectionFixture();
    setAt(plan, "secretInjection.web.secret.response.RotationEnabled", false);
    setAt(plan, "secretInjection.web.secret.response.RotationRules", {});
    setAt(plan, "secretInjection.web.secret.response.ReplicationStatus", []);
    setAt(plan, "secretInjection.web.versions.response.Versions.0.KmsKeyIds", []);
    const original = structuredClone(plan);
    expect(helper.validateManifest(plan, now)).toEqual(plan);
    expect(plan).toEqual(original);
  });

  it("rejects removed, remapped, or plaintext canary injection in registered definitions", () => {
    for (const [path, value] of [
      ["secrets", []],
      ["secrets.0.name", "SUPABASE_SECRET_KEY"],
      ["secrets.0.valueFrom", `${canaryArn("web")}:WALLIE_SMOKE_CANARY:AWSCURRENT:`],
      ["environment", [{ name: "WALLIE_SMOKE_CANARY", value: `wallie-smoke:web:${runId}` }]],
    ] as [string, unknown][]) {
      const plan = injectionFixture();
      const definitions = registered(plan);
      setAt(definitions.web, `taskDefinition.containerDefinitions.0.${path}`, value);
      expect(() => helper.verifyDefinition(plan, "web", definitions.web)).toThrow(
        /complete task definition/,
      );
    }
  });

  it("rejects connectivity-only logs and late secret qualification even in retrospective checks", () => {
    const plan = injectionFixture();
    const { definitions, snapshots } = evidence(plan);
    snapshots.logs[0].response.events[0].message =
      snapshots.logs[0].response.events[0].message.replace(
        "wallie-secret-injection-smoke",
        "wallie-private-smoke",
      );
    expect(() => helper.verifyResult(plan, "web", 0, definitions, snapshots, now)).toThrow(
      /log markers/,
    );
    const fresh = evidence(plan);
    setAt(plan, "secretInjection.web.versions.requestStartedAt", "2026-09-22T11:40:00Z");
    expect(() =>
      helper.verifyResult(plan, "web", 0, fresh.definitions, fresh.snapshots, now + 60 * 60_000),
    ).toThrow(/qualification window/);
  });
});

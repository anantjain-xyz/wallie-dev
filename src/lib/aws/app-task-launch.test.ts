import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-app-task-launch.mjs", import.meta.url),
);
const definitionsScript = fileURLToPath(
  new URL("../../../scripts/prepare-aws-app-task-definition.mjs", import.meta.url),
);
const { registrationPolicy, runPolicy, runInput, verifyDefinition } = await import(
  new URL(`file://${script}`).href
);
const { taskDefinition } = await import(new URL(`file://${definitionsScript}`).href);

const account = "123456789012";
const region = "us-west-2";
const now = Date.parse("2026-09-22T20:00:00Z");
const expires = "2026-09-22T22:00:00Z";
const runId = "a".repeat(32);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function manifest() {
  return {
    schemaVersion: 1,
    account,
    region,
    existingWallieSupabaseUrl: "https://production.supabase.co",
    publicConfig: {
      NEXT_PUBLIC_APP_URL: "https://staging.wallie.dev",
      NEXT_PUBLIC_SUPABASE_URL: "https://isolated-staging.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_staging_public",
    },
    images: { web: `sha256:${"a".repeat(64)}`, worker: `sha256:${"b".repeat(64)}` },
    runtimeSecrets: {
      web: {
        arn: `arn:aws:secretsmanager:${region}:${account}:secret:/wallie/staging/web/runtime-AbC123`,
        versionId: "c".repeat(32),
      },
      worker: {
        arn: `arn:aws:secretsmanager:${region}:${account}:secret:/wallie/staging/worker/runtime-AbC123`,
        versionId: "d".repeat(32),
      },
    },
  };
}

function readbacks(input = manifest()) {
  return Object.fromEntries(
    (["web", "worker"] as const).map((component, index) => {
      const { tags, ...definition } = taskDefinition(input, component);
      return [
        component,
        {
          taskDefinition: {
            ...definition,
            taskDefinitionArn: `arn:aws:ecs:${region}:${account}:task-definition/wallie-staging-${component}-app:${index + 1}`,
            revision: index + 1,
            status: "ACTIVE",
            registeredAt: "2026-09-22T20:01:00Z",
            registeredBy: `arn:aws:iam::${account}:user/wallie-local`,
            requiresAttributes: [],
            compatibilities: ["FARGATE"],
            volumes: [],
            placementConstraints: [],
            ephemeralStorage: { sizeInGiB: 20 },
            enableFaultInjection: false,
            containerDefinitions: [
              {
                ...definition.containerDefinitions[0],
                cpu: 0,
                privileged: false,
                environmentFiles: [],
                mountPoints: [],
                ...(component === "worker" ? { portMappings: [] } : {}),
                versionConsistency: "enabled",
              },
            ],
          },
          tags,
        },
      ];
    }),
  );
}

function network() {
  return {
    runtime_https_egress: {
      value: {
        services_subnet_id: "subnet-12345678",
        task_security_group_ids: ["sg-12345678", "sg-abcdef12"],
      },
    },
    subnets: { value: { "services-a": { id: "subnet-12345678" } } },
    application_connectivity: { value: { task_security_group_id: "sg-12345678" } },
  };
}

describe("one-off application task launch grant", () => {
  it("registers only two exact families, bounded resources, and reviewed execution roles", () => {
    const result = registrationPolicy(manifest(), expires, now);
    const registrations = result.Statement.filter(
      (item: { Action: string }) => item.Action === "ecs:RegisterTaskDefinition",
    );
    expect(registrations.map((item: { Resource: string }) => item.Resource)).toEqual([
      `arn:aws:ecs:${region}:${account}:task-definition/wallie-staging-web-app:*`,
      `arn:aws:ecs:${region}:${account}:task-definition/wallie-staging-worker-app:*`,
    ]);
    for (const statement of registrations) {
      expect(statement.Condition.NumericEquals).toEqual({
        "ecs:task-cpu": 512,
        "ecs:task-memory": 1024,
      });
      expect(statement.Condition["ForAnyValue:StringEquals"]).toEqual({
        "ecs:compute-compatibility": "FARGATE",
      });
      expect(statement.Condition.DateLessThan["aws:CurrentTime"]).toBe(expires);
    }
    const pass = result.Statement.find(
      (item: { Action: string }) => item.Action === "iam:PassRole",
    );
    expect(pass.Resource).toEqual([
      `arn:aws:iam::${account}:role/wallie-staging-web-execution`,
      `arn:aws:iam::${account}:role/wallie-staging-worker-execution`,
    ]);
    expect(pass.Condition.StringEquals["iam:PassedToService"]).toBe("ecs-tasks.amazonaws.com");
    const tagRead = result.Statement.find(
      (item: { Sid: string }) => item.Sid === "ReadApplicationDefinitionTags",
    );
    expect(tagRead.Action).toBe("ecs:ListTagsForResource");
    expect(tagRead.Resource).toEqual([
      `arn:aws:ecs:${region}:${account}:task-definition/wallie-staging-web-app:*`,
      `arn:aws:ecs:${region}:${account}:task-definition/wallie-staging-worker-app:*`,
    ]);
    expect(tagRead.Condition).toEqual({
      StringEquals: { "aws:PrincipalAccount": account, "aws:RequestedRegion": region },
      DateLessThan: { "aws:CurrentTime": expires },
    });
    const actions = JSON.stringify(result.Statement.map((item: { Action: string }) => item.Action));
    expect(actions).not.toMatch(/RunTask|StopTask|GetSecretValue|CreateService|ExecuteCommand/);
    expect(JSON.stringify(result).length).toBeLessThan(6145);
  });

  it("requires exact, unmodified readbacks before granting only those revisions", () => {
    const input = manifest();
    const definitions = readbacks(input);
    expect(verifyDefinition(input, "web", definitions.web)).toBe(
      `arn:aws:ecs:${region}:${account}:task-definition/wallie-staging-web-app:1`,
    );
    expect(definitions.worker.taskDefinition.containerDefinitions[0].portMappings).toEqual([]);
    expect(verifyDefinition(input, "worker", definitions.worker)).toBe(
      `arn:aws:ecs:${region}:${account}:task-definition/wallie-staging-worker-app:2`,
    );
    const result = runPolicy(input, definitions, runId, expires, now);
    const launches = result.Statement.filter(
      (item: { Action: string }) => item.Action === "ecs:RunTask",
    );
    expect(launches.map((item: { Resource: string }) => item.Resource)).toEqual([
      `arn:aws:ecs:${region}:${account}:task-definition/wallie-staging-web-app:1`,
      `arn:aws:ecs:${region}:${account}:task-definition/wallie-staging-worker-app:2`,
    ]);
    for (const launch of launches) {
      expect(launch.Condition.ArnEquals["ecs:cluster"]).toBe(
        `arn:aws:ecs:${region}:${account}:cluster/wallie-staging`,
      );
      expect(launch.Condition.StringEquals["aws:RequestTag/WallieRun"]).toBe(runId);
      expect(launch.Condition.StringEquals["ecs:enable-execute-command"]).toBe("false");
      expect(launch.Condition.StringEqualsIfExists["ecs:enable-ebs-volumes"]).toBe("false");
      expect(launch.Condition).not.toHaveProperty("Bool");
      expect(launch.Condition).not.toHaveProperty("BoolIfExists");
    }
    const tagWrites = result.Statement.filter(
      (item: { Action: string }) => item.Action === "ecs:TagResource",
    );
    expect(
      tagWrites.map(
        (item: { Condition: { StringEquals: Record<string, string> } }) =>
          item.Condition.StringEquals["aws:RequestTag/Name"],
      ),
    ).toEqual(["wallie-staging-web-app", "wallie-staging-worker-app"]);
    expect(
      tagWrites.every(
        (item: { Condition: { StringEquals: Record<string, string> } }) =>
          item.Condition.StringEquals["ecs:CreateAction"] === "RunTask",
      ),
    ).toBe(true);
    const stop = result.Statement.find(
      (item: { Sid: string }) => item.Sid === "InspectAndStopThisRun",
    );
    expect(stop.Condition.StringEquals["aws:ResourceTag/WallieRun"]).toBe(runId);
    expect(stop.Resource).toBe(`arn:aws:ecs:${region}:${account}:task/wallie-staging/*`);
    expect(
      JSON.stringify(result.Statement.map((item: { Action: string }) => item.Action)),
    ).not.toMatch(/RegisterTaskDefinition|CreateService|ExecuteCommand|DeregisterTaskDefinition/);
    expect(JSON.stringify(result).length).toBeLessThan(6145);
  });

  it("rejects altered definition content and tags before producing a run grant", () => {
    const changes = [
      (value: ReturnType<typeof readbacks>) => {
        value.web.taskDefinition.taskRoleArn = `arn:aws:iam::${account}:role/admin`;
      },
      (value: ReturnType<typeof readbacks>) => {
        value.web.taskDefinition.containerDefinitions[0].image = "attacker/image:latest";
      },
      (value: ReturnType<typeof readbacks>) => {
        value.worker.taskDefinition.containerDefinitions[0].secrets[0].valueFrom = "another-secret";
      },
      (value: ReturnType<typeof readbacks>) => {
        value.worker.taskDefinition.containerDefinitions[0].environment.push({
          name: "SUPABASE_SECRET_KEY",
          value: "leaked",
        });
      },
      (value: ReturnType<typeof readbacks>) => {
        value.web.tags[0].value = "Other";
      },
      (value: ReturnType<typeof readbacks>) => {
        value.web.taskDefinition.taskDefinitionArn = `arn:aws:ecs:${region}:${account}:task-definition/wallie-staging-web-app:99`;
      },
      (value: ReturnType<typeof readbacks>) => {
        Object.assign(value.worker.taskDefinition.containerDefinitions[0], {
          portMappings: [{ containerPort: 9999, hostPort: 9999, protocol: "tcp" }],
        });
      },
    ];
    for (const change of changes) {
      const definitions = readbacks();
      change(definitions);
      expect(() => runPolicy(manifest(), definitions, runId, expires, now)).toThrow();
    }
  });

  it("renders one private, idempotent Fargate task and rejects stale network selectors", () => {
    const input = manifest();
    const definitions = readbacks(input);
    const request = runInput(input, definitions, network(), "web", runId);
    expect(request).toMatchObject({
      cluster: `arn:aws:ecs:${region}:${account}:cluster/wallie-staging`,
      taskDefinition: `arn:aws:ecs:${region}:${account}:task-definition/wallie-staging-web-app:1`,
      launchType: "FARGATE",
      platformVersion: "1.4.0",
      count: 1,
      clientToken: `${runId}-web`,
      enableExecuteCommand: false,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ["subnet-12345678"],
          securityGroups: ["sg-12345678", "sg-abcdef12"],
          assignPublicIp: "DISABLED",
        },
      },
    });
    expect(request).not.toHaveProperty("overrides");
    expect(request.tags).toContainEqual({ key: "WallieRun", value: runId });
    const noEgress = network();
    Object.assign(noEgress.runtime_https_egress, { value: null });
    expect(() => runInput(input, definitions, noEgress, "web", runId)).toThrow();
    const wrongSubnet = network();
    wrongSubnet.runtime_https_egress.value.services_subnet_id = "subnet-deadbeef";
    expect(() => runInput(input, definitions, wrongSubnet, "web", runId)).toThrow();
    const oneGroup = network();
    oneGroup.runtime_https_egress.value.task_security_group_ids = ["sg-12345678"];
    expect(() => runInput(input, definitions, oneGroup, "web", runId)).toThrow();
  });

  it("rejects expired grants and ambiguous CLI calls without exposing file contents", () => {
    expect(() => registrationPolicy(manifest(), "2026-09-22T20:05:00Z", now)).toThrow();
    expect(() => runPolicy(manifest(), readbacks(), runId, "2026-09-23T20:00:01Z", now)).toThrow();
    const dir = mkdtempSync(join(tmpdir(), "wallie-app-launch-"));
    dirs.push(dir);
    const path = join(dir, "manifest.json");
    writeFileSync(path, JSON.stringify(manifest()));
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        timeout: 5_000,
        env: { NODE_ENV: "test", PATH: "", AWS_ACCESS_KEY_ID: "ambient-must-not-be-used" },
      });
    const invalid = run(
      "register-policy",
      "--manifest",
      path,
      "--expires-at",
      expires,
      "--manifest",
      path,
    );
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).not.toContain("ambient-must-not-be-used");
    writeFileSync(path, '{"token":"sb_secret_must-not-leak",');
    const malformed = run("register-policy", "--manifest", path, "--expires-at", expires);
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).not.toContain("sb_secret_must-not-leak");
  });
});

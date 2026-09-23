import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-app-task-definition.mjs", import.meta.url),
);
const { taskDefinition, validateManifest } = await import(new URL(`file://${script}`).href);
const account = "123456789012";
const region = "us-west-2";
const arn = (component: string) =>
  `arn:aws:secretsmanager:${region}:${account}:secret:/wallie/staging/${component}/runtime-AbC123`;
const versionIds = { web: "a".repeat(32), worker: "b".repeat(32) };

function fixture() {
  return {
    schemaVersion: 1,
    account,
    region,
    existingWallieSupabaseUrl: "https://production.supabase.co",
    publicConfig: {
      NEXT_PUBLIC_APP_URL: "https://staging.wallie.dev",
      NEXT_PUBLIC_SUPABASE_URL: "https://supabase.staging.wallie.dev",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_staging_public",
    },
    images: { web: `sha256:${"a".repeat(64)}`, worker: `sha256:${"b".repeat(64)}` },
    runtimeSecrets: {
      web: { arn: arn("web"), versionId: versionIds.web },
      worker: { arn: arn("worker"), versionId: versionIds.worker },
    },
  };
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("real one-off AWS app task definitions", () => {
  it("renders a real web image with a local HTTP + read-only Supabase health check", () => {
    const manifest = fixture();
    const definition = taskDefinition(manifest, "web");
    expect(definition).toMatchObject({
      family: "wallie-staging-web-app",
      executionRoleArn: `arn:aws:iam::${account}:role/wallie-staging-web-execution`,
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: "512",
      memory: "1024",
      runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
    });
    expect(definition).not.toHaveProperty("taskRoleArn");
    const container = definition.containerDefinitions[0];
    expect(container).toMatchObject({
      name: "web",
      image: `${account}.dkr.ecr.${region}.amazonaws.com/wallie-staging/web@${manifest.images.web}`,
      user: "1000:1000",
      readonlyRootFilesystem: false,
      stopTimeout: 120,
      portMappings: [{ containerPort: 3000, hostPort: 3000, protocol: "tcp" }],
      logConfiguration: {
        logDriver: "awslogs",
        options: { "awslogs-group": "/wallie/staging/web", mode: "blocking" },
      },
    });
    expect(container).not.toHaveProperty("entryPoint");
    expect(container).not.toHaveProperty("command");
    expect(container.environment).toEqual([
      { name: "NEXT_PUBLIC_APP_URL", value: "https://staging.wallie.dev" },
      { name: "NEXT_PUBLIC_SUPABASE_URL", value: "https://supabase.staging.wallie.dev" },
      { name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", value: "sb_publishable_staging_public" },
      { name: "WALLIE_DEPLOY_ENV", value: "production" },
    ]);
    expect(container.secrets).toEqual(
      ["SUPABASE_SECRET_KEY", "WALLIE_ENCRYPTION_KEY"].map((name) => ({
        name,
        valueFrom: `${arn("web")}:${name}::${versionIds.web}`,
      })),
    );
    expect(container.healthCheck).toMatchObject({
      command: ["CMD", "node", "--input-type=module", "--eval", expect.any(String)],
    });
    const program = container.healthCheck.command[4];
    expect(program).toContain("http://127.0.0.1:3000/favicon.ico");
    expect(program).toContain('from("worker_heartbeats").select("worker_id").limit(1)');
    expect(program).not.toContain("console.");
    expect(JSON.stringify(definition)).not.toContain("production.supabase.co");
  });

  it("renders an idle-first worker using its own secret and log group", () => {
    const definition = taskDefinition(fixture(), "worker");
    expect(definition.family).toBe("wallie-staging-worker-app");
    expect(definition.executionRoleArn).toContain("wallie-staging-worker-execution");
    expect(definition).not.toHaveProperty("taskRoleArn");
    const container = definition.containerDefinitions[0];
    expect(container).not.toHaveProperty("portMappings");
    expect(container).not.toHaveProperty("healthCheck");
    expect(container).not.toHaveProperty("command");
    expect(container.environment).toContainEqual({
      name: "WORKER_MAX_CONCURRENT_JOBS",
      value: "1",
    });
    expect(container.logConfiguration.options["awslogs-group"]).toBe("/wallie/staging/worker");
    expect(container.secrets.map((entry: { valueFrom: string }) => entry.valueFrom)).toEqual([
      `${arn("worker")}:SUPABASE_SECRET_KEY::${versionIds.worker}`,
      `${arn("worker")}:WALLIE_ENCRYPTION_KEY::${versionIds.worker}`,
    ]);
  });

  it("preserves a reviewed AWS version ID containing an underscore", () => {
    const manifest = fixture();
    manifest.runtimeSecrets.web.versionId = `${"a".repeat(31)}_`;
    const definition = taskDefinition(manifest, "web");
    expect(definition.containerDefinitions[0].secrets[0].valueFrom).toBe(
      `${arn("web")}:SUPABASE_SECRET_KEY::${manifest.runtimeSecrets.web.versionId}`,
    );
  });

  it("rejects production reuse, arbitrary environment fields, foreign secrets, and unpinned images", () => {
    const cases: Array<(input: ReturnType<typeof fixture>) => void> = [
      (input) => {
        input.publicConfig.NEXT_PUBLIC_SUPABASE_URL = input.existingWallieSupabaseUrl;
      },
      (input) => {
        input.publicConfig.NEXT_PUBLIC_APP_URL = "https://wallie.dev";
      },
      (input) => {
        input.publicConfig.NEXT_PUBLIC_APP_URL = "https://wallie.dev.";
      },
      (input) => {
        input.publicConfig.NEXT_PUBLIC_SUPABASE_URL = "https://production.supabase.co.";
      },
      (input) => {
        input.publicConfig.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.staging.wallie.dev:8443";
      },
      (input) => {
        input.publicConfig.NEXT_PUBLIC_SUPABASE_URL = "https://isolated-staging.supabase.co";
      },
      (input) => {
        Object.assign(input.publicConfig, { SUPABASE_SECRET_KEY: "must-not-enter" });
      },
      (input) => {
        input.runtimeSecrets.web.arn = arn("worker");
      },
      (input) => {
        input.runtimeSecrets.worker.versionId = "AWSCURRENT";
      },
      (input) => {
        input.images.web = "wallie-staging/web:latest";
      },
      (input) => {
        input.publicConfig.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_secret_private";
      },
      (input) => {
        input.publicConfig.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_";
      },
      (input) => {
        input.publicConfig.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "eyJlegacy-service-role-token";
      },
    ];
    for (const change of cases) {
      const input = fixture();
      change(input);
      expect(() => validateManifest(input)).toThrow();
    }
  });

  it("reads a strict metadata-only file and needs no ambient AWS credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "wallie-app-task-test-"));
    directories.push(directory);
    const path = join(directory, "manifest.json");
    writeFileSync(path, JSON.stringify(fixture()));
    const run = (...extra: string[]) =>
      spawnSync(process.execPath, [script, "--manifest", path, "--component", "web", ...extra], {
        encoding: "utf8",
        timeout: 5_000,
        env: { NODE_ENV: "test", PATH: "", AWS_ACCESS_KEY_ID: "ambient-must-not-be-used" },
      });
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).family).toBe("wallie-staging-web-app");
    expect(result.stdout).not.toContain("ambient-must-not-be-used");
    expect(run("--component", "worker").status).not.toBe(0);

    const link = join(directory, "linked.json");
    symlinkSync(path, link);
    const linked = spawnSync(process.execPath, [script, "--manifest", link, "--component", "web"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(linked.status).not.toBe(0);
    expect(linked.stderr).toContain("regular manifest file");

    writeFileSync(path, '{"credential":"sb_secret_must-not-leak",');
    const malformed = run();
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain("Invalid manifest JSON");
    expect(malformed.stderr).not.toContain("sb_secret_must-not-leak");
  });
});

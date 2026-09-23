import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/prepare-aws-app-task-definition.mjs --manifest <private JSON file> --component web|worker";
const components = ["web", "worker"];
const envNames = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
];
const secretNames = ["SUPABASE_SECRET_KEY", "WALLIE_ENCRYPTION_KEY"];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, name) {
  check(value && typeof value === "object" && !Array.isArray(value), `Invalid ${name}`);
  check(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
    `Unexpected ${name} fields`,
  );
}

function httpsOrigin(value, name) {
  check(typeof value === "string" && value === value.trim(), `Invalid ${name}`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}`);
  }
  check(url.protocol === "https:" && url.origin === value, `Expected an HTTPS origin for ${name}`);
  check(!url.hostname.endsWith("."), `Trailing-dot hostnames are not allowed for ${name}`);
  return url;
}

export function validateManifest(input) {
  exactKeys(
    input,
    [
      "schemaVersion",
      "account",
      "region",
      "existingWallieSupabaseUrl",
      "publicConfig",
      "images",
      "runtimeSecrets",
    ],
    "manifest",
  );
  check(input.schemaVersion === 1, "Unsupported manifest schemaVersion");
  check(/^\d{12}$/.test(input.account), "Invalid AWS account");
  check(/^(?!cn-|us-gov-)[a-z]{2}-[a-z]+-\d+$/.test(input.region), "Invalid commercial AWS region");
  exactKeys(input.publicConfig, envNames, "public configuration");
  const appUrl = httpsOrigin(input.publicConfig.NEXT_PUBLIC_APP_URL, "NEXT_PUBLIC_APP_URL");
  check(
    !["wallie.dev", "www.wallie.dev"].includes(appUrl.hostname),
    "Use a separate staging app origin",
  );
  const supabaseUrl = httpsOrigin(
    input.publicConfig.NEXT_PUBLIC_SUPABASE_URL,
    "NEXT_PUBLIC_SUPABASE_URL",
  );
  check(supabaseUrl.port === "", "Staging Supabase must use HTTPS port 443");
  check(
    supabaseUrl.hostname !== "supabase.co" && !supabaseUrl.hostname.endsWith(".supabase.co"),
    "Use the self-hosted staging Supabase HTTPS origin, not a Supabase Cloud project",
  );
  const existingUrl = httpsOrigin(input.existingWallieSupabaseUrl, "existingWallieSupabaseUrl");
  check(
    supabaseUrl.origin !== existingUrl.origin,
    "Staging Supabase must differ from existing Wallie Supabase",
  );
  const publicKey = input.publicConfig.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  check(
    typeof publicKey === "string" &&
      publicKey.startsWith("sb_publishable_") &&
      publicKey.length > "sb_publishable_".length &&
      publicKey.length <= 4096 &&
      publicKey === publicKey.trim() &&
      !/\s/.test(publicKey),
    "Invalid Supabase publishable key",
  );
  exactKeys(input.images, components, "images");
  exactKeys(input.runtimeSecrets, components, "runtime secrets");
  for (const component of components) {
    check(
      /^sha256:[0-9a-f]{64}$/.test(input.images[component]),
      `Invalid ${component} image digest`,
    );
    const secret = input.runtimeSecrets[component];
    exactKeys(secret, ["arn", "versionId"], `${component} runtime secret`);
    check(
      new RegExp(
        `^arn:aws:secretsmanager:${input.region}:${input.account}:secret:/wallie/staging/${component}/runtime-[A-Za-z0-9]{6}$`,
      ).test(secret.arn),
      `Invalid own-component ${component} runtime secret ARN`,
    );
    check(
      /^[A-Za-z0-9_-]{32,64}$/.test(secret.versionId),
      `Invalid ${component} runtime secret version ID`,
    );
  }
  return input;
}

// This proves the one real web container serves HTTP and can read the isolated
// Supabase Data API. It logs neither credentials nor database rows.
const webHealthProgram = `import { createClient } from "@supabase/supabase-js";
try {
  const response = await fetch("http://127.0.0.1:3000/favicon.ico", { signal: AbortSignal.timeout(4000) });
  if (!response.ok) process.exit(1);
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { error } = await admin.from("worker_heartbeats").select("worker_id").limit(1);
  if (error) process.exit(1);
} catch {
  process.exit(1);
}`;

export function taskDefinition(rawManifest, component) {
  const manifest = validateManifest(rawManifest);
  check(components.includes(component), "Expected web or worker component");
  const { account, region } = manifest;
  const family = `wallie-staging-${component}-app`;
  const secret = manifest.runtimeSecrets[component];
  return {
    family,
    executionRoleArn: `arn:aws:iam::${account}:role/wallie-staging-${component}-execution`,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "512",
    memory: "1024",
    runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
    containerDefinitions: [
      {
        name: component,
        image: `${account}.dkr.ecr.${region}.amazonaws.com/wallie-staging/${component}@${manifest.images[component]}`,
        user: "1000:1000",
        essential: true,
        readonlyRootFilesystem: false,
        stopTimeout: 120,
        linuxParameters: { capabilities: { drop: ["ALL"] } },
        environment: [
          ...envNames.map((name) => ({ name, value: manifest.publicConfig[name] })),
          { name: "WALLIE_DEPLOY_ENV", value: "production" },
          ...(component === "worker" ? [{ name: "WORKER_MAX_CONCURRENT_JOBS", value: "1" }] : []),
        ],
        secrets: secretNames.map((name) => ({
          name,
          valueFrom: `${secret.arn}:${name}::${secret.versionId}`,
        })),
        ...(component === "web"
          ? {
              portMappings: [{ containerPort: 3000, hostPort: 3000, protocol: "tcp" }],
              healthCheck: {
                command: ["CMD", "node", "--input-type=module", "--eval", webHealthProgram],
                interval: 30,
                timeout: 10,
                retries: 3,
                startPeriod: 90,
              },
            }
          : {}),
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": `/wallie/staging/${component}`,
            "awslogs-region": region,
            "awslogs-stream-prefix": "app",
            mode: "blocking",
          },
        },
      },
    ],
    tags: Object.entries({
      Project: "Wallie",
      Environment: "staging",
      ManagedBy: "ManualQualification",
      Component: "application-task",
      WallieStack: "wallie-staging-application",
      Name: family,
    }).map(([key, value]) => ({ key, value })),
  };
}

function readManifest(path) {
  const info = lstatSync(path);
  check(info.isFile() && info.size <= 16384, "Expected a regular manifest file at most 16 KiB");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Invalid manifest JSON");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals, tokens } = parseArgs({
      allowPositionals: true,
      tokens: true,
      options: { manifest: { type: "string" }, component: { type: "string" } },
    });
    check(
      positionals.length === 0 &&
        tokens.filter((token) => token.kind === "option").length === 2 &&
        Object.keys(values).length === 2 &&
        typeof values.manifest === "string" &&
        values.manifest.length > 0,
      usage,
    );
    console.log(
      JSON.stringify(taskDefinition(readManifest(values.manifest), values.component), null, 2),
    );
  } catch (error) {
    console.error(`[aws-app-task-definition] ${error instanceof Error ? error.message : usage}`);
    process.exitCode = 1;
  }
}

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const platform = "linux/amd64";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const imageManifestTypes = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];
const severityNames = ["INFORMATIONAL", "LOW", "MEDIUM", "HIGH", "CRITICAL", "UNDEFINED"];
const usage =
  "Usage: node scripts/publish-aws-image.mjs --component web|worker --account-id <12 digits> --region <region> --revision <full Git SHA> [--profile <temporary-login profile>]";

export function parsePublishArgs(args, env = process.env) {
  const { values, tokens } = parseArgs({
    args,
    tokens: true,
    options: Object.fromEntries(
      ["component", "account-id", "region", "revision", "profile"].map((key) => [
        key,
        { type: "string" },
      ]),
    ),
  });
  const profile = values.profile ?? env.AWS_PROFILE;
  if (
    tokens.length !== Object.keys(values).length ||
    !["web", "worker"].includes(values.component) ||
    !/^\d{12}$/.test(values["account-id"] ?? "") ||
    !/^(?:[a-z]{2}-[a-z]+|us-gov-[a-z]+)-\d+$/.test(values.region ?? "") ||
    !/^[a-f0-9]{40}$/.test(values.revision ?? "") ||
    !/^[\w][\w.-]{0,127}$/.test(profile ?? "")
  )
    throw new Error(usage);
  return { ...values, profile };
}

/** No shell, inherited output, or raw credential-provider errors. */
export function runCommand(command, args, options = {}) {
  return new Promise((done, reject) => {
    if (options.signal?.aborted) return reject(new Error("Publishing interrupted"));
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let failure;
    let killTimer;
    const kill = (reason) => {
      failure = reason;
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => kill("timeout"), options.timeout ?? 120_000);
    const abort = () => {
      failure = "interrupted";
      child.kill("SIGTERM");
      killTimer = setTimeout(() => kill("interrupted"), 5_000);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length + stderr.length > 32 * 1024 * 1024) kill("output limit");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stdout.length + stderr.length > 32 * 1024 * 1024) kill("output limit");
    });
    child.on("error", (error) => {
      failure = error.code ?? "process error";
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (code === 0 && !failure) return done(stdout.trim());
      const awsCode = stderr.match(/\(([\w.-]+)\) when calling/)?.[1];
      reject(
        Object.assign(
          new Error(`${command} ${args[0]} failed (${awsCode ?? failure ?? `exit ${code}`})`),
          { awsCode },
        ),
      );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

const requireThat = (condition, message) => {
  if (!condition) throw new Error(message);
};
const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Command returned invalid JSON");
  }
};

export async function publishImage(options, dependencies = {}) {
  const run = dependencies.run ?? runCommand;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? sleep;
  const progress = dependencies.progress ?? (() => {});
  const env = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd();
  const nonce = randomUUID().replaceAll("-", "");
  const { component, region, revision, profile, "account-id": account } = options;
  const partition = region.startsWith("cn-")
    ? "aws-cn"
    : region.startsWith("us-gov-")
      ? "aws-us-gov"
      : "aws";
  const repository = `wallie-staging/${component}`;
  const registry = `${account}.dkr.ecr.${region}.${partition === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com"}`;
  const repositoryUrl = `${registry}/${repository}`;
  const repositoryArn = `arn:${partition}:ecr:${region}:${account}:repository/${repository}`;
  const tag = `${revision}-linux-amd64-${nonce}`;
  const reference = `${repositoryUrl}:${tag}`;
  const temporary = mkdtempSync(join(dependencies.tempRoot ?? tmpdir(), "wallie-image-publish-"));
  const source = join(temporary, "source");
  const dockerConfig = join(temporary, "docker");
  const common = { cwd, env, signal: dependencies.signal };
  let receipt;
  let receiptPath;
  const saveReceipt = () => {
    mkdirSync(join(receiptPath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  };
  try {
    progress("Checking reviewed source and registry");
    // Pin the source to a freshly fetched reviewed main history, not working-tree files.
    const origin = await run("git", ["remote", "get-url", "origin"], common);
    requireThat(
      [
        "https://github.com/anantjain-xyz/wallie-dev.git",
        "https://github.com/anantjain-xyz/wallie-dev",
        "git@github.com:anantjain-xyz/wallie-dev.git",
      ].includes(origin),
      "Origin must be the Wallie repository",
    );
    await run("git", ["fetch", "--no-tags", "origin", "main:refs/remotes/origin/main"], common);
    await run("git", ["merge-base", "--is-ancestor", revision, "refs/remotes/origin/main"], common);
    const root = await run("git", ["rev-parse", "--show-toplevel"], common);
    receiptPath = join(root, ".wallie", "aws", `image-${component}-${tag}.json`);

    const awsEnv = { ...env, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" };
    // Select the explicit login profile, never an ambient access-key credential pair.
    for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"])
      delete awsEnv[key];
    const aws = async (service, operation, args = [], raw = false) => {
      const output = await run(
        "aws",
        [
          service,
          operation,
          ...args,
          "--profile",
          profile,
          "--region",
          region,
          "--output",
          "json",
          "--no-cli-pager",
          "--no-cli-auto-prompt",
          "--cli-connect-timeout",
          "15",
          "--cli-read-timeout",
          "30",
        ],
        { ...common, env: awsEnv },
      );
      return raw ? output : json(output);
    };
    const identity = await aws("sts", "get-caller-identity");
    requireThat(
      identity.Account === account &&
        typeof identity.Arn === "string" &&
        identity.Arn.includes(`::${account}:`) &&
        !identity.Arn.endsWith(":root"),
      "Use a non-root login in the expected AWS account",
    );
    const repositories = await aws("ecr", "describe-repositories", [
      "--registry-id",
      account,
      "--repository-names",
      repository,
    ]);
    const repo = repositories.repositories?.[0];
    requireThat(
      repositories.repositories?.length === 1 &&
        repo.repositoryArn === repositoryArn &&
        repo.repositoryUri === repositoryUrl &&
        repo.repositoryName === repository &&
        repo.registryId === account &&
        repo.imageTagMutability === "IMMUTABLE" &&
        (repo.imageTagMutabilityExclusionFilters ?? []).length === 0 &&
        repo.encryptionConfiguration?.encryptionType === "AES256" &&
        repo.imageScanningConfiguration?.scanOnPush === true,
      "Repository identity or reviewed settings do not match",
    );
    const tags = await aws("ecr", "list-tags-for-resource", ["--resource-arn", repositoryArn]);
    requireThat(
      tags.tags?.some(
        (item) => item.Key === "WallieStack" && item.Value === "wallie-staging-registry",
      ),
      "Repository ownership marker does not match",
    );
    const scanning = await aws("ecr", "get-registry-scanning-configuration");
    requireThat(
      scanning.registryId === account && scanning.scanningConfiguration?.scanType === "BASIC",
      "This publisher requires BASIC ECR scanning in the expected account",
    );
    const effective = await aws("ecr", "batch-get-repository-scanning-configuration", [
      "--repository-names",
      repository,
    ]);
    const coverage = effective.scanningConfigurations?.[0];
    requireThat(
      Array.isArray(effective.failures) &&
        effective.failures.length === 0 &&
        effective.scanningConfigurations?.length === 1 &&
        coverage.repositoryArn === repositoryArn &&
        coverage.repositoryName === repository &&
        coverage.scanOnPush === true &&
        coverage.scanFrequency === "SCAN_ON_PUSH",
      "Effective repository scanning must be BASIC scan-on-push",
    );
    try {
      await aws("ecr", "describe-images", [
        "--registry-id",
        account,
        "--repository-name",
        repository,
        "--image-ids",
        `imageTag=${tag}`,
      ]);
      throw new Error("Release tag already exists; it must never be overwritten");
    } catch (error) {
      if (error.awsCode !== "ImageNotFoundException") throw error;
    }

    const endpoint =
      env.DOCKER_HOST && !env.DOCKER_CONTEXT
        ? env.DOCKER_HOST
        : await run(
            "docker",
            [
              "context",
              "inspect",
              ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []),
              "--format",
              "{{.Endpoints.docker.Host}}",
            ],
            common,
          );
    requireThat(
      /^unix:\/\/\/[^\0\r\n]+$/.test(endpoint),
      "Publishing requires a local Docker Unix socket",
    );
    const dockerEnv = {
      ...env,
      DOCKER_CONFIG: dockerConfig,
      DOCKER_HOST: endpoint,
      DOCKER_DEFAULT_PLATFORM: platform,
    };
    for (const key of [
      "DOCKER_CONTEXT",
      "DOCKER_CERT_PATH",
      "DOCKER_TLS_VERIFY",
      "BUILDX_BUILDER",
      "BUILDX_CONFIG",
      "BUILDKIT_HOST",
      "EXPERIMENTAL_BUILDKIT_SOURCE_POLICY",
    ])
      delete dockerEnv[key];
    mkdirSync(source, { mode: 0o700 });
    mkdirSync(dockerConfig, { mode: 0o700 });
    // Preserve CLI plugin discovery, but never copy registry auth or credential helpers.
    const originalConfig = env.DOCKER_CONFIG ?? join(homedir(), ".docker");
    writeFileSync(
      join(dockerConfig, "config.json"),
      JSON.stringify({ cliPluginsExtraDirs: [join(originalConfig, "cli-plugins")] }),
      { mode: 0o600 },
    );
    const docker = (args, extra = {}) =>
      run("docker", ["--host", endpoint, ...args], { ...common, env: dockerEnv, ...extra });
    await run(
      "git",
      ["archive", "--format=tar", `--output=${join(temporary, "source.tar")}`, revision],
      common,
    );
    await run("tar", ["-xf", join(temporary, "source.tar"), "-C", source], common);
    const metadataFile = join(temporary, "build-metadata.json");
    const localTag = `wallie-build-${component}:${nonce}`;
    progress(`Building ${component} for ${platform}`);
    await docker(
      [
        "buildx",
        "build",
        "--builder",
        "default",
        "--platform",
        platform,
        "--load",
        "--provenance=false",
        "--sbom=false",
        "--label",
        `org.opencontainers.image.revision=${revision}`,
        "--tag",
        localTag,
        "--metadata-file",
        metadataFile,
        "--file",
        join(source, "docker", `${component}.Dockerfile`),
        source,
      ],
      { timeout: 45 * 60_000 },
    );
    const metadata = json(readFileSync(metadataFile, "utf8"));
    const inspection = json(await docker(["image", "inspect", localTag]));
    const image = inspection[0];
    const imageId = image?.Id;
    const configDigest = metadata["containerimage.config.digest"];
    const buildDigest = metadata["containerimage.digest"];
    // Classic Docker addresses images by config digest; containerd uses a manifest
    // digest. In the latter case require the single image descriptor, never an index.
    const descriptorMatches =
      image?.Descriptor?.digest === buildDigest &&
      imageManifestTypes.includes(image.Descriptor.mediaType);
    requireThat(
      inspection.length === 1 &&
        digestPattern.test(configDigest ?? "") &&
        digestPattern.test(buildDigest ?? "") &&
        (imageId === configDigest || (imageId === buildDigest && descriptorMatches)) &&
        (!image.Descriptor || descriptorMatches) &&
        image.Os === "linux" &&
        image.Architecture === "amd64" &&
        image.Config?.User === "node" &&
        image.Config?.Labels?.["org.opencontainers.image.revision"] === revision,
      "Built image identity, platform, user, or revision does not match",
    );
    progress(`Testing the built ${component} image`);
    await run(
      process.execPath,
      [join(source, "scripts", `check-${component}-container.mjs`), imageId],
      { ...common, cwd: source, env: dockerEnv, timeout: 10 * 60_000 },
    );
    progress(`Uploading the tested ${component} image`);
    await docker(["tag", imageId, reference]);
    // The token only travels over stdin into this run's private, disposable config.
    const password = await aws("ecr", "get-login-password", [], true);
    requireThat(typeof password === "string" && password.length > 0, "ECR returned no login token");
    await docker(["login", "--username", "AWS", "--password-stdin", registry], { input: password });
    receipt = {
      schemaVersion: 1,
      component,
      revision,
      platform,
      tag,
      repository: repositoryUrl,
      testedImageId: imageId,
      testedConfigDigest: configDigest,
      uploadStatus: "attempted",
      startedAt: new Date(now()).toISOString(),
      pushedAt: null,
      digest: null,
      signed: false,
      deployable: false,
      scan: { status: "unverified" },
    };
    saveReceipt();
    await docker(["push", reference], { timeout: 30 * 60_000 });
    receipt.uploadStatus = "confirmed";
    receipt.pushedAt = new Date(now()).toISOString();
    progress("Verifying the published manifest and waiting for its scan");
    const remote = await aws("ecr", "batch-get-image", [
      "--registry-id",
      account,
      "--repository-name",
      repository,
      "--image-ids",
      `imageTag=${tag}`,
    ]);
    const pushed = remote.images?.[0];
    requireThat(
      Array.isArray(remote.failures) &&
        remote.failures.length === 0 &&
        remote.images?.length === 1 &&
        pushed.registryId === account &&
        pushed.repositoryName === repository &&
        digestPattern.test(pushed.imageId?.imageDigest ?? ""),
      "Cannot identify the pushed image manifest",
    );
    const manifest = json(pushed.imageManifest);
    receipt.digest = pushed.imageId.imageDigest;
    requireThat(
      manifest.config?.digest === configDigest &&
        imageManifestTypes.includes(manifest.mediaType) &&
        manifest.schemaVersion === 2 &&
        !manifest.manifests &&
        `sha256:${createHash("sha256").update(pushed.imageManifest).digest("hex")}` ===
          receipt.digest,
      "Pushed manifest does not match the tested image",
    );
    const deadline = now() + 10 * 60_000;
    while (now() < deadline) {
      let result;
      try {
        result = await aws("ecr", "describe-image-scan-findings", [
          "--registry-id",
          account,
          "--repository-name",
          repository,
          "--image-id",
          `imageDigest=${receipt.digest}`,
        ]);
      } catch (error) {
        if (error.awsCode !== "ScanNotFoundException") throw error;
        await wait(10_000, undefined, { signal: dependencies.signal });
        continue;
      }
      const status = result.imageScanStatus?.status;
      receipt.scan = { status };
      requireThat(
        result.registryId === account &&
          result.repositoryName === repository &&
          result.imageId?.imageDigest === receipt.digest,
        "Scan response does not identify the pushed digest",
      );
      if (["PENDING", "IN_PROGRESS"].includes(status)) {
        await wait(10_000, undefined, { signal: dependencies.signal });
        continue;
      }
      requireThat(
        status === "COMPLETE",
        `ECR scan is not complete (${status ?? "missing status"})`,
      );
      const counts = result.imageScanFindings?.findingSeverityCounts;
      const completedAt = result.imageScanFindings?.imageScanCompletedAt;
      requireThat(
        counts &&
          typeof counts === "object" &&
          !Array.isArray(counts) &&
          Object.entries(counts).every(
            ([name, count]) =>
              severityNames.includes(name) && Number.isSafeInteger(count) && count >= 0,
          ) &&
          Number.isFinite(
            typeof completedAt === "number" ? completedAt * 1000 : Date.parse(completedAt),
          ),
        "ECR scan findings are missing or invalid",
      );
      receipt.scan = {
        status,
        completedAt,
        counts: Object.fromEntries(severityNames.map((name) => [name, counts[name] ?? 0])),
      };
      requireThat(
        !counts.HIGH && !counts.CRITICAL,
        "ECR scan contains HIGH or CRITICAL findings; image remains published but is blocked",
      );
      return { receipt, receiptPath };
    }
    throw new Error("ECR scan timed out; image remains published but is unverified");
  } catch (error) {
    if (receipt) {
      receipt.error = error.message;
      error.receiptPath = receiptPath;
    }
    throw error;
  } finally {
    try {
      if (receipt) {
        saveReceipt();
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => controller.abort(new Error(`Interrupted by ${signal}`)));
  try {
    const result = await publishImage(parsePublishArgs(process.argv.slice(2)), {
      signal: controller.signal,
      progress: console.info,
    });
    console.log(`Published ${result.receipt.repository}@${result.receipt.digest}`);
    console.log(`Receipt: ${result.receiptPath}. Unsigned; not deployable.`);
  } catch (error) {
    console.error(`[aws-image] ${error.message}`);
    if (error.receiptPath) console.error(`Receipt: ${error.receiptPath}`);
    process.exitCode = 1;
  }
}

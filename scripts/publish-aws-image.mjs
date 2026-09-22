import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { resolveTemporaryAwsCredentials } from "./lib/aws-image-credentials.mjs";
import { archiveReviewedSource } from "./lib/aws-image-source.mjs";
import { withoutAwsProviderEnvironment } from "./lib/aws-image-environment.mjs";
import { stableAwsIdentity } from "./lib/aws-image-identity.mjs";
import { prepareImageSigning } from "./lib/aws-image-signing.mjs";

const platform = "linux/amd64";
const awsCallTimeout = 120_000;
const credentialMargin = 30_000;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const imageManifestTypes = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];
const severityNames = ["INFORMATIONAL", "LOW", "MEDIUM", "HIGH", "CRITICAL", "UNDEFINED"];
const usage =
  "Usage: node scripts/publish-aws-image.mjs --component web|worker --account-id <12 digits> --region <region> --revision <full Git SHA> [--profile <temporary-login profile>] [--signing-profile-version <10 alphanumeric characters>]";

export function parsePublishArgs(args, env = process.env) {
  const { values, tokens } = parseArgs({
    args,
    tokens: true,
    options: Object.fromEntries(
      ["component", "account-id", "region", "revision", "profile", "signing-profile-version"].map(
        (key) => [key, { type: "string" }],
      ),
    ),
  });
  const profile = values.profile ?? env.AWS_PROFILE;
  const signingVersion = values["signing-profile-version"];
  if (
    tokens.length !== Object.keys(values).length ||
    Object.values(values).some((value) => value !== value.trim()) ||
    !["web", "worker"].includes(values.component) ||
    !/^\d{12}$/.test(values["account-id"] ?? "") ||
    !/^(?:[a-z]{2}-[a-z]+|us-gov-[a-z]+)-\d+$/.test(values.region ?? "") ||
    !/^[a-f0-9]{40}$/.test(values.revision ?? "") ||
    !/^[\w][\w.-]{0,127}$/.test(profile ?? "") ||
    (signingVersion !== undefined &&
      (!/^[a-zA-Z0-9]{10}$/.test(signingVersion) ||
        values.region.startsWith("cn-") ||
        values.region.startsWith("us-gov-")))
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
      detached: options.processGroup === true,
    });
    let stdout = "";
    let stderr = "";
    let failure;
    let killTimer;
    const stop = (signal) => {
      if (options.processGroup === true && child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          // Preserve the original failure when a second kill races process teardown.
          if (error.code !== "ESRCH") failure ??= "process-group termination failed";
        }
      } else child.kill(signal);
    };
    const kill = (reason) => {
      failure = reason;
      stop("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => kill("timeout"), options.timeout ?? 120_000);
    const abort = () => {
      failure = "interrupted";
      stop("SIGTERM");
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
      // A plugin may outlive Notation even after its stdio closes. End the entire
      // private process group before discarding credentialed runtime files.
      if (options.processGroup === true) stop("SIGKILL");
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

export function formatPublishResult(receipt) {
  if (receipt.signed === true && receipt.signing?.status === "verified")
    return "Signature verified; not deployable.";
  if (receipt.signed === false && !receipt.signing) return "Unsigned; not deployable.";
  return "Signature status unconfirmed; not deployable.";
}

function recordCompletedScan(
  result,
  { account, repository, digest, uploadStartedAt, observedAt },
  receipt,
) {
  requireThat(
    result.registryId === account &&
      result.repositoryName === repository &&
      result.imageId?.imageDigest === digest,
    "Scan response does not identify the pushed digest",
  );
  const status = result.imageScanStatus?.status;
  requireThat(status === "COMPLETE", `ECR scan is not complete (${status ?? "missing status"})`);
  const counts = result.imageScanFindings?.findingSeverityCounts;
  const completedAt = result.imageScanFindings?.imageScanCompletedAt;
  const completedMs =
    typeof completedAt === "number"
      ? completedAt * 1000
      : typeof completedAt === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(completedAt)
        ? Date.parse(completedAt)
        : NaN;
  requireThat(
    counts &&
      typeof counts === "object" &&
      !Array.isArray(counts) &&
      Object.entries(counts).every(
        ([name, count]) =>
          severityNames.includes(name) && Number.isSafeInteger(count) && count >= 0,
      ) &&
      Number.isFinite(completedMs) &&
      completedMs > 0,
    "ECR scan findings are missing or invalid",
  );
  receipt.scan = {
    status,
    completedAt,
    fresh: completedMs > uploadStartedAt && completedMs <= observedAt,
    counts: Object.fromEntries(severityNames.map((name) => [name, counts[name] ?? 0])),
  };
  requireThat(
    completedMs <= observedAt,
    "ECR scan timestamp is in the future; check the host clock",
  );
}

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
  const temporary = mkdtempSync(
    join(realpathSync(dependencies.tempRoot ?? tmpdir()), "wallie-image-publish-"),
  );
  const source = join(temporary, "source");
  const dockerConfig = join(temporary, "docker");
  const nonAwsEnv = withoutAwsProviderEnvironment(env);
  // Docker qualification must not inherit legacy Notary behavior or passphrases.
  for (const key of Object.keys(nonAwsEnv))
    if (key.toUpperCase().startsWith("DOCKER_CONTENT_TRUST")) delete nonAwsEnv[key];
  const common = { cwd, env: nonAwsEnv, signal: dependencies.signal };
  let receipt;
  let receiptPath;
  const saveReceipt = () => {
    mkdirSync(join(receiptPath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  };
  try {
    progress("Checking reviewed source and registry");
    const { root } = await archiveReviewedSource({
      run,
      ...common,
      revision,
      source,
      temporary,
    });
    receiptPath = join(root, ".wallie", "aws", `image-${component}-${tag}.json`);

    const resolveCredentials = () =>
      resolveTemporaryAwsCredentials({ profile, run, ...common, env, now });
    let credentials;
    let principal;
    const hasLifetime = (snapshot) =>
      snapshot && Date.parse(snapshot.expiration) - now() > awsCallTimeout + credentialMargin;
    const requireLifetime = (snapshot) =>
      requireThat(
        hasLifetime(snapshot),
        "AWS credentials expire too soon for a bounded request; renew the temporary login",
      );
    const invokeAws = async (snapshot, service, operation, args = [], raw = false) => {
      requireLifetime(snapshot);
      const output = await run(
        "aws",
        [
          service,
          operation,
          ...args,
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
        { ...common, env: snapshot.env, timeout: awsCallTimeout },
      );
      return raw ? output : json(output);
    };
    const refreshCredentials = async () => {
      const candidate = await resolveCredentials();
      const identity = await invokeAws(candidate, "sts", "get-caller-identity");
      const nextPrincipal = stableAwsIdentity(identity, account, partition);
      requireThat(
        principal === undefined || nextPrincipal === principal,
        "AWS identity changed during publishing; publishing stopped",
      );
      // STS itself takes time. Never promote a snapshot that cannot finish the next call.
      requireLifetime(candidate);
      principal = nextPrincipal;
      credentials = candidate;
    };
    const ensureCredentials = async () => {
      if (!hasLifetime(credentials)) await refreshCredentials();
    };
    const aws = async (service, operation, args = [], raw = false) => {
      await ensureCredentials();
      try {
        return await invokeAws(credentials, service, operation, args, raw);
      } catch (error) {
        if (!["ExpiredToken", "ExpiredTokenException"].includes(error.awsCode)) throw error;
        // One identity-checked retry handles service-side expiry without a refresh loop.
        await refreshCredentials();
        return invokeAws(credentials, service, operation, args, raw);
      }
    };
    await refreshCredentials();
    const checkRepository = async () => {
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
    };
    await checkRepository();
    const signingVersion = options["signing-profile-version"];
    const signing =
      signingVersion === undefined
        ? undefined
        : await (dependencies.prepareSigning ?? prepareImageSigning)({
            root,
            temporary,
            account,
            region,
            profileVersion: signingVersion,
            run,
            now,
            signal: dependencies.signal,
            platform: dependencies.platform,
            arch: dependencies.arch,
          });
    if (signing) await signing.verifyProfile(aws);
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
      ...nonAwsEnv,
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
    // Builds and pushes can each outlive a short login. Refresh at both boundaries;
    // preflight and scan calls also check lifetime before every request.
    await refreshCredentials();
    progress(`Uploading the tested ${component} image`);
    await docker(["tag", imageId, reference]);
    // The token only travels over stdin into this run's private, disposable config.
    const password = await aws("ecr", "get-login-password", [], true);
    requireThat(typeof password === "string" && password.length > 0, "ECR returned no login token");
    await docker(["login", "--username", "AWS", "--password-stdin", registry], { input: password });
    await ensureCredentials();
    const uploadStartedAt = now();
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
      startedAt: new Date(uploadStartedAt).toISOString(),
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
    await refreshCredentials();
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
      recordCompletedScan(
        result,
        {
          account,
          repository,
          digest: receipt.digest,
          uploadStartedAt,
          observedAt: now(),
        },
        receipt,
      );
      // ECR can return the previous completed scan for a deterministic rebuild.
      // Never round the upload marker down or allow clock-skew tolerance here.
      if (!receipt.scan.fresh) {
        await wait(10_000, undefined, { signal: dependencies.signal });
        continue;
      }
      requireThat(
        !receipt.scan.counts.HIGH && !receipt.scan.counts.CRITICAL,
        "ECR scan contains HIGH or CRITICAL findings; image remains published but is blocked",
      );
      if (signing) {
        progress("Rechecking image qualification before signing the exact digest");
        await refreshCredentials();
        await checkRepository();
        // Do not retain an earlier passing receipt if the current scan read fails.
        receipt.scan = { status: "unverified" };
        const currentScan = await aws("ecr", "describe-image-scan-findings", [
          "--registry-id",
          account,
          "--repository-name",
          repository,
          "--image-id",
          `imageDigest=${receipt.digest}`,
        ]);
        recordCompletedScan(
          currentScan,
          {
            account,
            repository,
            digest: receipt.digest,
            uploadStartedAt,
            observedAt: now(),
          },
          receipt,
        );
        requireThat(
          receipt.scan.fresh && !receipt.scan.counts.HIGH && !receipt.scan.counts.CRITICAL,
          "Latest ECR scan no longer qualifies this digest for signing",
        );
        await signing.signAndVerify({
          aws,
          getCredentials: async () => {
            await refreshCredentials();
            return credentials;
          },
          receipt,
          saveReceipt,
          nonce,
        });
      }
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
    console.log(`Receipt: ${result.receiptPath}. ${formatPublishResult(result.receipt)}`);
  } catch (error) {
    console.error(`[aws-image] ${error.message}`);
    if (error.receiptPath) console.error(`Receipt: ${error.receiptPath}`);
    process.exitCode = 1;
  }
}

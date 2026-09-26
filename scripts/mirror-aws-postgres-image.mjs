import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolveTemporaryAwsCredentials } from "./lib/aws-image-credentials.mjs";
import { withoutAwsProviderEnvironment } from "./lib/aws-image-environment.mjs";
import { stableAwsIdentity } from "./lib/aws-image-identity.mjs";
import { archiveReviewedSource } from "./lib/aws-image-source.mjs";

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const indexTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const imageTypes = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const repository = "wallie-staging/supabase-postgres";
const awsCallTimeout = 120_000;
const copyTimeout = 30 * 60_000;
const severityNames = ["INFORMATIONAL", "LOW", "MEDIUM", "HIGH", "CRITICAL", "UNDEFINED"];
const usage =
  "Usage: node scripts/mirror-aws-postgres-image.mjs --account-id <12 digits> --region <region> --revision <full merged Git SHA> [--profile <temporary-login profile>]";

const requireThat = (condition, message) => {
  if (!condition) throw new Error(message);
};
const digestOf = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const parseJson = (bytes) => {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Command returned invalid JSON");
  }
};

export function parseMirrorArgs(args, env = process.env) {
  const { values, tokens } = parseArgs({
    args,
    tokens: true,
    options: Object.fromEntries(
      ["account-id", "region", "revision", "profile"].map((key) => [key, { type: "string" }]),
    ),
  });
  const profile = values.profile ?? env.AWS_PROFILE;
  if (
    tokens.length !== Object.keys(values).length ||
    Object.values(values).some((value) => value !== value.trim()) ||
    !/^\d{12}$/.test(values["account-id"] ?? "") ||
    !/^(?:[a-z]{2}-[a-z]+|us-gov-[a-z]+)-\d+$/.test(values.region ?? "") ||
    !/^[a-f0-9]{40}$/.test(values.revision ?? "") ||
    !/^[\w][\w.-]{0,127}$/.test(profile ?? "")
  )
    throw new Error(usage);
  return { ...values, profile };
}

/** No shell or inherited output. Raw manifest stdout remains byte-for-byte intact. */
export function runCommand(command, args, options = {}) {
  return new Promise((done, reject) => {
    if (options.signal?.aborted) return reject(new Error("Mirror interrupted"));
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: options.processGroup === true,
    });
    const stdout = [];
    let outputBytes = 0;
    let stderr = "";
    let failure;
    let killTimer;
    const stop = (signal) => {
      if (options.processGroup === true && child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
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
    const timer = setTimeout(() => kill("timeout"), options.timeout ?? awsCallTimeout);
    const abort = () => {
      failure = "interrupted";
      stop("SIGTERM");
      killTimer = setTimeout(() => kill("interrupted"), 5_000);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout.push(chunk);
      outputBytes += chunk.length;
      if (outputBytes + stderr.length > 32 * 1024 * 1024) kill("output limit");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (outputBytes + stderr.length > 32 * 1024 * 1024) kill("output limit");
    });
    child.on("error", (error) => {
      failure = error.code ?? "process error";
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (options.processGroup === true) stop("SIGKILL");
      if (code === 0 && !failure) {
        const bytes = Buffer.concat(stdout);
        return done(options.raw ? bytes : bytes.toString("utf8").trim());
      }
      const awsCode = stderr.match(/\(([\w.-]+)\) when calling/)?.[1];
      reject(
        Object.assign(
          new Error(`${command} ${args[0]} failed (${awsCode ?? failure ?? `exit ${code}`})`),
          {
            awsCode,
          },
        ),
      );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

function checkedIndex(raw, expectedDigest) {
  requireThat(
    Buffer.isBuffer(raw) && digestOf(raw) === expectedDigest,
    "Upstream index digest does not match the reviewed lock",
  );
  const index = parseJson(raw);
  requireThat(
    index.schemaVersion === 2 && indexTypes.has(index.mediaType) && Array.isArray(index.manifests),
    "Reviewed PostgreSQL digest must identify an OCI or Docker image index",
  );
  const children = index.manifests.filter(
    (descriptor) =>
      descriptor.platform?.os === "linux" && descriptor.platform?.architecture === "amd64",
  );
  requireThat(
    children.length === 1 &&
      imageTypes.has(children[0].mediaType) &&
      digestPattern.test(children[0].digest ?? "") &&
      Number.isSafeInteger(children[0].size) &&
      children[0].size > 0 &&
      (children[0].platform.variant === undefined || children[0].platform.variant === "v1"),
    "Reviewed index must contain one ordinary linux/amd64 image",
  );
  return children[0];
}

function checkedChild(raw, descriptor) {
  requireThat(
    Buffer.isBuffer(raw) && raw.length === descriptor.size && digestOf(raw) === descriptor.digest,
    "Upstream linux/amd64 manifest does not match its index descriptor",
  );
  const manifest = parseJson(raw);
  requireThat(
    manifest.schemaVersion === 2 &&
      manifest.mediaType === descriptor.mediaType &&
      digestPattern.test(manifest.config?.digest ?? "") &&
      Array.isArray(manifest.layers) &&
      manifest.layers.length > 0 &&
      manifest.layers.every((layer) => digestPattern.test(layer.digest ?? "")),
    "Reviewed linux/amd64 manifest is malformed",
  );
}

function readLock(source) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(join(source, "infra/supabase/upstream.lock.json"), "utf8"));
  } catch {
    throw new Error("Reviewed Supabase image lock is missing or malformed");
  }
  requireThat(
    /^supabase\/postgres:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(lock?.images?.db ?? "") &&
      digestPattern.test(lock?.digests?.db ?? ""),
    "Reviewed Supabase PostgreSQL image lock is invalid",
  );
  return { image: lock.images.db, digest: lock.digests.db };
}

function completeScan(result, { account, childDigest, uploadStartedAt, observedAt }, receipt) {
  requireThat(
    result.registryId === account &&
      result.repositoryName === repository &&
      result.imageId?.imageDigest === childDigest,
    "Scan response does not identify the mirrored linux/amd64 digest",
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
      completedMs > 0 &&
      completedMs <= observedAt,
    "ECR scan findings or timestamp are missing or invalid",
  );
  receipt.scan = {
    status,
    completedAt,
    fresh: completedMs > uploadStartedAt,
    counts: Object.fromEntries(severityNames.map((name) => [name, counts[name] ?? 0])),
  };
}

export async function mirrorPostgresImage(options, dependencies = {}) {
  const run = dependencies.run ?? runCommand;
  const archiveSource = dependencies.archiveSource ?? archiveReviewedSource;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? sleep;
  const progress = dependencies.progress ?? (() => {});
  const env = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd();
  const { region, revision, profile, "account-id": account } = options;
  const partition = region.startsWith("cn-")
    ? "aws-cn"
    : region.startsWith("us-gov-")
      ? "aws-us-gov"
      : "aws";
  const registry = `${account}.dkr.ecr.${region}.${partition === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com"}`;
  const repositoryUrl = `${registry}/${repository}`;
  const repositoryArn = `arn:${partition}:ecr:${region}:${account}:repository/${repository}`;
  const temporary = mkdtempSync(
    join(realpathSync(dependencies.tempRoot ?? tmpdir()), "wallie-postgres-mirror-"),
  );
  const source = join(temporary, "source");
  const authFile = join(temporary, "ecr-auth.json");
  const nonAwsEnv = withoutAwsProviderEnvironment(env);
  for (const key of Object.keys(nonAwsEnv)) {
    if (/^(?:DOCKER_CONTENT_TRUST|REGISTRY_AUTH_FILE|CONTAINERS_AUTH_FILE)/i.test(key))
      delete nonAwsEnv[key];
  }
  const common = { cwd, env: nonAwsEnv, signal: dependencies.signal };
  let receipt;
  let receiptPath;
  const saveReceipt = () => {
    mkdirSync(join(receiptPath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  };
  try {
    try {
      await run("skopeo", ["--version"], { ...common, timeout: 10_000 });
    } catch {
      throw new Error("Skopeo is required for byte-preserving PostgreSQL image mirroring");
    }
    progress("Checking reviewed Supabase image lock and source index");
    const { root } = await archiveSource({ run, ...common, revision, source, temporary });
    const locked = readLock(source);
    const tag = `upstream-sha256-${locked.digest.slice(7)}`;
    // The reviewed tag identifies the candidate in the lock; transfer uses only its digest.
    const sourceReference = `docker://docker.io/supabase/postgres@${locked.digest}`;
    const destinationReference = `docker://${repositoryUrl}:${tag}`;
    receiptPath = join(
      root,
      ".wallie",
      "aws",
      `postgres-image-${locked.digest.slice(7)}-${randomUUID().replaceAll("-", "")}.json`,
    );
    const inspect = (reference, auth = false) =>
      run(
        "skopeo",
        [
          "inspect",
          "--raw",
          ...(auth ? ["--authfile", authFile] : ["--no-creds"]),
          "--tls-verify=true",
          reference,
        ],
        { ...common, raw: true, timeout: 120_000 },
      );
    const sourceIndex = await inspect(sourceReference);
    const child = checkedIndex(sourceIndex, locked.digest);
    const sourceChild = await inspect(`docker://docker.io/supabase/postgres@${child.digest}`);
    checkedChild(sourceChild, child);

    const resolveCredentials = () =>
      resolveTemporaryAwsCredentials({ profile, run, ...common, env, now });
    let credentials;
    let principal;
    const hasLifetime = (snapshot, milliseconds = awsCallTimeout + 30_000) =>
      snapshot && Date.parse(snapshot.expiration) - now() > milliseconds;
    const requireLifetime = (snapshot, milliseconds = awsCallTimeout + 30_000) =>
      requireThat(
        hasLifetime(snapshot, milliseconds),
        "AWS credentials expire too soon; renew the temporary login",
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
        { ...common, env: snapshot.env, timeout: awsCallTimeout, raw },
      );
      if (!raw) return parseJson(output);
      // AWS CLI emits a terminal newline; preserve every other byte of the token.
      const token = (Buffer.isBuffer(output) ? output.toString("utf8") : output).replace(
        /\r?\n$/,
        "",
      );
      requireThat(
        typeof token === "string" && /^[\x21-\x7e]{1,131072}$/.test(token),
        "ECR returned an invalid login token",
      );
      return token;
    };
    const refreshCredentials = async () => {
      const candidate = await resolveCredentials();
      const identity = await invokeAws(candidate, "sts", "get-caller-identity");
      const nextPrincipal = stableAwsIdentity(identity, account, partition);
      requireThat(
        principal === undefined || nextPrincipal === principal,
        "AWS identity changed during mirroring; mirroring stopped",
      );
      requireLifetime(candidate);
      credentials = candidate;
      principal = nextPrincipal;
    };
    const aws = async (service, operation, args = [], raw = false) => {
      if (!hasLifetime(credentials)) await refreshCredentials();
      try {
        return await invokeAws(credentials, service, operation, args, raw);
      } catch (error) {
        if (!["ExpiredToken", "ExpiredTokenException"].includes(error.awsCode)) throw error;
        await refreshCredentials();
        return invokeAws(credentials, service, operation, args, raw);
      }
    };
    await refreshCredentials();
    progress("Checking exact ECR repository, scanning, and absent immutable tag");
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
      "This mirror requires BASIC ECR scanning in the expected account",
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
    // A failed multi-architecture copy may leave untagged child manifests.
    // This first mirror requires an empty repository, not merely an absent tag.
    const existing = await aws("ecr", "describe-images", [
      "--registry-id",
      account,
      "--repository-name",
      repository,
      "--max-items",
      "1",
    ]);
    requireThat(
      Array.isArray(existing.imageDetails) &&
        existing.imageDetails.length === 0 &&
        !existing.NextToken &&
        !existing.nextToken,
      "PostgreSQL repository is not empty; inspect any tagged or untagged images before retrying",
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
      throw new Error("Locked PostgreSQL tag already exists; it must never be overwritten");
    } catch (error) {
      if (error.awsCode !== "ImageNotFoundException") throw error;
    }

    await refreshCredentials();
    // Skopeo uses the 12-hour ECR token, not the short-lived AWS CLI credentials.
    const password = await aws("ecr", "get-login-password", [], true);
    requireThat(typeof password === "string" && password.length > 0, "ECR returned no login token");
    await run(
      "skopeo",
      [
        "login",
        "--authfile",
        authFile,
        "--username",
        "AWS",
        "--password-stdin",
        "--tls-verify=true",
        registry,
      ],
      { ...common, input: password, timeout: 60_000 },
    );
    chmodSync(authFile, 0o600);
    const uploadStartedAt = now();
    receipt = {
      schemaVersion: 1,
      sourceRevision: revision,
      upstreamImage: locked.image,
      upstreamIndexDigest: locked.digest,
      linuxAmd64Digest: child.digest,
      platform: "linux/amd64",
      repository: repositoryUrl,
      tag,
      uploadStatus: "attempted",
      startedAt: new Date(uploadStartedAt).toISOString(),
      pushedAt: null,
      digest: null,
      signed: false,
      deployable: false,
      scan: { status: "unverified" },
    };
    saveReceipt();
    progress("Copying the locked image index and all children without conversion");
    await run(
      "skopeo",
      [
        "copy",
        "--all",
        "--preserve-digests",
        "--src-no-creds",
        "--src-tls-verify=true",
        "--dest-tls-verify=true",
        "--dest-authfile",
        authFile,
        sourceReference,
        destinationReference,
      ],
      { ...common, timeout: copyTimeout, processGroup: true },
    );
    receipt.uploadStatus = "confirmed";
    receipt.pushedAt = new Date(now()).toISOString();
    await refreshCredentials();
    progress("Reading back exact ECR index and linux/amd64 child");
    const detail = await aws("ecr", "describe-images", [
      "--registry-id",
      account,
      "--repository-name",
      repository,
      "--image-ids",
      `imageTag=${tag}`,
    ]);
    const image = detail.imageDetails?.[0];
    requireThat(
      detail.imageDetails?.length === 1 &&
        image.registryId === account &&
        image.repositoryName === repository &&
        image.imageDigest === locked.digest &&
        image.imageTags?.includes(tag),
      "ECR tag does not identify the reviewed upstream index digest",
    );
    const destinationIndex = await inspect(destinationReference, true);
    requireThat(
      Buffer.isBuffer(destinationIndex) &&
        destinationIndex.equals(sourceIndex) &&
        digestOf(destinationIndex) === locked.digest,
      "ECR index bytes do not match the reviewed upstream index",
    );
    const destinationChild = await inspect(`docker://${repositoryUrl}@${child.digest}`, true);
    requireThat(
      Buffer.isBuffer(destinationChild) && destinationChild.equals(sourceChild),
      "ECR linux/amd64 child bytes do not match the reviewed upstream child",
    );
    checkedChild(destinationChild, child);
    receipt.digest = locked.digest;
    saveReceipt();

    progress("Waiting for a fresh scan of the linux/amd64 child");
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
          `imageDigest=${child.digest}`,
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
          result.imageId?.imageDigest === child.digest,
        "Scan response does not identify the mirrored linux/amd64 digest",
      );
      if (["PENDING", "IN_PROGRESS"].includes(status)) {
        await wait(10_000, undefined, { signal: dependencies.signal });
        continue;
      }
      completeScan(
        result,
        { account, childDigest: child.digest, uploadStartedAt, observedAt: now() },
        receipt,
      );
      if (!receipt.scan.fresh) {
        await wait(10_000, undefined, { signal: dependencies.signal });
        continue;
      }
      requireThat(
        !receipt.scan.counts.HIGH && !receipt.scan.counts.CRITICAL,
        "ECR linux/amd64 scan contains HIGH or CRITICAL findings; image remains mirrored but blocked",
      );
      return { receipt, receiptPath };
    }
    throw new Error("ECR linux/amd64 scan timed out; image remains mirrored but unverified");
  } catch (error) {
    if (receipt) {
      receipt.error = error.message;
      error.receiptPath = receiptPath;
    }
    throw error;
  } finally {
    try {
      if (receipt) saveReceipt();
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
    const result = await mirrorPostgresImage(parseMirrorArgs(process.argv.slice(2)), {
      signal: controller.signal,
      progress: console.info,
    });
    console.log(`Mirrored ${result.receipt.repository}@${result.receipt.digest}`);
    console.log(`Receipt: ${result.receiptPath}. Not deployable.`);
  } catch (error) {
    console.error(`[aws-postgres-mirror] ${error.message}`);
    if (error.receiptPath) console.error(`Receipt: ${error.receiptPath}`);
    process.exitCode = 1;
  }
}

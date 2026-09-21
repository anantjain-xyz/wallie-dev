import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type Options = Record<string, string>;
type Call = {
  command: string;
  args: string[];
  options: {
    env?: NodeJS.ProcessEnv;
    input?: string;
    cwd?: string;
    timeout?: number;
    signal?: AbortSignal;
  };
};
type Receipt = {
  digest: string | null;
  deployable: boolean;
  signed: boolean;
  uploadStatus: string;
  tag: string;
  scan: {
    status: string;
    fresh?: boolean;
    completedAt?: string | number;
    counts?: Record<string, number>;
  };
  error?: string;
};
type Runner = (command: string, args: string[], options?: Call["options"]) => Promise<string>;
let parsePublishArgs: (args: string[], env?: NodeJS.ProcessEnv) => Options;
let publishImage: (
  options: Options,
  dependencies: {
    run: Runner;
    cwd: string;
    env: NodeJS.ProcessEnv;
    tempRoot: string;
    now: () => number;
    wait: (ms: number) => Promise<void>;
  },
) => Promise<{ receipt: Receipt; receiptPath: string }>;
let runCommand: Runner;
beforeAll(async () => {
  const script = new URL("../../../scripts/publish-aws-image.mjs", import.meta.url).href;
  ({ parsePublishArgs, publishImage, runCommand } = await import(script));
});
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const account = "123456789012";
const revision = "a".repeat(40);
const imageId = `sha256:${"b".repeat(64)}`;
const base = {
  component: "web",
  "account-id": account,
  region: "us-west-2",
  revision,
  profile: "wallie-staging",
};
const argumentsFor = (options = base) =>
  Object.entries(options).flatMap(([key, value]) => [`--${key}`, value]);
const awsError = (awsCode: string) => Object.assign(new Error(awsCode), { awsCode });

function harness(component = "web") {
  const directory = mkdtempSync(join(tmpdir(), "wallie-publisher-test-"));
  directories.push(directory);
  const repositoryName = `wallie-staging/${component}`;
  const repositoryUri = `${account}.dkr.ecr.us-west-2.amazonaws.com/${repositoryName}`;
  const repositoryArn = `arn:aws:ecr:us-west-2:${account}:repository/${repositoryName}`;
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: imageId },
    layers: [],
  });
  const digest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  const image = {
    Id: imageId,
    Os: "linux",
    Architecture: "amd64",
    Config: { User: "node", Labels: { "org.opencontainers.image.revision": revision } },
    Descriptor: undefined as { digest: string; mediaType: string } | undefined,
  };
  const repo = {
    repositoryName,
    repositoryUri,
    repositoryArn,
    registryId: account,
    imageTagMutability: "IMMUTABLE",
    imageScanningConfiguration: { scanOnPush: true },
    encryptionConfiguration: { encryptionType: "AES256" },
  };
  const identity = { Account: account, Arn: `arn:aws:iam::${account}:user/wallie-local` };
  const effective = {
    failures: [],
    scanningConfigurations: [
      { repositoryName, repositoryArn, scanOnPush: true, scanFrequency: "SCAN_ON_PUSH" },
    ],
  };
  const registryScan = { registryId: account, scanningConfiguration: { scanType: "BASIC" } };
  const remote = {
    failures: [],
    images: [
      {
        repositoryName,
        registryId: account,
        imageId: { imageDigest: digest },
        imageManifest: manifest,
      },
    ],
  };
  const scan = {
    registryId: account,
    repositoryName,
    imageId: { imageDigest: digest },
    imageScanStatus: { status: "COMPLETE" },
    imageScanFindings: {
      imageScanCompletedAt: "2026-09-22T01:00:01Z" as string | number,
      findingSeverityCounts: { MEDIUM: 2 } as Record<string, number>,
    },
  };
  const calls: Call[] = [];
  const overrides: Record<string, unknown> = {};
  let endpoint = "unix:///var/run/docker.sock";
  let time = Date.parse("2026-09-22T01:00:00.500Z");
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    DOCKER_CONTEXT: "desktop-linux",
    DOCKER_HOST: "tcp://ignored.example",
    BUILDX_CONFIG: "/remote-builder",
    BUILDX_BUILDER: "remote",
    BUILDKIT_HOST: "tcp://builder.example",
    AWS_ACCESS_KEY_ID: "ambient-key",
    AWS_SECRET_ACCESS_KEY: "ambient-secret",
    AWS_SESSION_TOKEN: "ambient-token",
  };
  const scanResponses: unknown[] = [];
  const credentialResponses: unknown[] = [];
  const identityResponses: unknown[] = [];
  const credentials = {
    Version: 1,
    AccessKeyId: "synthetic-temporary-key",
    SecretAccessKey: "synthetic-temporary-secret",
    SessionToken: "synthetic-session-token",
    Expiration: "2026-09-22T02:00:00Z",
  };
  const run: Runner = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    const actualArgs =
      command === "git"
        ? args.slice(
            args.findIndex((arg) =>
              [
                "config",
                "rev-parse",
                "init",
                "fetch",
                "cat-file",
                "merge-base",
                "archive",
              ].includes(arg),
            ),
          )
        : args[0] === "--host"
          ? args.slice(2)
          : args;
    const operation =
      command === "aws"
        ? args[1]
        : command === process.execPath
          ? "smoke"
          : `${command}:${actualArgs[0]}`;
    if (Object.hasOwn(overrides, operation)) {
      const value = overrides[operation];
      if (value instanceof Error) throw value;
      return typeof value === "string" ? value : JSON.stringify(value);
    }
    if (command === "git") {
      if (actualArgs[0] === "config" && actualArgs.includes("--local"))
        return "https://github.com/anantjain-xyz/wallie-dev.git";
      if (actualArgs[0] === "rev-parse")
        return actualArgs.includes("--show-toplevel") ? directory : revision;
      if (actualArgs[0] === "cat-file") return "commit";
      return "";
    }
    if (command === "docker") {
      if (actualArgs[0] === "context") return endpoint;
      if (actualArgs[0] === "buildx")
        writeFileSync(
          actualArgs[actualArgs.indexOf("--metadata-file") + 1],
          JSON.stringify({
            "containerimage.config.digest": imageId,
            "containerimage.digest": digest,
          }),
        );
      if (actualArgs[0] === "image") return JSON.stringify([image]);
      if (actualArgs[0] === "push") {
        const path = join(
          directory,
          ".wallie",
          "aws",
          readdirSync(join(directory, ".wallie", "aws"))[0],
        );
        expect(JSON.parse(readFileSync(path, "utf8")).uploadStatus).toBe("attempted");
        time += 1000;
      }
      return "";
    }
    if (command !== "aws") return "";
    if (operation === "export-credentials")
      return JSON.stringify(credentialResponses.length ? credentialResponses.shift() : credentials);
    if (operation === "get-caller-identity")
      return JSON.stringify(identityResponses.length ? identityResponses.shift() : identity);
    if (operation === "describe-repositories") return JSON.stringify({ repositories: [repo] });
    if (operation === "list-tags-for-resource")
      return JSON.stringify({ tags: [{ Key: "WallieStack", Value: "wallie-staging-registry" }] });
    if (operation === "get-registry-scanning-configuration") return JSON.stringify(registryScan);
    if (operation === "batch-get-repository-scanning-configuration")
      return JSON.stringify(effective);
    if (operation === "describe-images") throw awsError("ImageNotFoundException");
    if (operation === "get-login-password") return "synthetic-ecr-token";
    if (operation === "batch-get-image") return JSON.stringify(remote);
    if (operation === "describe-image-scan-findings") {
      const value = scanResponses.length ? scanResponses.shift() : scan;
      if (value instanceof Error) throw value;
      return JSON.stringify(value);
    }
    throw new Error(`Unexpected command: ${operation}`);
  };
  const execute = () =>
    publishImage(
      { ...base, component },
      {
        run,
        cwd: directory,
        env,
        tempRoot: directory,
        now: () => time,
        wait: async (ms) => {
          time += ms;
        },
      },
    );
  const dockerCalls = (operation: string) =>
    calls.filter((call) => call.command === "docker" && call.args[2] === operation);
  const receipt = () => {
    const path = join(
      directory,
      ".wallie",
      "aws",
      readdirSync(join(directory, ".wallie", "aws"))[0],
    );
    return JSON.parse(readFileSync(path, "utf8")) as Receipt;
  };
  return {
    directory,
    calls,
    overrides,
    repo,
    image,
    identity,
    effective,
    registryScan,
    remote,
    scan,
    scanResponses,
    credentialResponses,
    identityResponses,
    credentials,
    env,
    execute,
    dockerCalls,
    receipt,
    digest,
    setEndpoint: (value: string) => {
      endpoint = value;
    },
  };
}

describe("manual AWS image publishing", () => {
  it.each(["web", "worker"])(
    "publishes only the exact tested %s artifact and records a private unsigned receipt",
    async (component) => {
      const h = harness(component);
      const result = await h.execute();
      const build = h.dockerCalls("buildx");
      expect(build).toHaveLength(1);
      expect(build[0].args).toEqual(
        expect.arrayContaining([
          "--builder",
          "default",
          "--platform",
          "linux/amd64",
          "--load",
          "--provenance=false",
          "--sbom=false",
        ]),
      );
      const smoke = h.calls.find((call) => call.command === process.execPath)!;
      expect(smoke.args[0]).toMatch(
        new RegExp(`/source/scripts/check-${component}-container\\.mjs$`),
      );
      expect(smoke.args[1]).toBe(imageId);
      const tag = h.dockerCalls("tag")[0];
      expect(tag.args[3]).toBe(imageId);
      expect(tag.args[4]).toMatch(
        new RegExp(`wallie-staging/${component}:${revision}-linux-amd64-[a-f0-9]{32}$`),
      );
      expect(h.dockerCalls("push")[0].args[3]).toBe(tag.args[4]);
      expect(h.calls.indexOf(smoke)).toBeLessThan(h.calls.indexOf(tag));
      expect(h.calls.findIndex((call) => call.args.includes("fetch"))).toBeLessThan(
        h.calls.findIndex((call) => call.args.includes("merge-base")),
      );
      expect(h.calls.find((call) => call.args.includes("archive"))!.args).toContain(revision);
      const login = h.dockerCalls("login")[0];
      expect(login.options.input).toBe("synthetic-ecr-token");
      expect(JSON.stringify(h.calls.map((call) => call.args))).not.toContain("synthetic-ecr-token");
      expect(login.options.env?.DOCKER_CONTEXT).toBeUndefined();
      expect(login.options.env?.BUILDX_CONFIG).toBeUndefined();
      expect(login.options.env?.BUILDKIT_HOST).toBeUndefined();
      expect(login.options.env?.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
      expect(smoke.options.env?.DOCKER_DEFAULT_PLATFORM).toBe("linux/amd64");
      expect(existsSync(login.options.env!.DOCKER_CONFIG!)).toBe(false);
      expect(
        h.calls
          .filter((call) => call.command === "aws")
          .every((call) =>
            call.args[1] === "export-credentials"
              ? !call.options.env?.AWS_ACCESS_KEY_ID && call.args.includes(base.profile)
              : call.options.env?.AWS_ACCESS_KEY_ID === h.credentials.AccessKeyId &&
                !call.args.includes("--profile"),
          ),
      ).toBe(true);
      expect(result.receipt).toMatchObject({
        digest: h.digest,
        testedImageId: imageId,
        testedConfigDigest: imageId,
        signed: false,
        deployable: false,
        uploadStatus: "confirmed",
        scan: { status: "COMPLETE", counts: { HIGH: 0, CRITICAL: 0, MEDIUM: 2 } },
      });
      expect(statSync(result.receiptPath).mode & 0o777).toBe(0o600);
      expect(readdirSync(h.directory)).toEqual([".wallie"]);
    },
  );

  it.each(["web", "worker"])(
    "supports containerd manifest IDs for %s while verifying the config digest",
    async (component) => {
      const h = harness(component);
      h.image.Id = h.digest;
      h.image.Descriptor = {
        digest: h.digest,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
      };
      const result = await h.execute();
      expect(h.calls.find((call) => call.command === process.execPath)!.args[1]).toBe(h.digest);
      expect(h.dockerCalls("tag")[0].args[3]).toBe(h.digest);
      expect(result.receipt).toMatchObject({
        testedImageId: h.digest,
        testedConfigDigest: imageId,
        digest: h.digest,
      });
    },
  );

  it.each(["missing", "mismatch", "index", "list"])(
    "rejects a containerd manifest ID with a %s descriptor",
    async (variant) => {
      const h = harness();
      h.image.Id = h.digest;
      if (variant !== "missing")
        h.image.Descriptor = {
          digest: variant === "mismatch" ? imageId : h.digest,
          mediaType:
            variant === "index"
              ? "application/vnd.oci.image.index.v1+json"
              : variant === "list"
                ? "application/vnd.docker.distribution.manifest.list.v2+json"
                : "application/vnd.oci.image.manifest.v1+json",
        };
      await expect(h.execute()).rejects.toThrow("Built image identity");
      expect(h.dockerCalls("tag")).toHaveLength(0);
      expect(h.dockerCalls("push")).toHaveLength(0);
    },
  );

  it("accepts a registry manifest format change that preserves the tested config", async () => {
    const h = harness();
    h.image.Id = h.digest;
    h.image.Descriptor = {
      digest: h.digest,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
    };
    const remoteManifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: { digest: imageId },
      layers: [],
    });
    const remoteDigest = `sha256:${createHash("sha256").update(remoteManifest).digest("hex")}`;
    h.remote.images[0].imageManifest = remoteManifest;
    h.remote.images[0].imageId.imageDigest = remoteDigest;
    h.scan.imageId.imageDigest = remoteDigest;
    const result = await h.execute();
    expect(remoteDigest).not.toBe(h.digest);
    expect(result.receipt).toMatchObject({
      testedImageId: h.digest,
      testedConfigDigest: imageId,
      digest: remoteDigest,
    });
  });

  it("never logs in, tags, or pushes when archived smoke fails", async () => {
    const h = harness();
    h.overrides.smoke = new Error("smoke failed");
    await expect(h.execute()).rejects.toThrow("smoke failed");
    expect(h.dockerCalls("tag")).toHaveLength(0);
    expect(h.dockerCalls("login")).toHaveLength(0);
    expect(h.dockerCalls("push")).toHaveLength(0);
    expect(readdirSync(h.directory)).toEqual([]);
  });

  it.each(["Architecture", "Os", "User", "revision"])(
    "refuses an unexpected built image %s",
    async (field) => {
      const h = harness();
      if (field === "Architecture") h.image.Architecture = "arm64";
      if (field === "Os") h.image.Os = "windows";
      if (field === "User") h.image.Config.User = "root";
      if (field === "revision")
        h.image.Config.Labels["org.opencontainers.image.revision"] = "c".repeat(40);
      await expect(h.execute()).rejects.toThrow("Built image");
      expect(h.dockerCalls("push")).toHaveLength(0);
    },
  );

  it.each([
    "account",
    "root",
    "repository",
    "ownership",
    "mutability",
    "encryption",
    "registry scan",
    "coverage",
  ])("fails preflight for mismatched %s", async (field) => {
    const h = harness();
    if (field === "account") h.identity.Account = "999999999999";
    if (field === "root") h.identity.Arn = `arn:aws:iam::${account}:root`;
    if (field === "repository") h.repo.repositoryUri = "other.example/web";
    if (field === "ownership") h.overrides["list-tags-for-resource"] = { tags: [] };
    if (field === "mutability") h.repo.imageTagMutability = "MUTABLE";
    if (field === "encryption") h.repo.encryptionConfiguration.encryptionType = "KMS";
    if (field === "registry scan") h.registryScan.scanningConfiguration.scanType = "ENHANCED";
    if (field === "coverage") h.effective.scanningConfigurations[0].scanFrequency = "MANUAL";
    await expect(h.execute()).rejects.toThrow();
    expect(h.dockerCalls("buildx")).toHaveLength(0);
    expect(h.dockerCalls("push")).toHaveLength(0);
  });

  it.each([awsError("AccessDeniedException"), { imageDetails: [] }])(
    "does not mistake an access error or existing tag for absence",
    async (value) => {
      const h = harness();
      h.overrides["describe-images"] = value;
      await expect(h.execute()).rejects.toThrow();
      expect(h.dockerCalls("buildx")).toHaveLength(0);
    },
  );

  it("rejects a remote context even when DOCKER_HOST is local", async () => {
    const h = harness();
    h.env.DOCKER_HOST = "unix:///local.sock";
    h.setEndpoint("ssh://remote.example");
    await expect(h.execute()).rejects.toThrow("local Docker Unix socket");
    expect(h.dockerCalls("buildx")).toHaveLength(0);
  });

  it("refuses a revision outside freshly fetched Wallie main", async () => {
    const h = harness();
    h.overrides["git:merge-base"] = new Error("not reviewed");
    await expect(h.execute()).rejects.toThrow("not reviewed");
    expect(h.calls.some((call) => call.command === "aws")).toBe(false);
  });

  it("binds each AWS phase to validated temporary credentials without exposing them to Docker", async () => {
    const h = harness();
    const refreshed = {
      ...h.credentials,
      AccessKeyId: "refreshed-session-key",
      SessionToken: "refreshed-token",
    };
    h.credentialResponses.push(h.credentials, refreshed);
    const result = await h.execute();
    const exports = h.calls.filter(
      (call) => call.command === "aws" && call.args[1] === "export-credentials",
    );
    expect(exports).toHaveLength(2);
    const smoke = h.calls.find((call) => call.command === process.execPath)!;
    expect(h.calls.indexOf(exports[1])).toBeGreaterThan(h.calls.indexOf(smoke));
    const awsCalls = h.calls.filter(
      (call) => call.command === "aws" && call.args[1] !== "export-credentials",
    );
    for (const call of awsCalls) {
      const expected =
        h.calls.indexOf(call) < h.calls.indexOf(exports[1]) ? h.credentials : refreshed;
      expect(call.options.env?.AWS_ACCESS_KEY_ID).toBe(expected.AccessKeyId);
      expect(call.options.env?.AWS_SESSION_TOKEN).toBe(expected.SessionToken);
      expect(call.args).not.toContain("--profile");
    }
    const publicEvidence = JSON.stringify([result.receipt, h.calls.map((call) => call.args)]);
    expect(publicEvidence).not.toContain(h.credentials.SecretAccessKey);
    expect(publicEvidence).not.toContain(refreshed.SessionToken);
    for (const call of h.calls.filter(
      (call) => call.command === "docker" || call.command === process.execPath,
    ))
      expect([h.credentials.AccessKeyId, refreshed.AccessKeyId]).not.toContain(
        call.options.env?.AWS_ACCESS_KEY_ID,
      );
  });

  it("rejects long-lived profile credentials before AWS preflight or Docker", async () => {
    const h = harness();
    h.credentialResponses.push({
      ...h.credentials,
      SessionToken: undefined,
      Expiration: undefined,
    });
    await expect(h.execute()).rejects.toThrow("temporary session credentials");
    expect(h.calls.some((call) => call.args[1] === "get-caller-identity")).toBe(false);
    expect(h.dockerCalls("buildx")).toHaveLength(0);
  });

  it("stops before upload if credentials refresh to a different AWS identity", async () => {
    const h = harness();
    h.identityResponses.push(h.identity, {
      ...h.identity,
      Arn: `arn:aws:iam::${account}:user/another-user`,
    });
    await expect(h.execute()).rejects.toThrow("AWS identity changed");
    expect(h.calls.some((call) => call.command === process.execPath)).toBe(true);
    expect(h.dockerCalls("tag")).toHaveLength(0);
    expect(h.dockerCalls("login")).toHaveLength(0);
    expect(h.dockerCalls("push")).toHaveLength(0);
  });

  it("preserves an attempted receipt when push outcome is uncertain", async () => {
    const h = harness();
    h.overrides["docker:push"] = new Error("network interrupted");
    await expect(h.execute()).rejects.toThrow("network interrupted");
    expect(h.receipt()).toMatchObject({
      uploadStatus: "attempted",
      digest: null,
      deployable: false,
    });
    expect(h.receipt().tag).toContain(revision);
    expect(existsSync(h.dockerCalls("login")[0].options.env!.DOCKER_CONFIG!)).toBe(false);
  });

  it.each(["config", "manifest"])(
    "rejects a mismatched remote %s digest before scan",
    async (field) => {
      const h = harness();
      if (field === "config")
        h.remote.images[0].imageManifest = JSON.stringify({ config: { digest: "different" } });
      else h.remote.images[0].imageId.imageDigest = `sha256:${"d".repeat(64)}`;
      await expect(h.execute()).rejects.toThrow("Pushed manifest");
      expect(h.receipt()).toMatchObject({ uploadStatus: "confirmed", deployable: false });
      expect(h.calls.some((call) => call.args[1] === "describe-image-scan-findings")).toBe(false);
    },
  );

  it("waits through an initial missing scan and pending states, always by digest", async () => {
    const h = harness();
    h.scanResponses.push(
      awsError("ScanNotFoundException"),
      { ...h.scan, imageScanStatus: { status: "PENDING" } },
      { ...h.scan, imageScanStatus: { status: "IN_PROGRESS" } },
    );
    await h.execute();
    const scans = h.calls.filter((call) => call.args[1] === "describe-image-scan-findings");
    expect(scans).toHaveLength(4);
    expect(scans.every((call) => call.args.includes(`imageDigest=${h.digest}`))).toBe(true);
  });

  it.each(["2026-09-22T01:00:01Z", Date.parse("2026-09-22T01:00:01Z") / 1000])(
    "accepts a fresh scan completed during the push command (%s)",
    async (completedAt) => {
      const h = harness();
      h.scan.imageScanFindings.imageScanCompletedAt = completedAt;
      const result = await h.execute();
      expect(result.receipt).toMatchObject({
        startedAt: "2026-09-22T01:00:00.500Z",
        pushedAt: "2026-09-22T01:00:01.500Z",
        scan: { fresh: true, completedAt },
      });
    },
  );

  it.each(["2026-09-21T01:00:00Z", "2026-09-22T01:00:00.400Z", "2026-09-22T01:00:00.500Z"])(
    "never accepts completed findings at or before the upload marker (%s)",
    async (completedAt) => {
      const h = harness();
      h.scan.imageScanFindings.imageScanCompletedAt = completedAt;
      await expect(h.execute()).rejects.toThrow("scan timed out");
      expect(h.receipt()).toMatchObject({
        digest: h.digest,
        deployable: false,
        scan: { status: "COMPLETE", fresh: false, completedAt },
      });
      expect(
        h.calls.filter((call) => call.args[1] === "describe-image-scan-findings"),
      ).toHaveLength(60);
    },
  );

  it("waits past stale findings and checks newly completed findings", async () => {
    const h = harness();
    h.scanResponses.push({
      ...h.scan,
      imageScanFindings: {
        imageScanCompletedAt: "2026-09-21T01:00:00Z",
        findingSeverityCounts: {},
      },
    });
    h.scan.imageScanFindings.findingSeverityCounts.HIGH = 1;
    await expect(h.execute()).rejects.toThrow("HIGH or CRITICAL");
    expect(h.receipt().scan).toMatchObject({ fresh: true, counts: { HIGH: 1 } });
    expect(h.calls.filter((call) => call.args[1] === "describe-image-scan-findings")).toHaveLength(
      2,
    );
  });

  it.each(["2026-09-22T01:00:02Z", Date.parse("2026-09-22T01:00:02Z") / 1000])(
    "fails closed for a scan timestamp in the future (%s)",
    async (completedAt) => {
      const h = harness();
      h.scan.imageScanFindings.imageScanCompletedAt = completedAt;
      await expect(h.execute()).rejects.toThrow("timestamp is in the future");
      expect(h.receipt().scan.fresh).toBe(false);
    },
  );

  it.each([null, "2026-09-22T01:00:01", "invalid", 0, -1])(
    "rejects invalid or unzoned scan timestamps (%s)",
    async (completedAt) => {
      const h = harness();
      h.overrides["describe-image-scan-findings"] = {
        ...h.scan,
        imageScanFindings: { ...h.scan.imageScanFindings, imageScanCompletedAt: completedAt },
      };
      await expect(h.execute()).rejects.toThrow("findings are missing or invalid");
    },
  );

  it.each(["FAILED", "UNSUPPORTED_IMAGE", "ACTIVE", "FINDINGS_UNAVAILABLE", "unknown"])(
    "does not accept scan status %s",
    async (status) => {
      const h = harness();
      h.scan.imageScanStatus.status = status;
      await expect(h.execute()).rejects.toThrow("scan is not complete");
      expect(h.receipt().scan.status).toBe(status);
    },
  );

  it.each(["HIGH", "CRITICAL"])(
    "records and blocks %s findings without deleting the pushed image",
    async (severity) => {
      const h = harness();
      h.scan.imageScanFindings.findingSeverityCounts[severity] = 1;
      await expect(h.execute()).rejects.toThrow("HIGH or CRITICAL");
      expect(h.receipt().scan.counts?.[severity]).toBe(1);
      expect(h.calls.some((call) => call.args.some((arg) => /delete/.test(arg)))).toBe(false);
    },
  );

  it.each([null, [], { HIGH: -1 }, { CRITICAL: "0" }, { FUTURE_SEVERITY: 3 }])(
    "fails closed for invalid finding counts %j",
    async (counts) => {
      const h = harness();
      h.overrides["describe-image-scan-findings"] = {
        ...h.scan,
        imageScanFindings: { ...h.scan.imageScanFindings, findingSeverityCounts: counts },
      };
      await expect(h.execute()).rejects.toThrow("findings are missing or invalid");
    },
  );

  it("bounds waiting for an incomplete scan and retains the image reference", async () => {
    const h = harness();
    h.scan.imageScanStatus.status = "IN_PROGRESS";
    await expect(h.execute()).rejects.toThrow("scan timed out");
    expect(h.receipt().digest).toBe(h.digest);
    expect(h.calls.filter((call) => call.args[1] === "describe-image-scan-findings")).toHaveLength(
      60,
    );
  });

  it("validates invocation arguments before commands can run", () => {
    expect(parsePublishArgs(argumentsFor())).toEqual(base);
    for (const changes of [
      { component: "database" },
      { revision: "abc123" },
      { "account-id": "123" },
      { region: "us_west_2" },
      { profile: "" },
    ]) {
      expect(() => parsePublishArgs(argumentsFor({ ...base, ...changes }))).toThrow();
    }
    expect(() => parsePublishArgs([...argumentsFor(), "--component", "worker"])).toThrow();
  });

  it("redacts child output and arguments from command failure messages", async () => {
    await expect(
      runCommand(process.execPath, [
        "--eval",
        'process.stderr.write("synthetic-secret"); process.exit(7)',
      ]),
    ).rejects.toThrow("exit 7");
    await expect(
      runCommand(process.execPath, [
        "--eval",
        'process.stderr.write("synthetic-secret"); process.exit(7)',
      ]),
    ).rejects.not.toThrow("synthetic-secret");
  });

  it("awaits child cleanup before rejecting an interrupted command", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wallie-publisher-abort-"));
    directories.push(directory);
    const ready = join(directory, "ready");
    const cleaned = join(directory, "cleaned");
    const controller = new AbortController();
    const command = runCommand(
      process.execPath,
      [
        "--eval",
        `const fs=require('node:fs'); process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(cleaned)},'yes');process.exit(0)},30));fs.writeFileSync(${JSON.stringify(ready)},'yes');setInterval(()=>{},1000)`,
      ],
      { signal: controller.signal },
    );
    const rejection = expect(command).rejects.toThrow("interrupted");
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
    controller.abort();
    await rejection;
    expect(existsSync(cleaned)).toBe(true);
  });
});

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
  startedAt: number;
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
  signed: boolean | null;
  signing?: { status: string };
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
type Aws = (service: string, operation: string, args?: string[]) => Promise<unknown>;
type SigningInput = {
  aws: Aws;
  getCredentials: () => Promise<{ env: NodeJS.ProcessEnv; expiration: string }>;
  receipt: Receipt;
  saveReceipt: () => void;
  nonce: string;
};
type Signing = {
  verifyProfile: (aws: Aws) => Promise<void>;
  signAndVerify: (input: SigningInput) => Promise<void>;
};
let parsePublishArgs: (args: string[], env?: NodeJS.ProcessEnv) => Options;
let formatPublishResult: (receipt: Receipt) => string;
let publishImage: (
  options: Options,
  dependencies: {
    run: Runner;
    cwd: string;
    env: NodeJS.ProcessEnv;
    tempRoot: string;
    now: () => number;
    wait: (ms: number) => Promise<void>;
    prepareSigning: (input: Record<string, unknown>) => Promise<Signing>;
  },
) => Promise<{ receipt: Receipt; receiptPath: string }>;
let runCommand: Runner;
beforeAll(async () => {
  const script = new URL("../../../scripts/publish-aws-image.mjs", import.meta.url).href;
  ({ parsePublishArgs, publishImage, runCommand, formatPublishResult } = await import(script));
});
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const account = "123456789012";
const revision = "a".repeat(40);
const imageId = `sha256:${"b".repeat(64)}`;
const signingVersion = "A1b2C3d4E5";
const base = {
  component: "web",
  "account-id": account,
  region: "us-west-2",
  revision,
  profile: "wallie-staging",
};
const argumentsFor = (options: Options = base) =>
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
  const identity = {
    Account: account,
    Arn: `arn:aws:iam::${account}:user/wallie-local`,
    UserId: "AIDAABCDEFGHIJKLMNOPQ",
  };
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
  const responses: Record<string, unknown[]> = {};
  const durations: Record<string, number> = {};
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
    AWS_SECURITY_TOKEN: "legacy-token",
    AWS_PROFILE: "ambient-profile",
    AWS_DEFAULT_PROFILE: "ambient-default",
    AWS_CONFIG_FILE: "/selected-profile/config",
    AWS_SHARED_CREDENTIALS_FILE: "/selected-profile/credentials",
    AWS_WEB_IDENTITY_TOKEN_FILE: "/ambient/web-token",
    AWS_ROLE_ARN: `arn:aws:iam::${account}:role/ambient`,
    AWS_ROLE_SESSION_NAME: "ambient-session",
    AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://ambient.invalid",
    AWS_CONTAINER_AUTHORIZATION_TOKEN: "ambient-container-token",
    BOTO_CONFIG: "/ambient/boto-config",
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
    calls.push({ command, args, options, startedAt: time });
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
    time += durations[operation] ?? 0;
    if (responses[operation]?.length) {
      const value = responses[operation].shift();
      if (value instanceof Error) throw value;
      return typeof value === "string" ? value : JSON.stringify(value);
    }
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
  const signingPhases: { phase: string; calls: number }[] = [];
  const verifyProfile = vi.fn<Signing["verifyProfile"]>(async () => {
    signingPhases.push({ phase: "profile", calls: calls.length });
  });
  const signAndVerify = vi.fn<Signing["signAndVerify"]>(async ({ receipt, saveReceipt }) => {
    signingPhases.push({ phase: "sign", calls: calls.length });
    receipt.signed = true;
    receipt.signing = { status: "verified" };
    saveReceipt();
  });
  const prepareSigning = vi.fn<(input: Record<string, unknown>) => Promise<Signing>>(async () => {
    signingPhases.push({ phase: "prepare", calls: calls.length });
    return { verifyProfile, signAndVerify };
  });
  const execute = (signing = false) =>
    publishImage(
      { ...base, component, ...(signing ? { "signing-profile-version": signingVersion } : {}) },
      {
        run,
        cwd: directory,
        env,
        tempRoot: directory,
        now: () => time,
        wait: async (ms) => {
          time += ms;
        },
        prepareSigning,
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
    responses,
    durations,
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
    prepareSigning,
    verifyProfile,
    signAndVerify,
    signingPhases,
    now: () => time,
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
      expect(h.prepareSigning).not.toHaveBeenCalled();
      expect(h.verifyProfile).not.toHaveBeenCalled();
      expect(h.signAndVerify).not.toHaveBeenCalled();
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
      await expect(h.execute(true)).rejects.toThrow("Built image identity");
      expect(h.signAndVerify).not.toHaveBeenCalled();
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
    await expect(h.execute(true)).rejects.toThrow("smoke failed");
    expect(h.signAndVerify).not.toHaveBeenCalled();
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
      await expect(h.execute(true)).rejects.toThrow("Built image");
      expect(h.signAndVerify).not.toHaveBeenCalled();
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
    await expect(h.execute(true)).rejects.toThrow();
    expect(h.signAndVerify).not.toHaveBeenCalled();
    expect(h.dockerCalls("buildx")).toHaveLength(0);
    expect(h.dockerCalls("push")).toHaveLength(0);
  });

  it.each([awsError("AccessDeniedException"), { imageDetails: [] }])(
    "does not mistake an access error or existing tag for absence",
    async (value) => {
      const h = harness();
      h.overrides["describe-images"] = value;
      await expect(h.execute(true)).rejects.toThrow();
      expect(h.signAndVerify).not.toHaveBeenCalled();
      expect(h.dockerCalls("buildx")).toHaveLength(0);
    },
  );

  it("rejects a remote context even when DOCKER_HOST is local", async () => {
    const h = harness();
    h.env.DOCKER_HOST = "unix:///local.sock";
    h.setEndpoint("ssh://remote.example");
    await expect(h.execute(true)).rejects.toThrow("local Docker Unix socket");
    expect(h.signAndVerify).not.toHaveBeenCalled();
    expect(h.dockerCalls("buildx")).toHaveLength(0);
  });

  it("refuses a revision outside freshly fetched Wallie main", async () => {
    const h = harness();
    h.overrides["git:merge-base"] = new Error("not reviewed");
    await expect(h.execute(true)).rejects.toThrow("not reviewed");
    expect(h.signAndVerify).not.toHaveBeenCalled();
    expect(h.calls.some((call) => call.command === "aws")).toBe(false);
  });

  it("binds each AWS phase to validated temporary credentials without exposing them to Docker", async () => {
    const h = harness();
    const refreshed = {
      ...h.credentials,
      AccessKeyId: "refreshed-session-key",
      SessionToken: "refreshed-token",
    };
    h.credentialResponses.push(h.credentials, refreshed, refreshed);
    const result = await h.execute();
    const exports = h.calls.filter(
      (call) => call.command === "aws" && call.args[1] === "export-credentials",
    );
    expect(exports).toHaveLength(3);
    const smoke = h.calls.find((call) => call.command === process.execPath)!;
    expect(h.calls.indexOf(exports[1])).toBeGreaterThan(h.calls.indexOf(smoke));
    expect(h.calls.indexOf(exports[2])).toBeGreaterThan(h.calls.indexOf(h.dockerCalls("push")[0]));
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
    for (const call of h.calls.filter((call) => call.command !== "aws")) {
      expect(
        Object.keys(call.options.env ?? {}).filter((key) => /^AWS_|^BOTO_CONFIG$/i.test(key)),
      ).toEqual([]);
    }
    for (const call of exports) {
      expect(call.options.env?.AWS_CONFIG_FILE).toBe(h.env.AWS_CONFIG_FILE);
      expect(call.options.env?.AWS_SHARED_CREDENTIALS_FILE).toBe(h.env.AWS_SHARED_CREDENTIALS_FILE);
    }
    expect(h.env.AWS_ACCESS_KEY_ID).toBe("ambient-key");
    expect(h.calls.some((call) => call.command === "git")).toBe(true);
    expect(h.calls.some((call) => call.command === "tar")).toBe(true);
    expect(h.calls.some((call) => call.command === "docker" && call.args[0] === "context")).toBe(
      true,
    );
    expect(h.dockerCalls("buildx")).toHaveLength(1);
    expect(h.dockerCalls("login")).toHaveLength(1);
    expect(h.dockerCalls("push")).toHaveLength(1);
  });

  it("rejects long-lived profile credentials before AWS preflight or Docker", async () => {
    const h = harness();
    h.credentialResponses.push({
      ...h.credentials,
      SessionToken: undefined,
      Expiration: undefined,
    });
    await expect(h.execute(true)).rejects.toThrow("temporary session credentials");
    expect(h.signAndVerify).not.toHaveBeenCalled();
    expect(h.calls.some((call) => call.args[1] === "get-caller-identity")).toBe(false);
    expect(h.dockerCalls("buildx")).toHaveLength(0);
  });

  it("refreshes after a push that outlives the upload session before reading ECR", async () => {
    const h = harness();
    const shortSession = {
      ...h.credentials,
      Expiration: new Date(h.now() + 15 * 60_000).toISOString(),
    };
    const afterPush = {
      ...h.credentials,
      AccessKeyId: "post-push-session",
      Expiration: new Date(h.now() + 35 * 60_000).toISOString(),
    };
    h.credentialResponses.push(shortSession, shortSession, afterPush);
    h.durations["docker:push"] = 20 * 60_000;
    await h.execute();
    const push = h.dockerCalls("push")[0];
    const postPushCalls = h.calls.slice(h.calls.indexOf(push) + 1);
    expect(postPushCalls.slice(0, 3).map((call) => call.args[1])).toEqual([
      "export-credentials",
      "get-caller-identity",
      "batch-get-image",
    ]);
    for (const call of postPushCalls.filter((call) => call.args[0] === "ecr"))
      expect(call.options.env?.AWS_ACCESS_KEY_ID).toBe(afterPush.AccessKeyId);
    expect(h.dockerCalls("push")).toHaveLength(1);
    expect(h.receipt()).toMatchObject({ uploadStatus: "confirmed", scan: { fresh: true } });
  });

  it("refreshes an expiring snapshot during the scan without restarting the upload", async () => {
    const h = harness();
    const scanningSession = {
      ...h.credentials,
      AccessKeyId: "early-scan-session",
      Expiration: new Date(h.now() + 3 * 60_000).toISOString(),
    };
    const renewed = { ...h.credentials, AccessKeyId: "renewed-scan-session" };
    h.credentialResponses.push(h.credentials, h.credentials, scanningSession, renewed);
    h.scanResponses.push(
      ...Array.from({ length: 5 }, () => ({
        ...h.scan,
        imageScanStatus: { status: "IN_PROGRESS" },
      })),
    );
    await h.execute();
    const scans = h.calls.filter((call) => call.args[1] === "describe-image-scan-findings");
    expect(scans.map((call) => call.options.env?.AWS_ACCESS_KEY_ID)).toEqual([
      "early-scan-session",
      "early-scan-session",
      "early-scan-session",
      "renewed-scan-session",
      "renewed-scan-session",
      "renewed-scan-session",
    ]);
    const renewal = h.calls.find(
      (call) =>
        call.args[1] === "get-caller-identity" &&
        call.options.env?.AWS_ACCESS_KEY_ID === renewed.AccessKeyId,
    )!;
    expect(h.calls.indexOf(renewal)).toBeLessThan(h.calls.indexOf(scans[3]));
    for (const call of scans) {
      const session =
        call.options.env?.AWS_ACCESS_KEY_ID === renewed.AccessKeyId ? renewed : scanningSession;
      expect(Date.parse(session.Expiration) - call.startedAt).toBeGreaterThan(
        call.options.timeout! + 30_000,
      );
    }
    expect(h.dockerCalls("push")).toHaveLength(1);
    expect(h.receipt()).toMatchObject({ startedAt: "2026-09-22T01:00:00.500Z" });
  });

  it("checks remaining lifetime between preflight calls", async () => {
    const h = harness();
    h.credentialResponses.push(
      {
        ...h.credentials,
        Expiration: new Date(h.now() + 3 * 60_000).toISOString(),
      },
      { ...h.credentials, AccessKeyId: "renewed-preflight-session" },
    );
    h.durations["describe-repositories"] = 40_000;
    h.scan.imageScanFindings.imageScanCompletedAt = new Date(h.now() + 40_500).toISOString();
    await h.execute();
    const tags = h.calls.find((call) => call.args[1] === "list-tags-for-resource")!;
    expect(tags.options.env?.AWS_ACCESS_KEY_ID).toBe("renewed-preflight-session");
    const validation = h.calls.find(
      (call) =>
        call.args[1] === "get-caller-identity" &&
        call.options.env?.AWS_ACCESS_KEY_ID === "renewed-preflight-session",
    )!;
    expect(h.calls.indexOf(validation)).toBeLessThan(h.calls.indexOf(tags));
  });

  it.each(["initial", "after-build"])(
    "rejects a near-expiry %s session before STS or upload",
    async (phase) => {
      const h = harness();
      if (phase === "after-build") h.credentialResponses.push(h.credentials);
      h.credentialResponses.push({
        ...h.credentials,
        Expiration: new Date(h.now() + 150_000).toISOString(),
      });
      await expect(h.execute(true)).rejects.toThrow("expire too soon");
      expect(h.signAndVerify).not.toHaveBeenCalled();
      expect(h.calls.filter((call) => call.args[1] === "get-caller-identity")).toHaveLength(
        phase === "initial" ? 0 : 1,
      );
      expect(h.dockerCalls("push")).toHaveLength(0);
      if (phase === "initial") expect(h.calls.some((call) => call.args[0] === "ecr")).toBe(false);
    },
  );

  it("rejects a snapshot whose STS validation consumed the request reserve", async () => {
    const h = harness();
    h.credentialResponses.push({
      ...h.credentials,
      Expiration: new Date(h.now() + 4 * 60_000).toISOString(),
    });
    h.durations["get-caller-identity"] = 100_000;
    await expect(h.execute(true)).rejects.toThrow("expire too soon");
    expect(h.signAndVerify).not.toHaveBeenCalled();
    expect(h.calls.filter((call) => call.args[1] === "get-caller-identity")).toHaveLength(1);
    expect(h.calls.some((call) => call.args[0] === "ecr")).toBe(false);
  });

  it("fails before push if login consumes the reserve and the provider cannot renew", async () => {
    const h = harness();
    const short = { ...h.credentials, Expiration: new Date(h.now() + 3 * 60_000).toISOString() };
    h.credentialResponses.push(h.credentials, short, short);
    h.durations["docker:login"] = 40_000;
    await expect(h.execute(true)).rejects.toThrow("expire too soon");
    expect(h.signAndVerify).not.toHaveBeenCalled();
    expect(h.calls.filter((call) => call.args[1] === "export-credentials")).toHaveLength(3);
    expect(h.dockerCalls("login")).toHaveLength(1);
    expect(h.dockerCalls("push")).toHaveLength(0);
    expect(readdirSync(h.directory)).toEqual([]);
  });

  it("preserves the pushed receipt and stops before ECR if the post-push principal changes", async () => {
    const h = harness();
    h.identityResponses.push(h.identity, h.identity, {
      ...h.identity,
      UserId: "AIDAZYXWVUTSRQPONMLKJ",
    });
    await expect(h.execute(true)).rejects.toThrow("AWS identity changed");
    expect(h.signAndVerify).not.toHaveBeenCalled();
    expect(h.dockerCalls("push")).toHaveLength(1);
    expect(h.calls.some((call) => call.args[1] === "batch-get-image")).toBe(false);
    expect(h.receipt()).toMatchObject({
      uploadStatus: "confirmed",
      digest: null,
      signed: false,
      deployable: false,
    });
    expect(existsSync(h.dockerCalls("login")[0].options.env!.DOCKER_CONFIG!)).toBe(false);
  });

  it.each(["ExpiredToken", "ExpiredTokenException"])(
    "refreshes once for a scan %s response",
    async (code) => {
      const h = harness();
      h.credentialResponses.push(h.credentials, h.credentials, h.credentials, {
        ...h.credentials,
        AccessKeyId: "expiry-retry-session",
      });
      h.scanResponses.push(awsError(code));
      await h.execute();
      const scans = h.calls.filter((call) => call.args[1] === "describe-image-scan-findings");
      expect(scans).toHaveLength(2);
      expect(scans[1].options.env?.AWS_ACCESS_KEY_ID).toBe("expiry-retry-session");
      expect(h.calls.filter((call) => call.args[1] === "get-caller-identity")).toHaveLength(4);
      expect(h.dockerCalls("push")).toHaveLength(1);
    },
  );

  it("bounds repeated expiry errors and retains the already-published image", async () => {
    const h = harness();
    h.scanResponses.push(awsError("ExpiredTokenException"), awsError("ExpiredTokenException"));
    await expect(h.execute(true)).rejects.toThrow("ExpiredTokenException");
    expect(h.signAndVerify).not.toHaveBeenCalled();
    expect(h.calls.filter((call) => call.args[1] === "export-credentials")).toHaveLength(4);
    expect(h.calls.filter((call) => call.args[1] === "describe-image-scan-findings")).toHaveLength(
      2,
    );
    expect(h.receipt()).toMatchObject({
      uploadStatus: "confirmed",
      digest: h.digest,
      deployable: false,
    });
  });

  it("rejects an identity change during scan refresh before another ECR request", async () => {
    const h = harness();
    h.identityResponses.push(h.identity, h.identity, h.identity, {
      ...h.identity,
      Arn: `arn:aws:iam::${account}:user/another-publisher`,
    });
    h.scanResponses.push(awsError("ExpiredTokenException"));
    await expect(h.execute(true)).rejects.toThrow("AWS identity changed");
    expect(h.signAndVerify).not.toHaveBeenCalled();
    expect(h.calls.filter((call) => call.args[1] === "describe-image-scan-findings")).toHaveLength(
      1,
    );
    expect(h.receipt()).toMatchObject({
      uploadStatus: "confirmed",
      digest: h.digest,
      deployable: false,
    });
  });

  it("preserves the confirmed upload when the provider cannot renew after push", async () => {
    const h = harness();
    h.credentialResponses.push(h.credentials, h.credentials, {});
    await expect(h.execute(true)).rejects.toThrow("temporary session credentials");
    expect(h.signAndVerify).not.toHaveBeenCalled();
    expect(h.calls.some((call) => call.args[1] === "batch-get-image")).toBe(false);
    expect(h.receipt()).toMatchObject({
      uploadStatus: "confirmed",
      digest: null,
      deployable: false,
    });
    expect(existsSync(h.dockerCalls("login")[0].options.env!.DOCKER_CONFIG!)).toBe(false);
  });

  it("does not retry ECR access errors as credential expiry", async () => {
    const h = harness();
    h.scanResponses.push(awsError("AccessDeniedException"));
    await expect(h.execute(true)).rejects.toThrow("AccessDeniedException");
    expect(h.signAndVerify).not.toHaveBeenCalled();
    expect(h.calls.filter((call) => call.args[1] === "export-credentials")).toHaveLength(3);
    expect(h.calls.filter((call) => call.args[1] === "describe-image-scan-findings")).toHaveLength(
      1,
    );
  });

  it.each(["web", "worker"])(
    "isolates Docker trust controls and passphrases throughout %s publishing",
    async (component) => {
      const h = harness(component);
      Object.assign(h.env, {
        DOCKER_CONTENT_TRUST: "1",
        DOCKER_CONTENT_TRUST_SERVER: "https://untrusted-notary.invalid",
        DOCKER_CONTENT_TRUST_ROOT_PASSPHRASE: "synthetic-root-passphrase",
        DOCKER_CONTENT_TRUST_REPOSITORY_PASSPHRASE: "synthetic-repository-passphrase",
        docker_content_trust: "1",
      });
      const result = await h.execute();
      const processes = h.calls.filter(
        (call) => call.command === "docker" || call.command === process.execPath,
      );
      expect(processes.length).toBeGreaterThan(5);
      for (const call of processes)
        expect(
          Object.keys(call.options.env ?? {}).filter((name) =>
            name.toUpperCase().startsWith("DOCKER_CONTENT_TRUST"),
          ),
        ).toEqual([]);
      expect(result.receipt.signed).toBe(false);
      expect(h.env.DOCKER_CONTENT_TRUST).toBe("1");
    },
  );

  it("stops before upload if credentials refresh to a different AWS identity", async () => {
    const h = harness();
    h.identityResponses.push(h.identity, {
      ...h.identity,
      Arn: `arn:aws:iam::${account}:user/another-user`,
    });
    await expect(h.execute(true)).rejects.toThrow("AWS identity changed");
    expect(h.signAndVerify).not.toHaveBeenCalled();
    expect(h.calls.some((call) => call.command === process.execPath)).toBe(true);
    expect(h.dockerCalls("tag")).toHaveLength(0);
    expect(h.dockerCalls("login")).toHaveLength(0);
    expect(h.dockerCalls("push")).toHaveLength(0);
  });

  it.each(["web", "worker"])(
    "allows a refreshed session for the same %s publishing role",
    async (component) => {
      const h = harness(component);
      const role = (session: string) => ({
        Account: account,
        Arn: `arn:aws:sts::${account}:assumed-role/WalliePublisher/${session}`,
        UserId: `AROAABCDEFGHIJKLMNOPQ:${session}`,
      });
      h.identityResponses.push(role("before-build"), role("after-build"), role("after-push"));
      h.credentialResponses.push(h.credentials, {
        ...h.credentials,
        AccessKeyId: "refreshed-role-key",
      });
      await h.execute();
      expect(h.dockerCalls("push")).toHaveLength(1);
      expect(h.calls.filter((call) => call.args[1] === "get-caller-identity")).toHaveLength(3);
    },
  );

  it.each(["role name", "role id", "account", "partition", "principal type"])(
    "stops before upload when a role refresh changes its %s",
    async (field) => {
      const h = harness();
      const initial = {
        Account: account,
        Arn: `arn:aws:sts::${account}:assumed-role/WalliePublisher/before-build`,
        UserId: "AROAABCDEFGHIJKLMNOPQ:before-build",
      };
      let refreshed = {
        ...initial,
        Arn: `arn:aws:sts::${account}:assumed-role/WalliePublisher/after-build`,
        UserId: "AROAABCDEFGHIJKLMNOPQ:after-build",
      };
      if (field === "role name")
        refreshed.Arn = refreshed.Arn.replace("WalliePublisher", "AnotherRole");
      if (field === "role id") refreshed.UserId = "AROAZYXWVUTSRQPONMLKJ:after-build";
      if (field === "account") {
        refreshed.Account = "999999999999";
        refreshed.Arn = refreshed.Arn.replace(account, refreshed.Account);
      }
      if (field === "partition") refreshed.Arn = refreshed.Arn.replace("arn:aws:", "arn:aws-cn:");
      if (field === "principal type") refreshed = h.identity;
      h.identityResponses.push(initial, refreshed);
      await expect(h.execute(true)).rejects.toThrow();
      expect(h.signAndVerify).not.toHaveBeenCalled();
      expect(h.calls.some((call) => call.command === process.execPath)).toBe(true);
      expect(h.dockerCalls("tag")).toHaveLength(0);
      expect(h.dockerCalls("login")).toHaveLength(0);
      expect(h.dockerCalls("push")).toHaveLength(0);
    },
  );

  it("rejects a recreated IAM user even when its ARN is unchanged", async () => {
    const h = harness();
    h.identityResponses.push(h.identity, { ...h.identity, UserId: "AIDAZYXWVUTSRQPONMLKJ" });
    await expect(h.execute(true)).rejects.toThrow("AWS identity changed");
    expect(h.signAndVerify).not.toHaveBeenCalled();
    expect(h.dockerCalls("tag")).toHaveLength(0);
  });

  it("preserves an attempted receipt when push outcome is uncertain", async () => {
    const h = harness();
    h.overrides["docker:push"] = new Error("network interrupted");
    await expect(h.execute(true)).rejects.toThrow("network interrupted");
    expect(h.signAndVerify).not.toHaveBeenCalled();
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
      await expect(h.execute(true)).rejects.toThrow("Pushed manifest");
      expect(h.signAndVerify).not.toHaveBeenCalled();
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
      await expect(h.execute(true)).rejects.toThrow("scan timed out");
      expect(h.signAndVerify).not.toHaveBeenCalled();
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
    await expect(h.execute(true)).rejects.toThrow("HIGH or CRITICAL");
    expect(h.signAndVerify).not.toHaveBeenCalled();
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
      await expect(h.execute(true)).rejects.toThrow("timestamp is in the future");
      expect(h.signAndVerify).not.toHaveBeenCalled();
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
      await expect(h.execute(true)).rejects.toThrow("findings are missing or invalid");
      expect(h.signAndVerify).not.toHaveBeenCalled();
    },
  );

  it.each(["FAILED", "UNSUPPORTED_IMAGE", "ACTIVE", "FINDINGS_UNAVAILABLE", "unknown"])(
    "does not accept scan status %s",
    async (status) => {
      const h = harness();
      h.scan.imageScanStatus.status = status;
      await expect(h.execute(true)).rejects.toThrow("scan is not complete");
      expect(h.signAndVerify).not.toHaveBeenCalled();
      expect(h.receipt().scan.status).toBe(status);
    },
  );

  it.each(["HIGH", "CRITICAL"])(
    "records and blocks %s findings without deleting the pushed image",
    async (severity) => {
      const h = harness();
      h.scan.imageScanFindings.findingSeverityCounts[severity] = 1;
      await expect(h.execute(true)).rejects.toThrow("HIGH or CRITICAL");
      expect(h.signAndVerify).not.toHaveBeenCalled();
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
      await expect(h.execute(true)).rejects.toThrow("findings are missing or invalid");
      expect(h.signAndVerify).not.toHaveBeenCalled();
    },
  );

  it("bounds waiting for an incomplete scan and retains the image reference", async () => {
    const h = harness();
    h.scan.imageScanStatus.status = "IN_PROGRESS";
    await expect(h.execute(true)).rejects.toThrow("scan timed out");
    expect(h.signAndVerify).not.toHaveBeenCalled();
    expect(h.receipt().digest).toBe(h.digest);
    expect(h.calls.filter((call) => call.args[1] === "describe-image-scan-findings")).toHaveLength(
      60,
    );
  });

  it.each(["web", "worker"])(
    "signs the qualified %s digest only after checking the current repository and scan again",
    async (component) => {
      const h = harness(component);
      const result = await h.execute(true);
      expect(h.prepareSigning).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ account, region: base.region, profileVersion: signingVersion }),
      );
      expect(h.verifyProfile).toHaveBeenCalledOnce();
      const buildIndex = h.calls.indexOf(h.dockerCalls("buildx")[0]);
      expect(h.signingPhases.find((item) => item.phase === "profile")!.calls).toBeLessThanOrEqual(
        buildIndex,
      );
      const scans = h.calls.flatMap((call, index) =>
        call.args[1] === "describe-image-scan-findings" ? [index] : [],
      );
      expect(scans).toHaveLength(2);
      const rechecks = h.calls.slice(scans[0] + 1, scans[1]);
      for (const operation of [
        "describe-repositories",
        "list-tags-for-resource",
        "get-registry-scanning-configuration",
        "batch-get-repository-scanning-configuration",
      ])
        expect(rechecks.some((call) => call.args[1] === operation)).toBe(true);
      expect(h.signAndVerify).toHaveBeenCalledOnce();
      const signing = h.signAndVerify.mock.calls[0][0];
      expect(signing.receipt).toBe(result.receipt);
      expect(signing.receipt.digest).toBe(h.digest);
      expect(signing.nonce).toMatch(/^[a-f0-9]{32}$/);
      expect(signing.aws).toBeTypeOf("function");
      expect(signing.getCredentials).toBeTypeOf("function");
      expect(h.signingPhases.find((item) => item.phase === "sign")!.calls).toBeGreaterThan(
        scans[1],
      );
      expect(h.receipt()).toMatchObject({
        digest: h.digest,
        signed: true,
        signing: { status: "verified" },
        deployable: false,
      });
      expect(readdirSync(h.directory)).toEqual([".wallie"]);
    },
  );

  it.each(["toolchain", "profile"])(
    "rejects a failed signing %s preflight before building or uploading",
    async (phase) => {
      const h = harness();
      const error = new Error(`${phase} is not qualified`);
      if (phase === "toolchain") h.prepareSigning.mockRejectedValue(error);
      else h.verifyProfile.mockRejectedValue(error);
      await expect(h.execute(true)).rejects.toThrow(error.message);
      expect(h.dockerCalls("buildx")).toHaveLength(0);
      expect(h.dockerCalls("push")).toHaveLength(0);
      expect(h.signAndVerify).not.toHaveBeenCalled();
      expect(readdirSync(h.directory)).toEqual([]);
    },
  );

  it.each(["identity", "ownership", "mutability", "registry mode", "coverage"])(
    "does not sign when repository %s changes after preflight",
    async (field) => {
      const h = harness();
      if (["identity", "mutability"].includes(field)) {
        const changed = structuredClone(h.repo);
        if (field === "identity") changed.repositoryArn += "-other";
        else changed.imageTagMutability = "MUTABLE";
        h.responses["describe-repositories"] = [
          { repositories: [h.repo] },
          { repositories: [changed] },
        ];
      }
      if (field === "ownership")
        h.responses["list-tags-for-resource"] = [
          { tags: [{ Key: "WallieStack", Value: "wallie-staging-registry" }] },
          { tags: [] },
        ];
      if (field === "registry mode")
        h.responses["get-registry-scanning-configuration"] = [
          h.registryScan,
          { registryId: account, scanningConfiguration: { scanType: "ENHANCED" } },
        ];
      if (field === "coverage") {
        const changed = structuredClone(h.effective);
        changed.scanningConfigurations[0].scanFrequency = "MANUAL";
        h.responses["batch-get-repository-scanning-configuration"] = [h.effective, changed];
      }
      await expect(h.execute(true)).rejects.toThrow();
      expect(h.dockerCalls("push")).toHaveLength(1);
      expect(h.signAndVerify).not.toHaveBeenCalled();
      expect(h.receipt()).toMatchObject({
        uploadStatus: "confirmed",
        signed: false,
        deployable: false,
      });
    },
  );

  it.each(["HIGH", "CRITICAL", "digest", "account", "stale timestamp", "status", "counts"])(
    "does not sign if the final scan recheck changes its %s",
    async (field) => {
      const h = harness();
      const changed = structuredClone(h.scan);
      if (field === "HIGH" || field === "CRITICAL")
        changed.imageScanFindings.findingSeverityCounts[field] = 1;
      if (field === "digest") changed.imageId.imageDigest = imageId;
      if (field === "account") changed.registryId = "999999999999";
      if (field === "stale timestamp")
        changed.imageScanFindings.imageScanCompletedAt = "2026-09-22T01:00:00.500Z";
      if (field === "status") changed.imageScanStatus.status = "IN_PROGRESS";
      if (field === "counts") changed.imageScanFindings.findingSeverityCounts.MEDIUM = -1;
      h.scanResponses.push(h.scan, changed);
      await expect(h.execute(true)).rejects.toThrow();
      expect(h.signAndVerify).not.toHaveBeenCalled();
      expect(h.receipt()).toMatchObject({
        uploadStatus: "confirmed",
        signed: false,
        deployable: false,
      });
    },
  );

  it("accepts a newer passing scan of the same digest at the final recheck", async () => {
    const h = harness();
    const refreshed = structuredClone(h.scan);
    refreshed.imageScanFindings.imageScanCompletedAt = "2026-09-22T01:00:01.250Z";
    h.scanResponses.push(h.scan, refreshed);
    await h.execute(true);
    expect(h.signAndVerify).toHaveBeenCalledOnce();
    expect(h.receipt()).toMatchObject({
      digest: h.digest,
      scan: { fresh: true, completedAt: refreshed.imageScanFindings.imageScanCompletedAt },
      signed: true,
      deployable: false,
    });
  });

  it("propagates a late profile rotation rejection without marking the image signed", async () => {
    const h = harness();
    h.signAndVerify.mockRejectedValue(new Error("Signing profile version changed"));
    await expect(h.execute(true)).rejects.toThrow("Signing profile version changed");
    expect(h.dockerCalls("push")).toHaveLength(1);
    expect(h.receipt()).toMatchObject({
      signed: false,
      deployable: false,
      error: "Signing profile version changed",
    });
  });

  it("revalidates the publishing principal when signing requests a credential snapshot", async () => {
    const h = harness();
    h.signAndVerify.mockImplementation(async ({ getCredentials }) => {
      h.identity.UserId = "AIDAZYXWVUTSRQPONMLKJ";
      await getCredentials();
      throw new Error("Changed principal must never reach the signing command");
    });
    await expect(h.execute(true)).rejects.toThrow("AWS identity changed");
    expect(h.receipt()).toMatchObject({ signed: false, deployable: false });
    expect(h.dockerCalls("push")).toHaveLength(1);
  });

  it.each(["attempted", "signed"])(
    "retains an unconfirmed receipt when signing fails after status %s",
    async (status) => {
      const h = harness();
      h.signAndVerify.mockImplementation(async ({ receipt, saveReceipt }) => {
        receipt.signed = null;
        receipt.signing = { status };
        saveReceipt();
        throw new Error("Signature verification did not complete");
      });
      await expect(h.execute(true)).rejects.toThrow("Signature verification did not complete");
      expect(h.receipt()).toMatchObject({
        signed: null,
        signing: { status },
        deployable: false,
      });
      expect(h.signAndVerify).toHaveBeenCalledOnce();
      expect(h.dockerCalls("push")).toHaveLength(1);
      expect(existsSync(h.dockerCalls("login")[0].options.env!.DOCKER_CONFIG!)).toBe(false);
    },
  );

  it.each(["", "123456789", "12345678901", "é123456789", "a1b2c3d4_5"])(
    "rejects invalid explicit signing version %j",
    (version) => {
      expect(() =>
        parsePublishArgs(argumentsFor({ ...base, "signing-profile-version": version })),
      ).toThrow();
    },
  );

  it.each(["cn-north-1", "us-gov-west-1"])(
    "rejects signing in the unqualified partition %s",
    (region) => {
      expect(() =>
        parsePublishArgs(
          argumentsFor({ ...base, region, "signing-profile-version": signingVersion }),
        ),
      ).toThrow();
      expect(parsePublishArgs(argumentsFor({ ...base, region }))).toMatchObject({ region });
    },
  );

  it("requires explicit signing opt-in and cannot replay an old receipt", () => {
    const options = { ...base, "signing-profile-version": signingVersion };
    expect(parsePublishArgs(argumentsFor(options))).toEqual(options);
    expect(() =>
      parsePublishArgs([...argumentsFor(options), "--signing-profile-version", signingVersion]),
    ).toThrow();
    expect(() =>
      parsePublishArgs([...argumentsFor(options), "--receipt", "old-passing.json"]),
    ).toThrow();
  });

  it.each([
    [false, undefined, "Unsigned; not deployable."],
    [null, "attempted", "Signature status unconfirmed; not deployable."],
    [null, "signed", "Signature status unconfirmed; not deployable."],
    [true, "signed", "Signature status unconfirmed; not deployable."],
    [true, "verified", "Signature verified; not deployable."],
  ] as const)(
    "reports signed=%s / %s without claiming release approval",
    (signed, status, expected) => {
      const receipt = { signed, ...(status ? { signing: { status } } : {}) } as Receipt;
      expect(formatPublishResult(receipt)).toBe(expected);
    },
  );

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

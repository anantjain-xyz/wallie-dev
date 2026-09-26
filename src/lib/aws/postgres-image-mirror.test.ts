import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

type Options = Record<string, string>;
type Call = {
  command: string;
  args: string[];
  options: {
    env?: NodeJS.ProcessEnv;
    input?: string;
    raw?: boolean;
    timeout?: number;
    processGroup?: boolean;
  };
};
type Receipt = {
  upstreamIndexDigest: string;
  linuxAmd64Digest: string;
  digest: string | null;
  uploadStatus: string;
  deployable: boolean;
  signed: boolean;
  scan: { status: string; fresh?: boolean; counts?: Record<string, number> };
  error?: string;
};
type Runner = (
  command: string,
  args: string[],
  options?: Call["options"],
) => Promise<string | Buffer>;
let parseMirrorArgs: (args: string[], env?: NodeJS.ProcessEnv) => Options;
let mirrorPostgresImage: (
  options: Options,
  dependencies: {
    run: Runner;
    archiveSource: (input: { source: string }) => Promise<{ root: string }>;
    cwd: string;
    env: NodeJS.ProcessEnv;
    tempRoot: string;
    now: () => number;
    wait: (ms: number) => Promise<void>;
  },
) => Promise<{ receipt: Receipt; receiptPath: string }>;
let runCommand: Runner;
beforeAll(async () => {
  ({ parseMirrorArgs, mirrorPostgresImage, runCommand } = await import(
    new URL("../../../scripts/mirror-aws-postgres-image.mjs", import.meta.url).href
  ));
});

const account = "123456789012";
const region = "us-west-2";
const revision = "a".repeat(40);
const image = "supabase/postgres:17.6.1.136";
const repository = "wallie-staging/supabase-postgres";
const repositoryUrl = `${account}.dkr.ecr.${region}.amazonaws.com/${repository}`;
const repositoryArn = `arn:aws:ecr:${region}:${account}:repository/${repository}`;
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const child = Buffer.from(
  JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: `sha256:${"b".repeat(64)}` },
    layers: [{ digest: `sha256:${"c".repeat(64)}` }],
  }),
);
const childDigest = sha(child);
const index = Buffer.from(
  JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: childDigest,
        size: child.length,
        platform: { os: "linux", architecture: "amd64" },
      },
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: `sha256:${"d".repeat(64)}`,
        size: 100,
        platform: { os: "linux", architecture: "arm64" },
      },
    ],
  }),
);
const indexDigest = sha(index);
const tag = `upstream-sha256-${indexDigest.slice(7)}`;
const base = { "account-id": account, region, revision, profile: "wallie-staging" };
const awsError = (awsCode: string) => Object.assign(new Error(awsCode), { awsCode });
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "wallie-postgres-mirror-test-"));
  directories.push(directory);
  const calls: Call[] = [];
  const overrides: Record<string, unknown> = {};
  let time = Date.parse("2026-09-25T00:00:00Z");
  let sourceIndex: Buffer = index;
  let sourceChild: Buffer = child;
  let destinationIndex: Buffer = index;
  let destinationChild: Buffer = child;
  const env: NodeJS.ProcessEnv = {
    AWS_PROFILE: "ambient-profile",
    AWS_ACCESS_KEY_ID: "ambient-key",
    AWS_SECRET_ACCESS_KEY: "ambient-secret",
    AWS_SESSION_TOKEN: "ambient-token",
    REGISTRY_AUTH_FILE: "/ambient/registry-auth.json",
    DOCKER_CONTENT_TRUST: "1",
    NODE_ENV: "test",
  };
  const credentials = {
    Version: 1,
    AccessKeyId: "synthetic-temporary-key",
    SecretAccessKey: "synthetic-temporary-secret",
    SessionToken: "synthetic-session-token",
    Expiration: "2026-09-25T02:00:00Z",
  };
  const identity = {
    Account: account,
    Arn: `arn:aws:iam::${account}:user/wallie-local`,
    UserId: "AIDAABCDEFGHIJKLMNOPQ",
  };
  const repo = {
    repositoryName: repository,
    repositoryUri: repositoryUrl,
    repositoryArn,
    registryId: account,
    imageTagMutability: "IMMUTABLE",
    imageScanningConfiguration: { scanOnPush: true },
    encryptionConfiguration: { encryptionType: "AES256" },
  };
  const effective = {
    failures: [],
    scanningConfigurations: [
      {
        repositoryName: repository,
        repositoryArn,
        scanOnPush: true,
        scanFrequency: "SCAN_ON_PUSH",
      },
    ],
  };
  const scan = {
    registryId: account,
    repositoryName: repository,
    imageId: { imageDigest: childDigest },
    imageScanStatus: { status: "COMPLETE" },
    imageScanFindings: {
      imageScanCompletedAt: "2026-09-25T00:00:15Z",
      findingSeverityCounts: { MEDIUM: 2 },
    },
  };
  const run: Runner = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === "skopeo") {
      if (args[0] === "--version") {
        if (overrides.versionError) throw new Error("ENOENT");
        return "skopeo version 1.20.0";
      }
      if (args[0] === "inspect") {
        const reference = args.at(-1);
        if (
          reference ===
          `docker://docker.io/supabase/postgres@${overrides.lockDigest ?? indexDigest}`
        )
          return sourceIndex;
        if (reference === `docker://docker.io/supabase/postgres@${childDigest}`) return sourceChild;
        if (reference === `docker://${repositoryUrl}:${tag}`) return destinationIndex;
        if (reference === `docker://${repositoryUrl}@${childDigest}`) return destinationChild;
        throw new Error(`unexpected inspect ${reference}`);
      }
      if (args[0] === "login") {
        expect(options.input).toBe("synthetic-ecr-token");
        const authPath = args[args.indexOf("--authfile") + 1];
        writeFileSync(authPath, "private-test-auth", { mode: 0o600 });
        return "Login Succeeded";
      }
      if (args[0] === "copy") {
        if (overrides.copyError) throw new Error("copy failed without secrets");
        time += Number(overrides.copyDurationMs ?? 20_000);
        return "copied";
      }
    }
    if (command === "aws") {
      if (args[0] === "configure" && args[1] === "export-credentials")
        return JSON.stringify(
          calls.some((call) => call.command === "skopeo" && call.args[0] === "copy")
            ? (overrides.credentialsAfterCopy ?? overrides.credentials ?? credentials)
            : (overrides.credentials ?? credentials),
        );
      const operation = args[1];
      if (operation === "get-caller-identity")
        return JSON.stringify(
          calls.some((call) => call.command === "skopeo" && call.args[0] === "copy")
            ? (overrides.identityAfterCopy ?? overrides.identity ?? identity)
            : (overrides.identity ?? identity),
        );
      if (operation === "describe-repositories")
        return JSON.stringify({ repositories: [overrides.repo ?? repo] });
      if (operation === "list-tags-for-resource")
        return JSON.stringify({
          tags: overrides.tags ?? [{ Key: "WallieStack", Value: "wallie-staging-registry" }],
        });
      if (operation === "get-registry-scanning-configuration")
        return JSON.stringify(
          overrides.registryScan ?? {
            registryId: account,
            scanningConfiguration: { scanType: "BASIC" },
          },
        );
      if (operation === "batch-get-repository-scanning-configuration")
        return JSON.stringify(overrides.effective ?? effective);
      if (operation === "describe-images") {
        if (!args.includes("--image-ids"))
          return JSON.stringify({ imageDetails: overrides.existingImages ?? [] });
        if (
          args.includes(`imageTag=${tag}`) &&
          !calls.some((call) => call.command === "skopeo" && call.args[0] === "copy") &&
          !overrides.tagExists
        )
          throw awsError("ImageNotFoundException");
        return JSON.stringify({
          imageDetails: [
            overrides.imageDetail ?? {
              registryId: account,
              repositoryName: repository,
              imageDigest: indexDigest,
              imageTags: [tag],
            },
          ],
        });
      }
      if (operation === "get-login-password") return "synthetic-ecr-token";
      if (operation === "describe-image-scan-findings") {
        if (overrides.scanError) throw awsError(String(overrides.scanError));
        return JSON.stringify(overrides.scan ?? scan);
      }
    }
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
  const archiveSource = async ({ source }: { source: string }) => {
    mkdirSync(join(source, "infra/supabase"), { recursive: true });
    writeFileSync(
      join(source, "infra/supabase/upstream.lock.json"),
      JSON.stringify({
        images: { db: image },
        digests: { db: overrides.lockDigest ?? indexDigest },
      }),
    );
    return { root: directory };
  };
  const dependencies = {
    run,
    archiveSource,
    cwd: directory,
    env,
    tempRoot: directory,
    now: () => time,
    wait: async (ms: number) => {
      time += ms;
    },
  };
  return {
    directory,
    calls,
    overrides,
    dependencies,
    setSourceIndex: (bytes: Buffer) => (sourceIndex = bytes),
    setSourceChild: (bytes: Buffer) => (sourceChild = bytes),
    setDestinationIndex: (bytes: Buffer) => (destinationIndex = bytes),
    setDestinationChild: (bytes: Buffer) => (destinationChild = bytes),
  };
}

describe("PostgreSQL ECR image mirror", () => {
  it("accepts only bounded account, region, reviewed revision, and temporary profile inputs", () => {
    expect(
      parseMirrorArgs(Object.entries(base).flatMap(([key, value]) => [`--${key}`, value])),
    ).toEqual(base);
    for (const invalid of [
      { ...base, revision: "a".repeat(7) },
      { ...base, "account-id": "123" },
      { ...base, region: "us-east-1\n--profile root" },
      { ...base, profile: "root profile" },
    ]) {
      expect(() =>
        parseMirrorArgs(Object.entries(invalid).flatMap(([key, value]) => [`--${key}`, value])),
      ).toThrow("Usage:");
    }
    expect(() =>
      parseMirrorArgs([
        ...Object.entries(base).flatMap(([key, value]) => [`--${key}`, value]),
        "--region",
        region,
      ]),
    ).toThrow("Usage:");
  });

  it("requires Skopeo before any source or AWS operation", async () => {
    const h = harness();
    h.overrides.versionError = true;
    await expect(mirrorPostgresImage(base, h.dependencies)).rejects.toThrow("Skopeo is required");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].args).toEqual(["--version"]);
  });

  it("mirrors the exact locked index, verifies its amd64 child, and scans that child", async () => {
    const h = harness();
    const result = await mirrorPostgresImage(base, h.dependencies);
    expect(result.receipt).toMatchObject({
      sourceRevision: revision,
      upstreamImage: image,
      upstreamIndexDigest: indexDigest,
      linuxAmd64Digest: childDigest,
      platform: "linux/amd64",
      tag,
      repository: repositoryUrl,
      uploadStatus: "confirmed",
      digest: indexDigest,
      signed: false,
      deployable: false,
      scan: { status: "COMPLETE", fresh: true, counts: { MEDIUM: 2, HIGH: 0, CRITICAL: 0 } },
    });
    expect(readFileSync(result.receiptPath, "utf8")).toContain(indexDigest);
    expect(
      h.calls.filter((call) => call.command === "skopeo" && call.args[0] === "inspect"),
    ).toHaveLength(4);
    const copy = h.calls.find((call) => call.command === "skopeo" && call.args[0] === "copy")!;
    expect(copy.args).toContain("--all");
    expect(copy.args).toContain("--preserve-digests");
    expect(copy.args).toContain("--src-no-creds");
    expect(copy.args).toContain(`docker://docker.io/supabase/postgres@${indexDigest}`);
    expect(copy.args).toContain(`docker://${repositoryUrl}:${tag}`);
    expect(copy.options.processGroup).toBe(true);
    expect(copy.options.timeout).toBe(30 * 60_000);
    expect(copy.options.env?.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(copy.options.env?.REGISTRY_AUTH_FILE).toBeUndefined();
    expect(copy.options.env?.DOCKER_CONTENT_TRUST).toBeUndefined();
    const sourceInspect = h.calls.find(
      (call) =>
        call.command === "skopeo" &&
        call.args[0] === "inspect" &&
        call.args.at(-1) === `docker://docker.io/supabase/postgres@${indexDigest}`,
    )!;
    expect(sourceInspect.args).toContain("--no-creds");
    const destinationInspect = h.calls.find(
      (call) =>
        call.command === "skopeo" &&
        call.args[0] === "inspect" &&
        call.args.at(-1) === `docker://${repositoryUrl}:${tag}`,
    )!;
    expect(destinationInspect.args).toContain("--authfile");
    expect(destinationInspect.args).not.toContain("--no-creds");
    const scan = h.calls.find(
      (call) => call.command === "aws" && call.args[1] === "describe-image-scan-findings",
    )!;
    expect(scan.args).toContain(`imageDigest=${childDigest}`);
    expect(scan.options.env?.AWS_ACCESS_KEY_ID).toBe("synthetic-temporary-key");
    expect(existsSync(join(h.directory, ".wallie/aws"))).toBe(true);
  });

  it("rejects an upstream index whose raw bytes do not match the reviewed lock", async () => {
    const h = harness();
    h.setSourceIndex(Buffer.concat([index, Buffer.from("\n")]));
    await expect(mirrorPostgresImage(base, h.dependencies)).rejects.toThrow("index digest");
    expect(h.calls.some((call) => call.command === "aws")).toBe(false);
  });

  it("rejects two linux/amd64 children before AWS access", async () => {
    const h = harness();
    const duplicate = JSON.parse(index.toString("utf8"));
    duplicate.manifests.push({ ...duplicate.manifests[0] });
    const bytes = Buffer.from(JSON.stringify(duplicate));
    h.overrides.lockDigest = sha(bytes);
    h.setSourceIndex(bytes);
    await expect(mirrorPostgresImage(base, h.dependencies)).rejects.toThrow(
      "one ordinary linux/amd64 image",
    );
    expect(h.calls.some((call) => call.command === "aws")).toBe(false);
  });

  it("rejects a linux/amd64 child byte mismatch before AWS access", async () => {
    const h = harness();
    h.setSourceChild(Buffer.concat([child, Buffer.from("\n")]));
    await expect(mirrorPostgresImage(base, h.dependencies)).rejects.toThrow("linux/amd64 manifest");
    expect(h.calls.some((call) => call.command === "aws")).toBe(false);
  });

  it("stops before upload when repository ownership or scan mode differs", async () => {
    const h = harness();
    h.overrides.tags = [];
    await expect(mirrorPostgresImage(base, h.dependencies)).rejects.toThrow("ownership marker");
    expect(h.calls.some((call) => call.command === "skopeo" && call.args[0] === "copy")).toBe(
      false,
    );
  });

  it("will not overwrite an existing immutable tag", async () => {
    const h = harness();
    h.overrides.tagExists = true;
    await expect(mirrorPostgresImage(base, h.dependencies)).rejects.toThrow("already exists");
    expect(h.calls.some((call) => call.command === "skopeo" && call.args[0] === "copy")).toBe(
      false,
    );
  });

  it("requires the whole repository to be empty, including untagged child manifests", async () => {
    const h = harness();
    h.overrides.existingImages = [
      { registryId: account, repositoryName: repository, imageDigest: childDigest },
    ];
    await expect(mirrorPostgresImage(base, h.dependencies)).rejects.toThrow("not empty");
    const listing = h.calls.find(
      (call) =>
        call.command === "aws" &&
        call.args[1] === "describe-images" &&
        !call.args.includes("--image-ids"),
    )!;
    expect(listing.args).toContain("--max-items");
    expect(listing.args).toContain("1");
    expect(h.calls.some((call) => call.command === "skopeo" && call.args[0] === "copy")).toBe(
      false,
    );
  });

  it("uses a fresh ECR token for a bounded copy that outlives 15-minute AWS credentials", async () => {
    const h = harness();
    const beforeCopy = {
      Version: 1,
      AccessKeyId: "synthetic-temporary-key",
      SecretAccessKey: "synthetic-temporary-secret",
      SessionToken: "synthetic-session-token",
      Expiration: "2026-09-25T00:15:00Z",
    };
    const afterCopy = {
      ...beforeCopy,
      AccessKeyId: "renewed-temporary-key",
      Expiration: "2026-09-25T00:45:00Z",
    };
    h.overrides.credentials = beforeCopy;
    h.overrides.credentialsAfterCopy = afterCopy;
    h.overrides.copyDurationMs = 20 * 60_000;
    const result = await mirrorPostgresImage(base, h.dependencies);
    const token = h.calls.find(
      (call) => call.command === "aws" && call.args[1] === "get-login-password",
    )!;
    const copy = h.calls.find((call) => call.command === "skopeo" && call.args[0] === "copy")!;
    const afterCopyCalls = h.calls.slice(h.calls.indexOf(copy) + 1);
    expect(token.options.env?.AWS_ACCESS_KEY_ID).toBe(beforeCopy.AccessKeyId);
    expect(token.options.timeout).toBe(120_000);
    expect(
      h.calls
        .slice(h.calls.indexOf(token) + 1, h.calls.indexOf(copy))
        .map((call) => `${call.command}:${call.args[0]}`),
    ).toEqual(["skopeo:login"]);
    expect(copy.options.timeout).toBe(30 * 60_000);
    expect(afterCopyCalls.slice(0, 3).map((call) => call.args[1])).toEqual([
      "export-credentials",
      "get-caller-identity",
      "describe-images",
    ]);
    expect(afterCopyCalls[2].options.env?.AWS_ACCESS_KEY_ID).toBe(afterCopy.AccessKeyId);
    expect(
      h.calls.filter((call) => call.command === "skopeo" && call.args[0] === "copy"),
    ).toHaveLength(1);
    expect(result.receipt).toMatchObject({ uploadStatus: "confirmed", digest: indexDigest });
  });

  it("requires more than 150 seconds of credentials before any AWS call or upload", async () => {
    const h = harness();
    h.overrides.credentials = {
      Version: 1,
      AccessKeyId: "synthetic-temporary-key",
      SecretAccessKey: "synthetic-temporary-secret",
      SessionToken: "synthetic-session-token",
      Expiration: "2026-09-25T00:02:30Z",
    };
    await expect(mirrorPostgresImage(base, h.dependencies)).rejects.toThrow("expire too soon");
    expect(h.calls.filter((call) => call.command === "aws").map((call) => call.args[1])).toEqual([
      "export-credentials",
    ]);
    expect(h.calls.some((call) => call.command === "skopeo" && call.args[0] === "copy")).toBe(
      false,
    );
  });

  it("leaves an unverified receipt and does not retry when credentials cannot renew after copy", async () => {
    const h = harness();
    h.overrides.credentials = {
      Version: 1,
      AccessKeyId: "synthetic-temporary-key",
      SecretAccessKey: "synthetic-temporary-secret",
      SessionToken: "synthetic-session-token",
      Expiration: "2026-09-25T00:15:00Z",
    };
    h.overrides.copyDurationMs = 20 * 60_000;
    const error = (await mirrorPostgresImage(base, h.dependencies).catch(
      (failure: Error & { receiptPath?: string }) => failure,
    )) as Error & { receiptPath?: string };
    expect(error.message).toContain("unexpired temporary session credentials");
    expect(error.receiptPath).toBeDefined();
    expect(JSON.parse(readFileSync(error.receiptPath!, "utf8"))).toMatchObject({
      uploadStatus: "confirmed",
      digest: null,
      deployable: false,
    });
    expect(
      h.calls.filter((call) => call.command === "skopeo" && call.args[0] === "copy"),
    ).toHaveLength(1);
    expect(h.calls.slice(-1)[0].args[1]).toBe("export-credentials");
  });

  it("leaves a private attempted receipt after a partial copy failure", async () => {
    const h = harness();
    h.overrides.copyError = true;
    const error = (await mirrorPostgresImage(base, h.dependencies).catch(
      (failure: Error & { receiptPath?: string }) => failure,
    )) as Error & { receiptPath?: string };
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("copy failed");
    expect(error.receiptPath).toBeDefined();
    const receipt = JSON.parse(readFileSync(error.receiptPath!, "utf8"));
    expect(receipt).toMatchObject({ uploadStatus: "attempted", digest: null, deployable: false });
    expect(receipt.error).toContain("copy failed");
  });

  it("fails closed if ECR changes the index or amd64 child after copy", async () => {
    const h = harness();
    h.setDestinationChild(Buffer.concat([child, Buffer.from("\n")]));
    const error = (await mirrorPostgresImage(base, h.dependencies).catch(
      (failure: Error & { receiptPath?: string }) => failure,
    )) as Error & { receiptPath?: string };
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("child bytes");
    expect(JSON.parse(readFileSync(error.receiptPath!, "utf8")).deployable).toBe(false);
    expect(
      h.calls.some(
        (call) => call.command === "aws" && call.args[1] === "describe-image-scan-findings",
      ),
    ).toBe(false);
  });

  it("records a HIGH finding as blocked after confirming the copied digest", async () => {
    const h = harness();
    h.overrides.scan = {
      registryId: account,
      repositoryName: repository,
      imageId: { imageDigest: childDigest },
      imageScanStatus: { status: "COMPLETE" },
      imageScanFindings: {
        imageScanCompletedAt: "2026-09-25T00:00:15Z",
        findingSeverityCounts: { HIGH: 1 },
      },
    };
    const error = (await mirrorPostgresImage(base, h.dependencies).catch(
      (failure: Error & { receiptPath?: string }) => failure,
    )) as Error & { receiptPath?: string };
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("HIGH or CRITICAL");
    const receipt = JSON.parse(readFileSync(error.receiptPath!, "utf8"));
    expect(receipt).toMatchObject({
      uploadStatus: "confirmed",
      digest: indexDigest,
      deployable: false,
      scan: { counts: { HIGH: 1 } },
    });
  });

  it("rejects an AWS principal change after copy", async () => {
    const h = harness();
    h.overrides.identityAfterCopy = {
      Account: account,
      Arn: `arn:aws:iam::${account}:user/other-user`,
      UserId: "AIDAABCDEFGHIJKLMNOPR",
    };
    const error = (await mirrorPostgresImage(base, h.dependencies).catch(
      (failure: Error & { receiptPath?: string }) => failure,
    )) as Error & { receiptPath?: string };
    expect(error.message).toContain("AWS identity changed");
    expect(JSON.parse(readFileSync(error.receiptPath!, "utf8"))).toMatchObject({
      uploadStatus: "confirmed",
      digest: null,
      deployable: false,
    });
  });

  it("does not accept a stale completed scan for an existing child digest", async () => {
    const h = harness();
    h.overrides.scan = {
      registryId: account,
      repositoryName: repository,
      imageId: { imageDigest: childDigest },
      imageScanStatus: { status: "COMPLETE" },
      imageScanFindings: {
        imageScanCompletedAt: "2026-09-24T23:59:59Z",
        findingSeverityCounts: {},
      },
    };
    const error = (await mirrorPostgresImage(base, h.dependencies).catch(
      (failure: Error & { receiptPath?: string }) => failure,
    )) as Error & { receiptPath?: string };
    expect(error.message).toContain("timed out");
    expect(JSON.parse(readFileSync(error.receiptPath!, "utf8"))).toMatchObject({
      digest: indexDigest,
      deployable: false,
      scan: { status: "COMPLETE", fresh: false },
    });
  });

  it("preserves trailing bytes from a raw manifest command", async () => {
    const result = await runCommand(process.execPath, ["--eval", "process.stdout.write('x\\n')"], {
      raw: true,
      timeout: 5_000,
    });
    expect(result).toEqual(Buffer.from("x\n"));
  });
});

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import reviewedLock from "../../../infra/aws/signing-toolchain.lock.json";

type ToolchainLock = typeof reviewedLock;
type RunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  signal?: AbortSignal;
  processGroup?: boolean;
};
type Runner = (command: string, args: string[], options: RunOptions) => Promise<string>;
type Aws = (service: string, operation: string, args?: string[], raw?: boolean) => Promise<unknown>;
type Credentials = { env: NodeJS.ProcessEnv; expiration: string };
type Receipt = Record<string, unknown> & {
  repository: string;
  digest: string;
  signed: boolean | null;
  deployable: boolean;
};
type PreparationOptions = {
  root: string;
  temporary: string;
  account: string;
  region: string;
  profileVersion: string;
  run: Runner;
  now: () => number;
  signal?: AbortSignal;
  platform: string;
  arch: string;
  lock: ToolchainLock;
};
type Signing = {
  verifyProfile: (aws: Aws) => Promise<void>;
  signAndVerify: (options: {
    aws: Aws;
    getCredentials: () => Promise<Credentials>;
    receipt: Receipt;
    saveReceipt: () => void;
    nonce: string;
  }) => Promise<void>;
};
let prepareImageSigning: (options: PreparationOptions) => Promise<Signing>;
beforeAll(async () => {
  const script = new URL("../../../scripts/lib/aws-image-signing.mjs", import.meta.url).href;
  ({ prepareImageSigning } = await import(script));
});

const temporaryRoots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const account = "123456789012";
const region = "us-west-2";
const profileVersion = "Ab12Cd34Ef";
const profileArn = `arn:aws:signer:${region}:${account}:/signing-profiles/wallie_staging_images`;
const profileVersionArn = `${profileArn}/${profileVersion}`;
const repository = `${account}.dkr.ecr.${region}.amazonaws.com/wallie-staging/web`;
const digest = `sha256:${"a".repeat(64)}`;
const now = () => Date.parse("2026-09-21T22:00:00Z");
const tags = {
  Name: "wallie_staging_images",
  Project: "Wallie",
  Environment: "staging",
  ManagedBy: "Terraform",
  Component: "signing",
  WallieStack: "wallie-staging-registry",
};

// Public root certificate, with no private key, from the reviewed AWS installer.
const rootCertificate = `-----BEGIN CERTIFICATE-----
MIICWTCCAd6gAwIBAgIRAMq5Lmt4rqnUdi8qM4eIGbYwCgYIKoZIzj0EAwMwbDEL
MAkGA1UEBhMCVVMxDDAKBgNVBAoMA0FXUzEVMBMGA1UECwwMQ3J5cHRvZ3JhcGh5
MQswCQYDVQQIDAJXQTErMCkGA1UEAwwiQVdTIFNpZ25lciBDb2RlIFNpZ25pbmcg
Um9vdCBDQSBHMTAgFw0yMjEwMjcyMTMzMjJaGA8yMTIyMTAyNzIyMzMyMlowbDEL
MAkGA1UEBhMCVVMxDDAKBgNVBAoMA0FXUzEVMBMGA1UECwwMQ3J5cHRvZ3JhcGh5
MQswCQYDVQQIDAJXQTErMCkGA1UEAwwiQVdTIFNpZ25lciBDb2RlIFNpZ25pbmcg
Um9vdCBDQSBHMTB2MBAGByqGSM49AgEGBSuBBAAiA2IABM9+dM9WXbVyNOIP08oN
IQW8DKKdBxP5nYNegFPLfGP0f7+0jweP8LUv1vlFZqVDep5ONus9IxwtIYBJLd36
5Q3Z44Xnm4PY/wSI5xRvB/m+/B2PHc7Smh0P5s3Dt25oVKNCMEAwDwYDVR0TAQH/
BAUwAwEB/zAdBgNVHQ4EFgQUONhd3abPX87l4YWKxjysv28QwAYwDgYDVR0PAQH/
BAQDAgGGMAoGCCqGSM49BAMDA2kAMGYCMQCd32GnYU2qFCtKjZiveGfs+gCBlPi2
Hw0zU52LXIFC2GlcvwcekbiM6w0Azlr9qvMCMQDl4+Os0yd+fVlYMuovvxh8xpjQ
NPJ9zRGyYa7+GNs64ty/Z6bzPHOKbGo4In3KKJo=
-----END CERTIFICATE-----`;

function hash(bytes: string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function write(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(root, entry.name)).map((path) => join(entry.name, path))
      : [entry.name],
  );
}

type FixtureOptions = {
  output?: (command: string, args: string[], options: RunOptions) => string | undefined;
};

function fixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wallie-signing-helper-test-"));
  temporaryRoots.push(root);
  const temporary = join(root, "run");
  mkdirSync(temporary);
  const toolchain = join(root, ".wallie", "aws", "signing-toolchain");
  const lock = structuredClone(reviewedLock);
  for (const file of lock.files) {
    const bytes =
      file.source === lock.rootCertificate.file ? rootCertificate : `reviewed ${file.source}\n`;
    file.sha256 = hash(bytes);
    write(join(toolchain, file.destination), bytes);
  }
  const profile = {
    profileName: "wallie_staging_images",
    arn: profileArn,
    profileVersion,
    profileVersionArn,
    status: "Active",
    platformId: "Notation-OCI-SHA384-ECDSA",
    signatureValidityPeriod: { value: 1, type: "YEARS" },
  };
  const profileTags = { ...tags };
  const receipt: Receipt = {
    schemaVersion: 1,
    component: "web",
    repository,
    digest,
    revision: "b".repeat(40),
    uploadStatus: "confirmed",
    startedAt: new Date(now() - 60_000).toISOString(),
    pushedAt: new Date(now() - 45_000).toISOString(),
    signed: false,
    deployable: false,
    scan: {
      status: "COMPLETE",
      fresh: true,
      completedAt: new Date(now() - 30_000).toISOString(),
      counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 0, INFORMATIONAL: 0, UNDEFINED: 0 },
    },
  };
  const credentials: Credentials = {
    expiration: new Date(now() + 900_000).toISOString(),
    env: {
      NODE_ENV: "test",
      AWS_ACCESS_KEY_ID: "synthetic-access-key",
      AWS_SECRET_ACCESS_KEY: "synthetic-secret-key",
      AWS_SESSION_TOKEN: "synthetic-session-token",
    },
  };
  const events: string[] = [];
  const token = "synthetic-registry-token";
  const aws = vi.fn<Aws>(async (service, operation) => {
    events.push(`${service} ${operation}`);
    if (service === "signer" && operation === "get-signing-profile")
      return structuredClone(profile);
    if (service === "signer" && operation === "list-tags-for-resource")
      return { tags: { ...profileTags } };
    if (service === "ecr" && operation === "get-login-password") return token;
    throw new Error(`Unexpected AWS fixture operation: ${service} ${operation}`);
  });
  const snapshots: Receipt[] = [];
  const saveReceipt = vi.fn(() => {
    snapshots.push(structuredClone(receipt));
    events.push("save receipt");
  });
  const getCredentials = vi.fn(async () => structuredClone(credentials));
  const run = vi.fn<Runner>(async (command, args, runOptions) => {
    events.push(`${basename(command)} ${args[0]}`);
    const output = options.output?.(command, args, runOptions);
    if (output !== undefined) return output;
    if (args.join(" ") === "version") return `Version: ${lock.notationVersion}\n`;
    if (args.join(" ") === "plugin ls") {
      return `NAME DESCRIPTION VERSION CAPABILITIES ERROR\n${lock.plugin.name} AWS Signer plugin for Notation ${lock.plugin.version} [SIGNATURE_GENERATOR.ENVELOPE SIGNATURE_VERIFIER.TRUSTED_IDENTITY SIGNATURE_VERIFIER.REVOCATION_CHECK] <nil>\n`;
    }
    if (args.join(" ") === "cert ls")
      return `signingAuthority aws-signer-ts ${lock.rootCertificate.file}\n`;
    const reference = args.find((argument) => argument.includes("@sha256:"));
    if (args[0] === "sign") return `Successfully signed ${reference}\n`;
    if (args[0] === "verify") return `Successfully verified signature for ${reference}\n`;
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  });
  const nonce = "1".repeat(32);
  return {
    root,
    temporary,
    toolchain,
    lock,
    profile,
    profileTags,
    receipt,
    credentials,
    token,
    aws,
    run,
    events,
    snapshots,
    saveReceipt,
    getCredentials,
    nonce,
    prepare: (overrides: Partial<PreparationOptions> = {}) =>
      prepareImageSigning({
        root,
        temporary,
        account,
        region,
        profileVersion,
        run,
        now,
        platform: "darwin",
        arch: "arm64",
        lock,
        ...overrides,
      }),
    sign: (signing: Signing) =>
      signing.signAndVerify({ aws, getCredentials, receipt, saveReceipt, nonce }),
  };
}

describe("AWS image signing helper", () => {
  it.each(["linux", "win32"])(
    "rejects unsupported platform %s before executing tools",
    async (platform) => {
      const f = fixture();
      await expect(f.prepare({ platform })).rejects.toThrow();
      expect(f.run).not.toHaveBeenCalled();
      expect(f.aws).not.toHaveBeenCalled();
    },
  );

  it.each(["hash", "symlink"])(
    "rejects a changed toolchain %s before executing any tools",
    async (failure) => {
      const f = fixture();
      const path = join(f.toolchain, f.lock.files[0].destination);
      if (failure === "hash") writeFileSync(path, "modified binary");
      else {
        const target = join(f.root, "outside-binary");
        writeFileSync(target, readFileSync(path));
        rmSync(path);
        symlinkSync(target, path);
      }
      await expect(f.prepare()).rejects.toThrow();
      expect(f.run).not.toHaveBeenCalled();
      expect(f.aws).not.toHaveBeenCalled();
    },
  );

  it("checks every locked file, including licenses, before executing a binary", async () => {
    const f = fixture();
    const file = f.lock.files.find(({ destination }) => destination.startsWith("licenses/"))!;
    writeFileSync(join(f.toolchain, file.destination), "changed license bytes");
    await expect(f.prepare()).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects a symlink in a toolchain parent directory", async () => {
    const f = fixture();
    const original = join(f.toolchain, "bin");
    const replacement = join(f.root, "linked-bin");
    mkdirSync(replacement);
    writeFileSync(join(replacement, "notation"), readFileSync(join(original, "notation")));
    rmSync(original, { recursive: true });
    symlinkSync(replacement, original);
    await expect(f.prepare()).rejects.toThrow(/without symlinks/);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("copies only pinned runtime files and creates a fresh strict two-repository trust policy", async () => {
    const f = fixture();
    write(
      join(f.toolchain, "config", "trustpolicy.json"),
      '{"trustPolicies":[{"registryScopes":["*"]}]}',
    );
    write(join(f.toolchain, "libexec", "plugins", "untrusted", "plugin"), "untrusted executable");
    await f.prepare();
    const runtime = join(f.temporary, "notation-signing");
    const policy = JSON.parse(readFileSync(join(runtime, "config", "trustpolicy.json"), "utf8"));
    expect(policy).toEqual({
      version: "1.0",
      trustPolicies: [
        {
          name: "wallie-staging-images",
          registryScopes: ["web", "worker"].map(
            (component) => `${account}.dkr.ecr.${region}.amazonaws.com/wallie-staging/${component}`,
          ),
          signatureVerification: { level: "strict" },
          trustStores: ["signingAuthority:aws-signer-ts"],
          trustedIdentities: [profileVersionArn],
        },
      ],
    });
    const pinned = f.lock.files.filter(
      (file) => file.executable || file.source === f.lock.rootCertificate.file,
    );
    expect(filesUnder(runtime).sort()).toEqual(
      [...pinned.map((file) => file.destination), "config/trustpolicy.json"].sort(),
    );
    expect(f.run).not.toHaveBeenCalled();
  });

  it("reads only the expected profile owner/name and exact profile ARN", async () => {
    const f = fixture();
    const signing = await f.prepare();
    await signing.verifyProfile(f.aws);
    expect(f.aws.mock.calls).toEqual([
      [
        "signer",
        "get-signing-profile",
        ["--profile-name", "wallie_staging_images", "--profile-owner", account],
      ],
      ["signer", "list-tags-for-resource", ["--resource-arn", profileArn]],
    ]);
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each([
    { profileName: "other_profile" },
    { arn: profileArn.replace(account, "999999999999") },
    { arn: profileArn.replace(region, "us-east-1") },
    { profileVersion: "9876543210" },
    { profileVersionArn: `${profileArn}/9876543210` },
    { status: "Canceled" },
    { status: "Revoked" },
    { platformId: "AWSLambda-SHA384-ECDSA" },
    { signatureValidityPeriod: { value: 2, type: "YEARS" } },
    { signatureValidityPeriod: { value: 1, type: "DAYS" } },
    { revocationRecord: {} },
  ])("rejects changed signing profile fields %j", async (change) => {
    const f = fixture();
    Object.assign(f.profile, change);
    const signing = await f.prepare();
    await expect(signing.verifyProfile(f.aws)).rejects.toThrow(/does not match/);
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(Object.keys(tags) as (keyof typeof tags)[])(
    "requires the reviewed %s ownership tag",
    async (key) => {
      const f = fixture();
      f.profileTags[key] = "foreign-value";
      const signing = await f.prepare();
      await expect(signing.verifyProfile(f.aws)).rejects.toThrow(/ownership does not match/);
    },
  );

  it.each([
    { uploadStatus: "attempted" },
    { repository: `${repository}-other` },
    { digest: "sha256:missing" },
    { component: "other" },
    { scan: { status: "PENDING", fresh: true, counts: { HIGH: 0, CRITICAL: 0 } } },
    { scan: { status: "COMPLETE", fresh: false, counts: { HIGH: 0, CRITICAL: 0 } } },
    { scan: { status: "COMPLETE", fresh: true, counts: { HIGH: 1, CRITICAL: 0 } } },
    { scan: { status: "COMPLETE", fresh: true, counts: { HIGH: 0, CRITICAL: 1 } } },
  ])("blocks ineligible receipt %j before credentials or signing", async (change) => {
    const f = fixture();
    Object.assign(f.receipt, change);
    const signing = await f.prepare();
    await expect(f.sign(signing)).rejects.toThrow(/confirmed image and fresh passing scan/);
    expect(f.aws).not.toHaveBeenCalled();
    expect(f.getCredentials).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.receipt.deployable).toBe(false);
  });

  it.each(["binary", "root", "trust policy", "extra plugin"])(
    "rejects changed runtime %s before signing",
    async (changed) => {
      const f = fixture();
      const signing = await f.prepare();
      const runtime = join(f.temporary, "notation-signing");
      const paths: Record<string, string> = {
        binary: "bin/notation",
        root: f.lock.files.find((file) => file.source === f.lock.rootCertificate.file)!.destination,
        "trust policy": "config/trustpolicy.json",
        "extra plugin": "libexec/plugins/foreign/foreign-plugin",
      };
      write(join(runtime, paths[changed]), "changed after preparation");
      await expect(f.sign(signing)).rejects.toThrow(/signing prerequisites failed/);
      expect(f.run).not.toHaveBeenCalled();
      expect(f.receipt.signed).toBe(false);
      expect(f.saveReceipt).not.toHaveBeenCalled();
    },
  );

  it.each(["sign", "verify"])(
    "requires more than 150 seconds of credentials before %s",
    async (operation) => {
      const f = fixture();
      const short = { ...f.credentials, expiration: new Date(now() + 150_000).toISOString() };
      if (operation === "verify") f.getCredentials.mockResolvedValueOnce(f.credentials);
      f.getCredentials.mockResolvedValueOnce(short);
      const signing = await f.prepare();
      await expect(f.sign(signing)).rejects.toThrow(/prerequisites failed/);
      expect(f.run.mock.calls.map(([, args]) => args[0])).toEqual(
        operation === "sign" ? [] : ["sign"],
      );
      expect(f.receipt.signed).toBe(operation === "sign" ? false : null);
      expect(f.receipt.deployable).toBe(false);
    },
  );

  it.each(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"])(
    "rejects missing %s before signing",
    async (key) => {
      const f = fixture();
      delete f.credentials.env[key];
      const signing = await f.prepare();
      await expect(f.sign(signing)).rejects.toThrow(/signing prerequisites failed/);
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it.each(["sign", "verify"])("does not retry or leak raw errors from %s", async (operation) => {
    const secret = "RAW_PRIVATE_DIAGNOSTIC";
    const f = fixture({
      output: (_command, args) => {
        if (args[0] === operation)
          throw new Error(`${secret}: synthetic-session-token synthetic-registry-token`);
        return undefined;
      },
    });
    const signing = await f.prepare();
    const error = await f.sign(signing).catch((failure: Error) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      operation === "sign" ? "Image signing failed" : "Image strict verification failed",
    );
    expect((error as Error).message).not.toContain(secret);
    expect(error).not.toHaveProperty("cause");
    expect(f.run.mock.calls.map(([, args]) => args[0])).toEqual(
      operation === "sign" ? ["sign"] : ["sign", "verify"],
    );
    expect(f.receipt.signed).toBe(null);
    expect(f.receipt.deployable).toBe(false);
    expect(JSON.stringify(f.snapshots)).not.toContain(secret);
    expect(f.snapshots.at(-1)?.signing).toMatchObject({
      status: operation === "sign" ? "attempted" : "signed",
    });
  });

  it.each([
    ["sign", ""],
    ["sign", `Successfully signed ${repository}@sha256:${"f".repeat(64)}`],
    ["sign", `Successfully signed ${repository}@${digest}\nUnexpected trailing output`],
    ["verify", "Verification skipped"],
    ["verify", `Successfully verified signature for ${repository}@sha256:${"f".repeat(64)}`],
  ])("rejects unconfirmed %s output despite a successful child exit", async (operation, output) => {
    const f = fixture({ output: (_command, args) => (args[0] === operation ? output : undefined) });
    const signing = await f.prepare();
    await expect(f.sign(signing)).rejects.toThrow(/failed; inspect the signing state/);
    expect(f.receipt.signed).toBe(null);
    expect(f.receipt.deployable).toBe(false);
  });

  it("redacts profile/token service failures and performs no signing", async () => {
    const f = fixture();
    const signing = await f.prepare();
    f.aws.mockRejectedValueOnce(new Error("synthetic-secret-key private provider output"));
    await expect(signing.verifyProfile(f.aws)).rejects.toThrow(
      "Could not verify the reviewed AWS signing profile",
    );
    f.aws.mockImplementation(async (service, operation) => {
      if (service === "signer" && operation === "get-signing-profile") return f.profile;
      if (service === "signer" && operation === "list-tags-for-resource")
        return { tags: f.profileTags };
      throw new Error("synthetic-registry-token private provider output");
    });
    const error = await f.sign(signing).catch((failure: Error) => failure);
    expect((error as Error).message).toBe(
      "Image signing prerequisites failed; inspect the signing state in the private receipt",
    );
    expect(f.getCredentials).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.receipt.signed).toBe(false);
  });

  it("persists uncertainty before signing and marks signed only after strict digest verification", async () => {
    const f = fixture({
      output: (_command, args) => {
        expect(f.receipt.signed).toBe(null);
        expect(f.receipt.deployable).toBe(false);
        expect(f.snapshots.at(-1)?.signing).toMatchObject({
          status: args[0] === "sign" ? "attempted" : "signed",
        });
        return undefined;
      },
    });
    const signing = await f.prepare();
    await f.sign(signing);
    expect(f.snapshots.map((snapshot) => snapshot.signed)).toEqual([null, null, true]);
    expect(f.snapshots.map((snapshot) => (snapshot.signing as { status: string }).status)).toEqual([
      "attempted",
      "signed",
      "verified",
    ]);
    expect(f.receipt).toMatchObject({
      signed: true,
      deployable: false,
      signing: {
        status: "verified",
        profileVersionArn,
        nonce: f.nonce,
        reference: `${repository}@${digest}`,
      },
    });
    expect(f.getCredentials).toHaveBeenCalledTimes(2);
    expect(
      f.aws.mock.calls.filter(([, operation]) => operation === "get-signing-profile"),
    ).toHaveLength(2);
    expect(f.events.indexOf("save receipt")).toBeLessThan(f.events.indexOf("notation sign"));
    const commands = f.run.mock.calls.map(([, args]) => args);
    expect(commands.map((args) => args[0])).toEqual(["sign", "verify"]);
    for (const args of commands) {
      expect(args[1]).toBe(`${repository}@${digest}`);
      expect(args[args.indexOf("--user-metadata") + 1]).toBe(`wallie.dev/publish-id=${f.nonce}`);
    }
    expect(commands[0][commands[0].indexOf("--id") + 1]).toBe(profileArn);
    expect(commands[0]).toContain("--force-referrers-tag=false");
  });

  it("does not mutate ECR when the attempted receipt cannot be saved", async () => {
    const f = fixture();
    const signing = await f.prepare();
    f.saveReceipt.mockImplementationOnce(() => {
      throw new Error("private receipt write failure");
    });
    await expect(f.sign(signing)).rejects.toThrow(/signing prerequisites failed/);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.receipt.signed).toBe(null);
    expect(f.receipt.deployable).toBe(false);
  });

  it.each(["profile", "runtime trust"])(
    "rechecks %s between signing and verification",
    async (changed) => {
      const f = fixture({
        output: (_command, args) => {
          if (args[0] !== "sign") return undefined;
          if (changed === "profile") f.profile.status = "Canceled";
          else write(join(f.temporary, "notation-signing", "config", "trustpolicy.json"), "{}");
          return undefined;
        },
      });
      const signing = await f.prepare();
      await expect(f.sign(signing)).rejects.toThrow(/verification prerequisites failed/);
      expect(f.run.mock.calls.map(([, args]) => args[0])).toEqual(["sign"]);
      expect(f.receipt.signed).toBe(null);
      expect(f.receipt.deployable).toBe(false);
      expect(f.snapshots.at(-1)?.signing).toMatchObject({ status: "signed" });
    },
  );

  it("does not start verification after cancellation during signing", async () => {
    const controller = new AbortController();
    const f = fixture({
      output: (_command, args) => {
        if (args[0] === "sign") controller.abort(new Error("operator cancelled"));
        return undefined;
      },
    });
    const signing = await f.prepare({ signal: controller.signal });
    await expect(f.sign(signing)).rejects.toThrow(/verification prerequisites failed/);
    expect(f.run.mock.calls.map(([, args]) => args[0])).toEqual(["sign"]);
    expect(f.receipt.signed).toBe(null);
    expect(f.receipt.deployable).toBe(false);
  });

  it("passes only isolated config, temporary credentials, and registry auth to each child", async () => {
    const f = fixture();
    const ambient = {
      HOME: "/private-existing-home",
      AWS_PROFILE: "ambient-profile",
      AWS_ROLE_ARN: "ambient-role",
      AWS_CONFIG_FILE: "/private/aws/config",
      AWS_SHARED_CREDENTIALS_FILE: "/private/aws/credentials",
      AWS_ENDPOINT_URL: "https://synthetic-endpoint.invalid",
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "https://synthetic-credentials.invalid",
      HTTPS_PROXY: "https://synthetic-proxy.invalid",
      DOCKER_CONFIG: "/private/docker",
      DOCKER_HOST: "tcp://synthetic-docker.invalid",
      NOTATION_CONFIG: "/private/notation",
      NOTATION_LIBEXEC: "/private/plugins",
      NOTATION_PASSWORD: "ambient-password",
    };
    for (const [key, value] of Object.entries(ambient)) {
      vi.stubEnv(key, value);
      f.credentials.env[key] = value;
    }
    const controller = new AbortController();
    const signing = await f.prepare({ signal: controller.signal });
    await f.sign(signing);
    for (const [, args, options] of f.run.mock.calls) {
      for (const [key, value] of Object.entries(ambient)) expect(options.env[key]).not.toBe(value);
      expect(options.env).toMatchObject({
        AWS_ACCESS_KEY_ID: "synthetic-access-key",
        AWS_SECRET_ACCESS_KEY: "synthetic-secret-key",
        AWS_SESSION_TOKEN: "synthetic-session-token",
        AWS_REGION: region,
        AWS_DEFAULT_REGION: region,
        AWS_CONFIG_FILE: "/dev/null",
        AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
        AWS_EC2_METADATA_DISABLED: "true",
        AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
        AWS_MAX_ATTEMPTS: "1",
        NOTATION_USERNAME: "AWS",
        NOTATION_PASSWORD: f.token,
      });
      expect(Object.keys(options.env).sort()).toEqual(
        [
          "PATH",
          "LC_ALL",
          "NOTATION_CONFIG",
          "NOTATION_LIBEXEC",
          "NOTATION_CACHE",
          "DOCKER_CONFIG",
          "AWS_REGION",
          "AWS_DEFAULT_REGION",
          "AWS_CONFIG_FILE",
          "AWS_SHARED_CREDENTIALS_FILE",
          "AWS_EC2_METADATA_DISABLED",
          "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS",
          "AWS_MAX_ATTEMPTS",
          "AWS_ACCESS_KEY_ID",
          "AWS_SECRET_ACCESS_KEY",
          "AWS_SESSION_TOKEN",
          "NOTATION_USERNAME",
          "NOTATION_PASSWORD",
        ].sort(),
      );
      expect(options.env.NOTATION_CONFIG).toBe(join(f.temporary, "notation-signing", "config"));
      expect(options.processGroup).toBe(true);
      expect(options.signal).toBe(controller.signal);
      expect(options.timeout).toBe(120_000);
      expect(JSON.stringify(args)).not.toContain(f.token);
      expect(JSON.stringify(args)).not.toContain("synthetic-secret-key");
    }
    for (const path of filesUnder(f.temporary)) {
      const contents = readFileSync(join(f.temporary, path), "utf8");
      expect(contents).not.toContain(f.token);
      expect(contents).not.toContain("synthetic-secret-key");
    }
    expect(JSON.stringify(f.snapshots)).not.toContain(f.token);
  });
});

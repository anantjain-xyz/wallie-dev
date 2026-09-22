import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
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
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import reviewedLock from "../../../infra/aws/signing-toolchain.lock.json";

type ToolchainLock = typeof reviewedLock;
type RunOptions = { cwd: string; env: NodeJS.ProcessEnv; timeout: number; signal?: AbortSignal };
type Runner = (
  command: string,
  args: string[],
  options: RunOptions,
) => Promise<{ stdout: string; stderr: string }>;
type Downloader = (
  url: string,
  destination: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<void>;
type PreparationOptions = {
  root: string;
  platform: string;
  arch: string;
  run: Runner;
  download: Downloader;
  lock: ToolchainLock;
  signal?: AbortSignal;
};
type Receipt = {
  signed: boolean;
  deployable: boolean;
  environment: NodeJS.ProcessEnv;
  files: { path: string; sha256: string }[];
};
let prepareSigningToolchain: (
  options: PreparationOptions,
) => Promise<{ directory: string; receipt: Receipt }>;

beforeAll(async () => {
  const script = new URL("../../../scripts/prepare-aws-signing-toolchain.mjs", import.meta.url)
    .href;
  ({ prepareSigningToolchain } = await import(script));
});

const temporaryRoots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Public AWS signing root from the reviewed installer; no private key is present.
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

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function write(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? filesUnder(path).map((child) => join(entry.name, child))
      : [entry.name];
  });
}

type FixtureOptions = {
  installerBytes?: string;
  payload?: (directory: string, lock: ToolchainLock) => void;
  output?: (command: string, args: string[]) => { stdout: string; stderr: string } | undefined;
};

function fixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wallie-signing-toolchain-test-"));
  temporaryRoots.push(root);
  const lock = structuredClone(reviewedLock);
  const installer = "reviewed installer fixture bytes";
  lock.installer.sha256 = sha256(installer);
  const payload = new Map(
    lock.files.map((file) => [
      file.source,
      file.source === lock.rootCertificate.file ? rootCertificate : `reviewed ${file.source}\n`,
    ]),
  );
  for (const file of lock.files) file.sha256 = sha256(payload.get(file.source)!);
  const events: string[] = [];
  const destination = join(root, ".wallie", "aws", "signing-toolchain");
  const download = vi.fn<Downloader>(async (_url, path) => {
    events.push("download");
    write(path, options.installerBytes ?? installer);
  });
  const run = vi.fn<Runner>(async (command, args) => {
    events.push(`${basename(command)} ${args.join(" ")}`);
    const override = options.output?.(command, args);
    if (override) return override;
    if (basename(command) === "curl" && args.includes("--version")) {
      return { stdout: "curl 8.7.1 (fixture)\n", stderr: "" };
    }
    if (basename(command) === "curl" && args.includes("--output")) {
      write(args[args.indexOf("--output") + 1], installer);
      return { stdout: "", stderr: "" };
    }
    if (basename(command) === "pkgutil" && args[0] === "--check-signature") {
      return {
        stdout: `Status: signed by a developer certificate issued by Apple for distribution\nNotarization: trusted by the Apple notary service\n1. ${lock.installer.publisher}\n${lock.installer.certificateSha256}`,
        stderr: "",
      };
    }
    if (basename(command) === "spctl") {
      return { stdout: "", stderr: "accepted\nsource=Notarized Developer ID" };
    }
    if (basename(command) === "pkgutil" && args[0] === "--expand-full") {
      const expanded = args[2];
      write(
        join(expanded, "PackageInfo"),
        `<pkg-info identifier="${lock.installer.identifier}" version="${lock.installer.version}"/>`,
      );
      for (const [file, contents] of payload) write(join(expanded, "Payload", file), contents);
      options.payload?.(join(expanded, "Payload"), lock);
      return { stdout: "", stderr: "" };
    }
    if (basename(command) === "codesign") return { stdout: "", stderr: "" };
    if (basename(command) === "notation" && args.join(" ") === "version") {
      return { stdout: `Version:     ${lock.notationVersion}\n`, stderr: "" };
    }
    if (basename(command) === "notation" && args.join(" ") === "plugin ls") {
      return {
        stdout: `NAME DESCRIPTION VERSION CAPABILITIES ERROR\n${lock.plugin.name} AWS Signer plugin for Notation ${lock.plugin.version} [SIGNATURE_GENERATOR.ENVELOPE SIGNATURE_VERIFIER.TRUSTED_IDENTITY SIGNATURE_VERIFIER.REVOCATION_CHECK] <nil>\n`,
        stderr: "",
      };
    }
    if (basename(command) === "notation" && args.join(" ") === "cert ls") {
      return {
        stdout: `signingAuthority/aws-signer-ts/${lock.rootCertificate.file}\n`,
        stderr: "",
      };
    }
    throw new Error(`Unexpected fixture command: ${command} ${args.join(" ")}`);
  });
  return {
    root,
    lock,
    destination,
    installer,
    events,
    run,
    download,
    prepare: (overrides: Partial<PreparationOptions> = {}) =>
      prepareSigningToolchain({
        root,
        lock,
        platform: "darwin",
        arch: "arm64",
        run,
        download,
        ...overrides,
      }),
  };
}

describe("AWS signing toolchain preparation", () => {
  it.each([
    ["linux", "arm64"],
    ["darwin", "x64"],
    ["win32", "arm64"],
  ])("rejects unsupported %s/%s before download or execution", async (platform, arch) => {
    const f = fixture();
    await expect(f.prepare({ platform, arch })).rejects.toThrow();
    expect(f.download).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(filesUnder(f.root)).toEqual([]);
  });

  it("does not overwrite an existing installation", async () => {
    const f = fixture();
    write(join(f.destination, "keep.txt"), "existing installation");
    await expect(f.prepare()).rejects.toThrow();
    expect(f.download).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(readFileSync(join(f.destination, "keep.txt"), "utf8")).toBe("existing installation");
  });

  it.each([".wallie", ".wallie/aws", ".wallie/aws/signing-toolchain"])(
    "rejects a symlink at %s without touching its target",
    async (linkedPath) => {
      const f = fixture();
      const outside = mkdtempSync(join(realpathSync(tmpdir()), "wallie-toolchain-outside-"));
      temporaryRoots.push(outside);
      write(join(outside, "keep.txt"), "private existing content");
      const linked = join(f.root, linkedPath);
      mkdirSync(dirname(linked), { recursive: true });
      symlinkSync(outside, linked);
      await expect(f.prepare()).rejects.toThrow();
      expect(f.download).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
      expect(lstatSync(linked).isSymbolicLink()).toBe(true);
      expect(filesUnder(outside)).toEqual(["keep.txt"]);
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("private existing content");
    },
  );

  it("rejects changed installer bytes before authentication, extraction, or execution", async () => {
    const f = fixture({ installerBytes: "tampered installer" });
    await expect(f.prepare()).rejects.toThrow();
    expect(f.download).toHaveBeenCalledTimes(1);
    expect(f.run).not.toHaveBeenCalled();
    expect(existsSync(f.destination)).toBe(false);
    expect(filesUnder(f.root)).toEqual([]);
  });

  it("bounds the default HTTPS download and ignores curl's ambient configuration", async () => {
    const f = fixture();
    await f.prepare({ download: undefined });
    expect(f.download).not.toHaveBeenCalled();
    expect(f.run.mock.calls[0].slice(0, 2)).toEqual(["/usr/bin/curl", ["--disable", "--version"]]);
    const [command, args, options] = f.run.mock.calls[1];
    expect(command).toBe("/usr/bin/curl");
    expect(args[0]).toBe("--disable");
    expect(args[args.indexOf("--proto") + 1]).toBe("=https");
    expect(Number(args[args.indexOf("--max-time") + 1])).toBeLessThanOrEqual(120);
    expect(Number(args[args.indexOf("--max-filesize") + 1])).toBe(f.lock.installer.maxBytes);
    expect(args).not.toContain("--insecure");
    expect(args).not.toContain("--location");
    expect(args.at(-1)).toBe(f.lock.installer.url);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(150_000);
  });

  it.each(["curl 8.3.0", "curl 7.88.1", "unexpected output", "curl 8.4"])(
    "rejects unsupported curl output %j before a network request",
    async (stdout) => {
      const f = fixture({
        output: (command) => (basename(command) === "curl" ? { stdout, stderr: "" } : undefined),
      });
      await expect(f.prepare({ download: undefined })).rejects.toThrow(/curl 8.4.0 or newer/);
      expect(f.run).toHaveBeenCalledTimes(1);
      expect(f.run.mock.calls[0][1]).toEqual(["--disable", "--version"]);
      expect(f.download).not.toHaveBeenCalled();
      expect(readdirSync(join(f.root, ".wallie", "aws"))).toEqual([]);
    },
  );

  it("enforces the downloaded size bound even with an injected downloader", async () => {
    const f = fixture();
    f.lock.installer.maxBytes = Buffer.byteLength(f.installer) - 1;
    await expect(f.prepare()).rejects.toThrow(/bounded regular file/);
    expect(f.run).not.toHaveBeenCalled();
    expect(filesUnder(f.root)).toEqual([]);
  });

  it.each(["publisher", "certificate", "notarization"])(
    "rejects an installer with a different %s before extraction",
    async (mismatch) => {
      const f = fixture({
        output: (command, args) => {
          if (basename(command) !== "pkgutil" || args[0] !== "--check-signature") return;
          return {
            stdout: `Status: signed by a developer certificate issued by Apple for distribution\n${mismatch === "notarization" ? "Notarization: unavailable" : "Notarization: trusted by the Apple notary service"}\n1. ${mismatch === "publisher" ? "Unrelated publisher" : f.lock.installer.publisher}\n${mismatch === "certificate" ? "0".repeat(64) : f.lock.installer.certificateSha256}`,
            stderr: "",
          };
        },
      });
      await expect(f.prepare()).rejects.toThrow(/identity or notarization/);
      expect(f.run.mock.calls.map(([command]) => basename(command))).toEqual(["pkgutil"]);
      expect(filesUnder(f.root)).toEqual([]);
    },
  );

  it.each(["rejected command", "untrusted assessment"])(
    "stops before extraction when Gatekeeper reports %s",
    async (failure) => {
      const f = fixture({
        output: (command) => {
          if (basename(command) !== "spctl") return;
          if (failure === "rejected command") throw new Error("Gatekeeper rejected package");
          return { stdout: "source=Unnotarized Developer ID", stderr: "" };
        },
      });
      await expect(f.prepare()).rejects.toThrow(/Gatekeeper/);
      expect(f.run.mock.calls.some(([, args]) => args.includes("--expand-full"))).toBe(false);
      expect(filesUnder(f.root)).toEqual([]);
    },
  );

  it.each(["hash", "symlink"])(
    "rejects a payload %s before executing downloaded binaries",
    async (failure) => {
      const f = fixture({
        payload: (directory, lock) => {
          const file = join(directory, lock.files[0].source);
          if (failure === "hash") writeFileSync(file, "tampered binary");
          else {
            const target = join(directory, "linked-binary");
            writeFileSync(target, readFileSync(file));
            rmSync(file);
            symlinkSync(target, file);
          }
        },
      });
      await expect(f.prepare()).rejects.toThrow();
      expect(f.run.mock.calls.some(([command]) => basename(command) === "notation")).toBe(false);
      expect(filesUnder(f.root)).toEqual([]);
    },
  );

  it("requires the executable's publisher signature before running it", async () => {
    const f = fixture({
      output: (command) => {
        if (basename(command) === "codesign") throw new Error("Executable signature rejected");
        return undefined;
      },
    });
    await expect(f.prepare()).rejects.toThrow(/signature rejected/);
    expect(f.run.mock.calls.some(([command]) => basename(command) === "notation")).toBe(false);
    const [, args] = f.run.mock.calls.find(([command]) => basename(command) === "codesign")!;
    expect(args).toContain("--verify");
    expect(args).toContain("--strict");
    expect(args[args.indexOf("-R") + 1]).toContain(f.lock.plugin.teamIdentifier);
    expect(filesUnder(f.root)).toEqual([]);
  });

  it("rejects an unexpected root identity before running downloaded binaries", async () => {
    const f = fixture();
    f.lock.rootCertificate.fingerprintSha256 = "0".repeat(64);
    await expect(f.prepare()).rejects.toThrow(/root certificate identity/);
    expect(f.run.mock.calls.some(([command]) => basename(command) === "notation")).toBe(false);
    expect(filesUnder(f.root)).toEqual([]);
  });

  it.each([0, Date.parse("2123-01-01T00:00:00Z")])(
    "rejects a root outside its validity period at epoch %s",
    async (now) => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      const f = fixture();
      await expect(f.prepare()).rejects.toThrow(/root certificate identity or validity/);
      expect(f.run.mock.calls.some(([command]) => basename(command) === "notation")).toBe(false);
      expect(filesUnder(f.root)).toEqual([]);
    },
  );

  it.each([
    ["version", "Version: 0.0.0"],
    ["plugin ls", "NAME VERSION\nunrelated-plugin 1.0.2292"],
    ["cert ls", "signingAuthority/unrelated-root/root.crt"],
  ])(
    "removes staging and leaves no receipt after failed %s validation",
    async (invocation, stdout) => {
      const f = fixture({
        output: (command, args) =>
          basename(command) === "notation" && args.join(" ") === invocation
            ? { stdout, stderr: "" }
            : undefined,
      });
      await expect(f.prepare()).rejects.toThrow();
      expect(existsSync(f.destination)).toBe(false);
      expect(readdirSync(join(f.root, ".wallie", "aws"))).toEqual([]);
    },
  );

  it("cleans partial downloads and permits a later retry", async () => {
    const f = fixture();
    f.download.mockImplementationOnce(async (_url, path) => {
      write(path, "partial bytes");
      throw new Error("download interrupted");
    });
    await expect(f.prepare()).rejects.toThrow(/download interrupted/);
    expect(readdirSync(join(f.root, ".wallie", "aws"))).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
    await f.prepare();
    expect(existsSync(join(f.destination, "receipt.json"))).toBe(true);
  });

  it("preserves an existing preparation lock and performs no work", async () => {
    const f = fixture();
    const path = join(f.root, ".wallie", "aws", ".signing-toolchain.prepare.lock");
    write(path, "another preparation owns this lock");
    await expect(f.prepare()).rejects.toThrow();
    expect(f.download).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe("another preparation owns this lock");
  });

  it("propagates cancellation and cleans staging before promoting the toolchain", async () => {
    const controller = new AbortController();
    const f = fixture({
      output: (command, args) => {
        if (basename(command) === "notation" && args.join(" ") === "cert ls")
          controller.abort(new Error("cancelled by operator"));
        return undefined;
      },
    });
    await expect(f.prepare({ signal: controller.signal })).rejects.toThrow(/cancelled by operator/);
    expect(f.download.mock.calls[0][2].signal).toBe(controller.signal);
    for (const [, , options] of f.run.mock.calls) expect(options.signal).toBe(controller.signal);
    expect(existsSync(f.destination)).toBe(false);
    expect(readdirSync(join(f.root, ".wallie", "aws"))).toEqual([]);
  });

  it("installs only reviewed files and a non-deployable receipt using isolated environments", async () => {
    const ambient = {
      HOME: "/existing-private-home",
      AWS_PROFILE: "existing-aws-profile",
      AWS_ACCESS_KEY_ID: "synthetic-access-key",
      AWS_SECRET_ACCESS_KEY: "synthetic-secret-key",
      AWS_SESSION_TOKEN: "synthetic-session-token",
      AWS_CONFIG_FILE: "/existing/aws/config",
      NOTATION_CONFIG: "/existing/notation/config",
      NOTATION_LIBEXEC: "/existing/notation/plugins",
      NOTATION_CACHE: "/existing/notation/cache",
      DOCKER_CONFIG: "/existing/docker/config",
      DOCKER_CONTENT_TRUST_REPOSITORY_PASSPHRASE: "synthetic-passphrase",
      HTTPS_PROXY: "https://synthetic-proxy.invalid",
      CURL_HOME: "/existing/curl",
    };
    for (const [key, value] of Object.entries(ambient)) vi.stubEnv(key, value);
    const f = fixture({ payload: (directory) => write(join(directory, "extra-file"), "ignored") });
    const result = await f.prepare();
    expect(result.directory).toBe(f.destination);
    const receipt = JSON.parse(readFileSync(join(f.destination, "receipt.json"), "utf8"));
    expect(receipt).toEqual(result.receipt);
    expect(receipt).toMatchObject({ signed: false, deployable: false });
    expect(filesUnder(f.destination).sort()).toEqual(
      [...f.lock.files.map((file) => file.destination), "receipt.json"].sort(),
    );
    expect(readdirSync(join(f.root, ".wallie", "aws"))).toEqual(["signing-toolchain"]);
    for (const file of f.lock.files) {
      const path = join(f.destination, file.destination);
      expect(sha256(readFileSync(path, "utf8"))).toBe(file.sha256);
      expect(lstatSync(path).mode & 0o777).toBe(file.executable ? 0o700 : 0o600);
    }
    expect(lstatSync(join(f.destination, "receipt.json")).mode & 0o777).toBe(0o600);
    const environments = [
      f.download.mock.calls[0][2].env,
      ...f.run.mock.calls.map(([, , options]) => options.env),
      receipt.environment,
    ];
    for (const environment of environments) {
      expect(Object.keys(environment).sort()).toEqual([
        "DOCKER_CONFIG",
        "LC_ALL",
        "NOTATION_CACHE",
        "NOTATION_CONFIG",
        "NOTATION_LIBEXEC",
        "PATH",
      ]);
      for (const [key, value] of Object.entries(ambient)) expect(environment[key]).not.toBe(value);
      expect(environment.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
      for (const key of [
        "NOTATION_CONFIG",
        "NOTATION_LIBEXEC",
        "NOTATION_CACHE",
        "DOCKER_CONFIG",
      ]) {
        expect(environment[key]).toMatch(new RegExp(`^${f.root}/\\.wallie/aws/`));
      }
    }
    expect(receipt.environment.NOTATION_CONFIG).toBe(join(f.destination, "config"));
    expect(receipt.environment.NOTATION_LIBEXEC).toBe(join(f.destination, "libexec"));
    expect(receipt.environment.NOTATION_CACHE).toBe(join(f.destination, "cache"));
    expect(receipt.environment.DOCKER_CONFIG).toBe(join(f.destination, "docker"));
    expect(f.run.mock.calls.some(([command]) => basename(command) === "installer")).toBe(false);
  });

  it.each(["--url=https://example.invalid/package", "--skip-verification", "--help"])(
    "rejects CLI override %s before installation",
    (argument) => {
      const script = fileURLToPath(
        new URL("../../../scripts/prepare-aws-signing-toolchain.mjs", import.meta.url),
      );
      const result = spawnSync(process.execPath, [script, argument], {
        env: { NODE_ENV: "test", PATH: "" },
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Usage:");
    },
  );
});

import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);

async function runCommand(command, args, options) {
  return execute(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024, ...options });
}

async function requireAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Path already exists: ${path}`);
}

async function ensureDirectory(path, create = true) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Expected a directory without symlinks: ${current}`);
      }
    } catch (error) {
      if (!create || error.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

async function checkedFile(path, expectedHash, maxBytes = 32 * 1024 * 1024) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new Error(`Expected a bounded regular file: ${path}`);
  }
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
    throw new Error(`SHA-256 mismatch: ${path}`);
  }
  return bytes;
}

function isolatedEnvironment(directory) {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LC_ALL: "C",
    NOTATION_CONFIG: join(directory, "config"),
    NOTATION_LIBEXEC: join(directory, "libexec"),
    NOTATION_CACHE: join(directory, "cache"),
    DOCKER_CONFIG: join(directory, "docker"),
  };
}

export async function prepareSigningToolchain(dependencies = {}) {
  const signal = dependencies.signal;
  signal?.throwIfAborted();
  const root = resolve(dependencies.root ?? repositoryRoot);
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error("This reviewed toolchain supports macOS arm64 only");
  }
  const lock =
    dependencies.lock ??
    JSON.parse(
      await readFile(new URL("../infra/aws/signing-toolchain.lock.json", import.meta.url), "utf8"),
    );
  const run = dependencies.run ?? runCommand;
  const download =
    dependencies.download ??
    (async (url, destination, options) => {
      const version = await run("/usr/bin/curl", ["--disable", "--version"], {
        ...options,
        timeout: 10_000,
      });
      const match = /^curl (\d+)\.(\d+)\.(\d+)\b/.exec(version.stdout);
      if (!match || Number(match[1]) < 8 || (Number(match[1]) === 8 && Number(match[2]) < 4)) {
        throw new Error("System curl 8.4.0 or newer is required to bound streaming downloads");
      }
      return run(
        "/usr/bin/curl",
        [
          "--disable",
          "--fail",
          "--silent",
          "--show-error",
          "--proto",
          "=https",
          "--tlsv1.2",
          "--max-time",
          "120",
          "--max-filesize",
          String(lock.installer.maxBytes),
          "--output",
          destination,
          url,
        ],
        { ...options, timeout: 150_000 },
      );
    });
  const parent = join(root, ".wallie", "aws");
  const destination = join(parent, "signing-toolchain");
  await ensureDirectory(root, false);
  await ensureDirectory(parent);
  await requireAbsent(destination);
  const lockPath = join(parent, ".signing-toolchain.prepare.lock");
  const preparationLock = await open(lockPath, "wx", 0o600);
  let staging;
  try {
    staging = await mkdtemp(join(parent, ".signing-toolchain-"));
    await chmod(staging, 0o700);
    const prepared = join(staging, "prepared");
    await ensureDirectory(prepared);
    const env = isolatedEnvironment(prepared);
    const options = { cwd: staging, env, timeout: 60_000, signal };
    const installer = join(staging, "aws-signer-notation-cli_arm64.pkg");
    await download(lock.installer.url, installer, { env, cwd: staging, signal });
    await checkedFile(installer, lock.installer.sha256, lock.installer.maxBytes);

    const signature = await run("/usr/sbin/pkgutil", ["--check-signature", installer], options);
    const signatureText = `${signature.stdout}\n${signature.stderr}`;
    if (
      !signatureText.includes(
        "Status: signed by a developer certificate issued by Apple for distribution",
      ) ||
      !signatureText.includes("Notarization: trusted by the Apple notary service") ||
      !signatureText.includes(`1. ${lock.installer.publisher}`) ||
      !signatureText.replace(/\s/g, "").includes(lock.installer.certificateSha256)
    ) {
      throw new Error("Package identity or notarization did not match the reviewed AWS publisher");
    }
    const assessment = await run(
      "/usr/sbin/spctl",
      ["--assess", "--type", "install", "--verbose=4", installer],
      options,
    );
    if (!`${assessment.stdout}\n${assessment.stderr}`.includes("source=Notarized Developer ID")) {
      throw new Error("Gatekeeper did not authenticate the notarized package");
    }
    const expanded = join(staging, "expanded");
    await run("/usr/sbin/pkgutil", ["--expand-full", installer, expanded], options);
    await ensureDirectory(expanded, false);
    const packageInfo = await readFile(join(expanded, "PackageInfo"), "utf8");
    if (
      !packageInfo.includes(`identifier="${lock.installer.identifier}"`) ||
      !packageInfo.includes(`version="${lock.installer.version}"`)
    ) {
      throw new Error("Unexpected package identifier or version");
    }
    const payload = join(expanded, "Payload");
    await ensureDirectory(payload, false);
    for (const file of lock.files) {
      const source = join(payload, file.source);
      await checkedFile(source, file.sha256);
      const target = join(prepared, file.destination);
      await ensureDirectory(dirname(target));
      await copyFile(source, target);
      await chmod(target, file.executable ? 0o700 : 0o600);
      await checkedFile(target, file.sha256);
      if (file.executable) {
        await run(
          "/usr/bin/codesign",
          [
            "--verify",
            "--strict",
            "--verbose=2",
            "-R",
            `=anchor apple generic and certificate leaf[subject.OU] = "${lock.plugin.teamIdentifier}"`,
            target,
          ],
          options,
        );
      }
    }
    const certificate = new X509Certificate(
      await readFile(join(payload, lock.rootCertificate.file)),
    );
    if (
      !certificate.ca ||
      !certificate.verify(certificate.publicKey) ||
      certificate.fingerprint256.replaceAll(":", "") !== lock.rootCertificate.fingerprintSha256 ||
      Date.now() < Date.parse(certificate.validFrom) ||
      Date.now() > Date.parse(certificate.validTo)
    ) {
      throw new Error("AWS root certificate identity or validity did not match");
    }
    await ensureDirectory(env.NOTATION_CACHE);
    await ensureDirectory(env.DOCKER_CONFIG);
    const notation = join(prepared, "bin", "notation");
    const version = await run(notation, ["version"], options);
    if (
      !version.stdout
        .split(/\r?\n/)
        .some((line) => line.trim().split(/\s+/).join(" ") === `Version: ${lock.notationVersion}`)
    ) {
      throw new Error("Unexpected Notation version");
    }
    const plugins = await run(notation, ["plugin", "ls"], options);
    const pluginLines = plugins.stdout.trim().split(/\r?\n/);
    if (
      pluginLines.length !== 2 ||
      !pluginLines[1].startsWith(`${lock.plugin.name} `) ||
      !pluginLines[1].split(/\s+/).includes(lock.plugin.version) ||
      !pluginLines[1].trim().endsWith("<nil>") ||
      ![
        "SIGNATURE_GENERATOR.ENVELOPE",
        "SIGNATURE_VERIFIER.TRUSTED_IDENTITY",
        "SIGNATURE_VERIFIER.REVOCATION_CHECK",
      ].every((capability) => pluginLines[1].includes(capability))
    ) {
      throw new Error("AWS plugin metadata did not match the reviewed toolchain");
    }
    const certificates = await run(notation, ["cert", "ls"], options);
    if (
      !["signingAuthority", "aws-signer-ts", lock.rootCertificate.file].every((part) =>
        certificates.stdout.includes(part),
      )
    ) {
      throw new Error("Notation did not discover the isolated AWS root certificate");
    }
    const receipt = {
      schemaVersion: 1,
      preparedAt: new Date().toISOString(),
      platform,
      arch,
      installerVersion: lock.installer.version,
      installerSha256: lock.installer.sha256,
      notationVersion: lock.notationVersion,
      pluginName: lock.plugin.name,
      pluginVersion: lock.plugin.version,
      rootCertificateFingerprintSha256: lock.rootCertificate.fingerprintSha256,
      files: lock.files.map(({ destination: path, sha256 }) => ({ path, sha256 })),
      environment: isolatedEnvironment(destination),
      signed: false,
      deployable: false,
    };
    await writeFile(join(prepared, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await ensureDirectory(parent, false);
    await requireAbsent(destination);
    signal?.throwIfAborted();
    await rename(prepared, destination);
    return { directory: destination, receipt };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await preparationLock.close();
    await rm(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  try {
    if (process.argv.length !== 2)
      throw new Error("Usage: node scripts/prepare-aws-signing-toolchain.mjs");
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    const result = await prepareSigningToolchain({ signal: controller.signal });
    console.log(`[aws-signing-toolchain] Prepared ${result.directory}`);
  } catch (error) {
    console.error(`[aws-signing-toolchain] ${error.message}`);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

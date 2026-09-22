import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, join, parse, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

const profileName = "wallie_staging_images";
const pluginName = "com.amazonaws.signer.notation.plugin";
const timeout = 120_000;
const lifetimeMargin = 30_000;
const expectedTags = {
  Name: profileName,
  Project: "Wallie",
  Environment: "staging",
  ManagedBy: "Terraform",
  Component: "signing",
  WallieStack: "wallie-staging-registry",
};
const requireThat = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function directory(path, create = false) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      requireThat(
        (await lstat(current)).isDirectory(),
        "Signing paths must be directories without symlinks",
      );
    } catch (error) {
      if (!create || error.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

async function regularBytes(path) {
  await directory(dirname(path));
  const info = await lstat(path);
  requireThat(
    info.isFile() && info.size <= 32 * 1024 * 1024,
    "Signing files must be bounded regular files without symlinks",
  );
  return readFile(path);
}

async function verifiedBytes(path, sha256) {
  const bytes = await regularBytes(path);
  requireThat(
    createHash("sha256").update(bytes).digest("hex") === sha256,
    "Signing toolchain hash does not match the reviewed manifest",
  );
  return bytes;
}

async function fileNames(path, prefix = "") {
  await directory(path);
  const names = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    requireThat(!entry.isSymbolicLink(), "Signing configuration must not contain symlinks");
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) names.push(...(await fileNames(join(path, entry.name), name)));
    else {
      requireThat(entry.isFile(), "Signing configuration must contain only regular files");
      names.push(name);
    }
  }
  return names.sort();
}

export async function prepareImageSigning({
  root,
  temporary,
  account,
  region,
  profileVersion,
  run,
  now = Date.now,
  signal,
  platform = process.platform,
  arch = process.arch,
  lock,
}) {
  requireThat(
    platform === "darwin" && arch === "arm64",
    "Image signing requires the reviewed macOS arm64 toolchain",
  );
  requireThat(
    typeof account === "string" &&
      /^\d{12}$/.test(account) &&
      account.length === 12 &&
      typeof region === "string" &&
      /^[a-z]{2}-[a-z]+-\d+$/.test(region) &&
      region === region.trim() &&
      !region.startsWith("cn-") &&
      typeof profileVersion === "string" &&
      /^[a-zA-Z0-9]{10}$/.test(profileVersion) &&
      profileVersion.length === 10,
    "Image signing requires an exact account, commercial region, and profile version",
  );
  const manifest =
    lock ??
    JSON.parse(
      await readFile(
        new URL("../../infra/aws/signing-toolchain.lock.json", import.meta.url),
        "utf8",
      ),
    );
  const profileArn = `arn:aws:signer:${region}:${account}:/signing-profiles/${profileName}`;
  const profileVersionArn = `${profileArn}/${profileVersion}`;
  const registry = `${account}.dkr.ecr.${region}.amazonaws.com`;
  const toolchain = join(resolve(root), ".wallie", "aws", "signing-toolchain");
  await directory(toolchain);
  await directory(resolve(temporary));
  const runtime = join(resolve(temporary), "notation-signing");
  await mkdir(runtime, { mode: 0o700 });
  const requiredFiles = [];
  for (const file of manifest.files) {
    const bytes = await verifiedBytes(join(toolchain, file.destination), file.sha256);
    if (!file.executable && file.source !== manifest.rootCertificate.file) continue;
    requiredFiles.push(file);
    const target = join(runtime, file.destination);
    await directory(dirname(target), true);
    await writeFile(target, bytes, { mode: file.executable ? 0o700 : 0o600, flag: "wx" });
    await chmod(target, file.executable ? 0o700 : 0o600);
    await verifiedBytes(target, file.sha256);
  }
  const expectedPolicy = {
    version: "1.0",
    trustPolicies: [
      {
        name: "wallie-staging-images",
        registryScopes: ["web", "worker"].map(
          (component) => `${registry}/wallie-staging/${component}`,
        ),
        signatureVerification: { level: "strict" },
        trustStores: ["signingAuthority:aws-signer-ts"],
        trustedIdentities: [profileVersionArn],
      },
    ],
  };
  const template = await readFile(
    new URL("../../infra/aws/image-signing-trust-policy.template.json", import.meta.url),
    "utf8",
  );
  const policy = JSON.parse(
    template
      .replaceAll("<ACCOUNT_ID>", account)
      .replaceAll("<REGION>", region)
      .replaceAll("<PARTITION>", "aws")
      .replaceAll("<PROFILE_VERSION>", profileVersion)
      .replaceAll("<TRUST_STORE>", "aws-signer-ts"),
  );
  requireThat(
    isDeepStrictEqual(policy, expectedPolicy),
    "Signing trust template no longer matches the strict reviewed policy",
  );
  const policyBytes = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`);
  const policyPath = join(runtime, "config", "trustpolicy.json");
  await writeFile(policyPath, policyBytes, { mode: 0o600, flag: "wx" });
  for (const name of ["cache", "docker"]) await mkdir(join(runtime, name), { mode: 0o700 });
  const baseEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LC_ALL: "C",
    NOTATION_CONFIG: join(runtime, "config"),
    NOTATION_LIBEXEC: join(runtime, "libexec"),
    NOTATION_CACHE: join(runtime, "cache"),
    DOCKER_CONFIG: join(runtime, "docker"),
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_CONFIG_FILE: devNull,
    AWS_SHARED_CREDENTIALS_FILE: devNull,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
    AWS_MAX_ATTEMPTS: "1",
  };
  const verifyRuntime = async () => {
    signal?.throwIfAborted();
    for (const file of requiredFiles)
      await verifiedBytes(join(runtime, file.destination), file.sha256);
    requireThat(
      (await regularBytes(policyPath)).equals(policyBytes),
      "Signing trust policy changed during publishing",
    );
    for (const name of ["bin", "config", "libexec"]) {
      const expected = requiredFiles
        .filter((file) => file.destination.startsWith(`${name}/`))
        .map((file) => file.destination.slice(name.length + 1));
      if (name === "config") expected.push("trustpolicy.json");
      requireThat(
        isDeepStrictEqual(await fileNames(join(runtime, name)), expected.sort()),
        "Unexpected signing configuration or tool files",
      );
    }
  };
  await verifyRuntime();

  const verifyProfile = async (aws) => {
    let profile, tags;
    try {
      profile = await aws("signer", "get-signing-profile", [
        "--profile-name",
        profileName,
        "--profile-owner",
        account,
      ]);
      tags = await aws("signer", "list-tags-for-resource", ["--resource-arn", profileArn]);
    } catch {
      throw new Error("Could not verify the reviewed AWS signing profile");
    }
    requireThat(
      profile?.profileName === profileName &&
        profile.arn === profileArn &&
        profile.profileVersion === profileVersion &&
        profile.profileVersionArn === profileVersionArn &&
        profile.status === "Active" &&
        profile.platformId === "Notation-OCI-SHA384-ECDSA" &&
        profile.signatureValidityPeriod?.value === 1 &&
        profile.signatureValidityPeriod?.type === "YEARS" &&
        !Object.hasOwn(profile, "revocationRecord") &&
        Object.entries(expectedTags).every(([key, value]) => tags?.tags?.[key] === value),
      "AWS signing profile identity, version, status, lifetime, or ownership does not match",
    );
  };

  const signAndVerify = async ({ aws, getCredentials, receipt, saveReceipt, nonce }) => {
    receipt.deployable = false;
    requireThat(
      ["web", "worker"].includes(receipt.component) &&
        receipt.repository === `${registry}/wallie-staging/${receipt.component}` &&
        /^sha256:[a-f0-9]{64}$/.test(receipt.digest ?? "") &&
        receipt.digest.length === 71 &&
        receipt.uploadStatus === "confirmed" &&
        receipt.scan?.status === "COMPLETE" &&
        receipt.scan.fresh === true &&
        receipt.scan.counts?.HIGH === 0 &&
        receipt.scan.counts?.CRITICAL === 0 &&
        typeof nonce === "string" &&
        /^[a-f0-9]{32}$/.test(nonce) &&
        nonce.length === 32,
      "Signing requires this run's confirmed image and fresh passing scan",
    );
    const reference = `${receipt.repository}@${receipt.digest}`;
    const metadata = `wallie.dev/publish-id=${nonce}`;
    let phase = "signing prerequisites";
    try {
      for (const operation of ["sign", "verify"]) {
        phase = operation === "sign" ? "signing prerequisites" : "verification prerequisites";
        await verifyProfile(aws);
        const password = await aws("ecr", "get-login-password", [], true);
        const snapshot = await getCredentials();
        const printable = (value) =>
          typeof value === "string" &&
          value.length > 0 &&
          value.length <= 128 * 1024 &&
          !/[^\x21-\x7e]/.test(value);
        const credentialKeys = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
        requireThat(
          printable(password) &&
            credentialKeys.every((key) => printable(snapshot?.env?.[key])) &&
            Number.isFinite(now()) &&
            Date.parse(snapshot?.expiration) - now() > timeout + lifetimeMargin,
          "Signing requires validated credentials with sufficient remaining lifetime",
        );
        await verifyRuntime();
        const env = {
          ...baseEnv,
          ...Object.fromEntries(credentialKeys.map((key) => [key, snapshot.env[key]])),
          NOTATION_USERNAME: "AWS",
          NOTATION_PASSWORD: password,
        };
        const args =
          operation === "sign"
            ? [
                "sign",
                reference,
                "--plugin",
                pluginName,
                "--id",
                profileArn,
                "--plugin-config",
                `aws-region=${region}`,
                "--signature-format",
                "jws",
                "--force-referrers-tag=false",
                "--user-metadata",
                metadata,
              ]
            : [
                "verify",
                reference,
                "--plugin-config",
                `aws-region=${region}`,
                "--max-signatures",
                "100",
                "--user-metadata",
                metadata,
              ];
        if (operation === "sign") {
          receipt.signing = {
            status: "attempted",
            profileVersionArn,
            nonce,
            reference,
            requestedAt: new Date(now()).toISOString(),
            notationVersion: manifest.notationVersion,
            pluginVersion: manifest.plugin.version,
          };
          receipt.signed = null;
          await saveReceipt();
        }
        phase = operation === "sign" ? "signing" : "strict verification";
        requireThat(
          Date.parse(snapshot.expiration) - now() > timeout + lifetimeMargin,
          "Temporary credentials no longer have sufficient lifetime for Notation",
        );
        const output = await run(join(runtime, "bin", "notation"), args, {
          cwd: runtime,
          env,
          signal,
          timeout,
          processGroup: true,
        });
        requireThat(
          typeof output === "string" &&
            (operation === "sign"
              ? output.trim() === `Successfully signed ${reference}`
              : output.trim().split(/\r?\n/)[0] ===
                `Successfully verified signature for ${reference}`),
          "Notation did not confirm the exact image digest",
        );
        receipt.signing.status = operation === "sign" ? "signed" : "verified";
        if (operation === "verify") {
          receipt.signed = true;
          receipt.signing.verifiedAt = new Date(now()).toISOString();
        }
        await saveReceipt();
      }
    } catch {
      throw new Error(`Image ${phase} failed; inspect the signing state in the private receipt`);
    }
  };
  return { verifyProfile, signAndVerify };
}

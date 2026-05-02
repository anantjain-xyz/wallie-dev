import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";
const ivByteLength = 12;
const keyByteLength = 32;
const currentVersion = "v2";

// HKDF parameters are part of the v2 ciphertext contract — changing either
// value would make every existing v2 row undecryptable. Add a v3 instead.
const hkdfSalt = Buffer.from("wallie/secret-encryption/v2/salt");
const hkdfInfo = Buffer.from("wallie/secret-encryption/aes-256-gcm/v2");

function deriveV1Key(secret: string) {
  return createHash("sha256").update(secret).digest();
}

function deriveV2Key(secret: string) {
  return Buffer.from(hkdfSync("sha256", secret, hkdfSalt, hkdfInfo, keyByteLength));
}

function deriveKeyForVersion(version: string, secret: string) {
  switch (version) {
    case "v1":
      return deriveV1Key(secret);
    case "v2":
      return deriveV2Key(secret);
    default:
      throw new Error("Encrypted secret payload is invalid.");
  }
}

function encodePart(value: Buffer) {
  return value.toString("base64url");
}

function decodePart(value: string) {
  return Buffer.from(value, "base64url");
}

function getEncryptionSecret(input: Record<string, string | undefined> = process.env) {
  const secret = input.WALLIE_ENCRYPTION_KEY?.trim();

  if (!secret) {
    throw new Error("WALLIE_ENCRYPTION_KEY is required.");
  }

  return secret;
}

export function buildSecretPreview(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.length > 6 ? `...${trimmed.slice(-6)}` : trimmed;
}

export function encryptSecretValue(
  plaintext: string,
  input: Record<string, string | undefined> = process.env,
) {
  const key = deriveKeyForVersion(currentVersion, getEncryptionSecret(input));
  const iv = randomBytes(ivByteLength);
  const cipher = createCipheriv(algorithm, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [currentVersion, encodePart(iv), encodePart(ciphertext), encodePart(authTag)].join(".");
}

export function decryptSecretValue(
  encrypted: string,
  input: Record<string, string | undefined> = process.env,
) {
  const [encodedVersion, encodedIv, encodedCiphertext, encodedAuthTag] = encrypted.split(".");

  if (!encodedVersion || !encodedIv || !encodedCiphertext || !encodedAuthTag) {
    throw new Error("Encrypted secret payload is invalid.");
  }

  const key = deriveKeyForVersion(encodedVersion, getEncryptionSecret(input));
  const decipher = createDecipheriv(algorithm, key, decodePart(encodedIv));
  decipher.setAuthTag(decodePart(encodedAuthTag));

  const plaintext = Buffer.concat([
    decipher.update(decodePart(encodedCiphertext)),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}

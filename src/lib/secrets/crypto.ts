import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";
const ivByteLength = 12;
const version = "v1";

function deriveEncryptionKey(secret: string) {
  return createHash("sha256").update(secret).digest();
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
  const key = deriveEncryptionKey(getEncryptionSecret(input));
  const iv = randomBytes(ivByteLength);
  const cipher = createCipheriv(algorithm, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [version, encodePart(iv), encodePart(ciphertext), encodePart(authTag)].join(
    ".",
  );
}

export function decryptSecretValue(
  encrypted: string,
  input: Record<string, string | undefined> = process.env,
) {
  const [encodedVersion, encodedIv, encodedCiphertext, encodedAuthTag] =
    encrypted.split(".");

  if (
    encodedVersion !== version ||
    !encodedIv ||
    !encodedCiphertext ||
    !encodedAuthTag
  ) {
    throw new Error("Encrypted secret payload is invalid.");
  }

  const key = deriveEncryptionKey(getEncryptionSecret(input));
  const decipher = createDecipheriv(algorithm, key, decodePart(encodedIv));
  decipher.setAuthTag(decodePart(encodedAuthTag));

  const plaintext = Buffer.concat([
    decipher.update(decodePart(encodedCiphertext)),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}

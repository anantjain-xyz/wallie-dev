import "server-only";

import { parseServerEnv } from "@/env/server";

export const githubAppEnvKeys = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"] as const;
export const githubInstallEnvKeys = [
  ...githubAppEnvKeys,
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
] as const;
export const githubWebhookEnvKeys = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
] as const;

export function getMissingGitHubEnvKeys(
  keys: readonly string[],
  input: Record<string, string | undefined> = process.env,
) {
  return keys.filter((key) => !input[key]?.trim());
}

export function getGitHubConfigStatus(input: Record<string, string | undefined> = process.env) {
  return {
    missingAppKeys: getMissingGitHubEnvKeys(githubInstallEnvKeys, input),
    missingWebhookKeys: getMissingGitHubEnvKeys(githubWebhookEnvKeys, input),
  };
}

const PKCS1_RSA_HEADER = "-----BEGIN RSA PRIVATE KEY-----";
const PKCS1_RSA_FOOTER = "-----END RSA PRIVATE KEY-----";
const PKCS8_HEADER = "-----BEGIN PRIVATE KEY-----";
const PKCS8_FOOTER = "-----END PRIVATE KEY-----";

// GitHub downloads App private keys as PKCS#1 PEM. WebCrypto (and therefore
// universal-github-app-jwt on workerd) only imports PKCS#8. Wrap the PKCS#1
// DER in PrivateKeyInfo rather than relying on Node's createPrivateKey, which
// is not available in every runtime bundle.
function derLength(length: number) {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) {
    bytes.unshift(remaining & 0xff);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function derElement(tag: number, contents: Uint8Array) {
  const length = derLength(contents.length);
  const element = new Uint8Array(1 + length.length + contents.length);
  element[0] = tag;
  element.set(length, 1);
  element.set(contents, 1 + length.length);
  return element;
}

function concatBytes(...parts: Uint8Array[]) {
  const combined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(value: Uint8Array) {
  let binary = "";
  for (let index = 0; index < value.length; index += 0x8000) {
    binary += String.fromCharCode(...value.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function pkcs1ToPkcs8(pem: string) {
  const start = pem.indexOf(PKCS1_RSA_HEADER);
  const end = pem.indexOf(PKCS1_RSA_FOOTER);

  if (start === -1 || end === -1 || end < start) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not a valid RSA private key.");
  }

  const pkcs1 = decodeBase64(pem.slice(start + PKCS1_RSA_HEADER.length, end).replace(/\s+/g, ""));
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithmIdentifier = Uint8Array.of(
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  );
  const privateKey = derElement(0x04, pkcs1);
  const privateKeyInfo = derElement(0x30, concatBytes(version, rsaAlgorithmIdentifier, privateKey));
  const base64 = encodeBase64(privateKeyInfo);
  const lines = base64.match(/.{1,64}/g) ?? [];

  return `${PKCS8_HEADER}\n${lines.join("\n")}\n${PKCS8_FOOTER}`;
}

export function normalizePrivateKey(value: string) {
  const pem = value.replace(/\\n/g, "\n");

  if (!pem.includes(PKCS1_RSA_HEADER)) return pem;

  return pkcs1ToPkcs8(pem);
}

export function resolveGitHubAppConfig(input: Record<string, string | undefined> = process.env) {
  const env = parseServerEnv(input);

  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required.");
  }

  return {
    appId: Number(env.GITHUB_APP_ID),
    privateKey: normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY),
  };
}

export function resolveGitHubWebhookSecret(
  input: Record<string, string | undefined> = process.env,
) {
  const env = parseServerEnv(input);

  if (!env.GITHUB_WEBHOOK_SECRET) {
    throw new Error("GITHUB_WEBHOOK_SECRET is required.");
  }

  return env.GITHUB_WEBHOOK_SECRET;
}

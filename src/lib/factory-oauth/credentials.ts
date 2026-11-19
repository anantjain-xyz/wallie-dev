import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";

const prefixes = { code: "wallie_oc_", access: "wallie_oa_", refresh: "wallie_or_" };
const opaqueCredential = /^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.([A-Za-z0-9_-]{43})$/;

type CredentialKind = keyof typeof prefixes;

function digestSecret(secret: string) {
  return createHash("sha256").update(secret, "ascii").digest("hex");
}

export function issueFactoryOAuthCredential(kind: CredentialKind) {
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  return { id, digest: digestSecret(secret), credential: `${prefixes[kind]}${id}.${secret}` };
}

export function parseFactoryOAuthCredential(kind: CredentialKind, presented: string) {
  const prefix = prefixes[kind];
  if (!presented.startsWith(prefix)) return null;
  const parsed = presented.slice(prefix.length).match(opaqueCredential);
  if (!parsed) return null;
  return { id: parsed[1], digest: digestSecret(parsed[2]) };
}

export function factoryOAuthPKCEChallenge(verifier: string) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

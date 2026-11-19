import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";

const format = /^wallie_mt_([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.([A-Za-z0-9_-]{43})$/;

function digestSecret(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function issueFactoryMachineTokenSecret() {
  const tokenId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  return { tokenId, digest: digestSecret(secret), credential: `wallie_mt_${tokenId}.${secret}` };
}

// Send only the identifier and digest to the authoritative command transaction.
export function parseFactoryMachineToken(authorization: string | null) {
  const header = authorization?.match(/^Bearer (\S+)$/i);
  const token = header?.[1]?.match(format);
  if (!token) return null;
  return { tokenId: token[1], digest: digestSecret(token[2]) };
}

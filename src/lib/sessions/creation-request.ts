import "server-only";

import { createHash } from "node:crypto";

import {
  normalizeCreateSessionPayload,
  type CreateSessionPayload,
} from "@/features/sessions/create";

/** Hash user intent before Linear data, generated titles, or defaults can change. */
export function fingerprintSessionCreation(payload: CreateSessionPayload) {
  return createHash("sha256")
    .update(JSON.stringify({ ...normalizeCreateSessionPayload(payload), requestId: undefined }))
    .digest("hex");
}

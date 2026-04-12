import { createHmac, timingSafeEqual } from "node:crypto";

export const SLACK_REQUEST_MAX_AGE_SECONDS = 300;

export function verifySlackSignature(body: string, timestamp: string, signature: string): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > SLACK_REQUEST_MAX_AGE_SECONDS) return false;

  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature = `v0=${createHmac("sha256", secret).update(sigBasestring).digest("hex")}`;

  try {
    return timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
  } catch {
    return false;
  }
}

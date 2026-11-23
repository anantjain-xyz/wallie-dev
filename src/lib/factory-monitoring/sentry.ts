import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";

import { factoryResponseHeaders } from "@/lib/factories/route-context";
import { readBoundedJsonBytes } from "@/lib/http/bounded-json-body";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import { monitoringBindingId, monitoringSignalReceiptSchema, parseSentryAlert } from "./contracts";

const signatureShape = /^[a-f0-9]{64}$/;
const signingSecretSchema = z.strictObject({ encryptedSecret: z.string().min(1) });
const maximumBodyBytes = 256 * 1024;

function response(status: number, code: string) {
  return Response.json({ status: code }, { status, headers: factoryResponseHeaders });
}

export async function handleSentryAlert(
  request: Request,
  rawBindingId: string,
  admin?: Pick<ReturnType<typeof createSupabaseAdminClient>, "rpc">,
) {
  const bindingId = monitoringBindingId.safeParse(rawBindingId);
  const signature = request.headers.get("Sentry-Hook-Signature");
  if (!bindingId.success || !signature || !signatureShape.test(signature))
    return response(401, "unauthorized");
  if (request.headers.get("Sentry-Hook-Resource") !== "event_alert")
    return response(400, "invalid_request");

  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(850)]);
  const raw = await readBoundedJsonBytes(request, maximumBodyBytes, signal);
  if (signal.aborted) return response(503, "unavailable");
  if (!raw.ok) {
    const status = { request_too_large: 413, unsupported_media_type: 415, invalid_request: 400 };
    return response(status[raw.code], raw.code);
  }

  try {
    admin ??= createSupabaseAdminClient();
    const { data: config, error: readError } = await admin
      .rpc("read_factory_monitoring_secret", { p_binding_id: bindingId.data })
      .abortSignal(signal);
    if (readError) return response(503, "unavailable");
    if (config === null) return response(401, "unauthorized");
    const binding = signingSecretSchema.parse(config);
    const secret = decryptSecretValue(binding.encryptedSecret);
    const digest = createHmac("sha256", secret).update(raw.bytes).digest();
    if (!timingSafeEqual(digest, Buffer.from(signature, "hex")))
      return response(401, "unauthorized");

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.bytes));
    } catch {
      return response(400, "invalid_request");
    }
    const alert = parseSentryAlert(payload);
    if (!alert) return response(400, "invalid_request");
    const { data: receipt, error: writeError } = await admin
      .rpc("record_factory_monitoring_signal", {
        p_binding_id: bindingId.data,
        p_installation_id: alert.installationId,
        p_project_id: alert.projectId,
        p_event_id: alert.eventId,
        p_issue_id: alert.issueId,
        p_command_id: alert.commandId,
        p_environment: alert.environment,
        p_source_sha: alert.sourceSha,
        p_event_at: alert.eventAt,
        p_body_digest: createHash("sha256").update(raw.bytes).digest("hex"),
      })
      .abortSignal(signal);
    if (writeError) return response(503, "unavailable");
    const decision = monitoringSignalReceiptSchema.parse(receipt);
    if (decision.status === "rate_limited") return response(429, decision.status);
    return Response.json(decision, { status: 202, headers: factoryResponseHeaders });
  } catch {
    return response(503, "unavailable");
  }
}

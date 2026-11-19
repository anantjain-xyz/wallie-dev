import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";

import { factoryCommandScopeSchema } from "@/lib/factory-machine-tokens/contracts";
import { parseFactoryMachineToken } from "@/lib/factory-machine-tokens/secret";
import { parseFactoryOAuthCredential } from "@/lib/factory-oauth/credentials";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

type Admin = Pick<ReturnType<typeof createSupabaseAdminClient>, "rpc">;
type AdmissionInput = Database["public"]["Functions"]["admit_factory_command"]["Args"];

export type FactoryCommandTransactionInput = Readonly<
  AdmissionInput & { p_admission_id: string; p_lease_id: string }
>;

const uuid = z.string().uuid().toLowerCase();
const requestSchema = z.object({
  workspaceId: uuid,
  factoryId: uuid,
  scope: factoryCommandScopeSchema,
  surface: z.enum(["api", "mcp"]),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
});

type AuthorizationRequest = z.input<typeof requestSchema> & { authorization: string | null };

const admissionRowSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("admitted"),
    admission_id: uuid,
    lease_id: uuid,
    lease_expires_at: z.string().datetime({ offset: true }),
    workspace_id: uuid,
    factory_id: uuid,
    service_principal_id: uuid,
    execution_grant_id: uuid,
    execution_grant_version: z.number().int().positive().safe(),
    consenting_member_id: uuid.nullable(),
    scope: factoryCommandScopeSchema,
  }),
  z.object({
    status: z.enum(["unauthorized", "forbidden", "request_conflict", "already_admitted"]),
  }),
  z.object({
    status: z.enum(["rate_limited", "concurrency_limited"]),
    retry_after_seconds: z.number().int().positive().safe(),
  }),
]);

type FactoryCommandActor = Readonly<
  | { kind: "machine_token"; servicePrincipalId: string }
  | { kind: "oauth_access_token"; servicePrincipalId: string; consentingMemberId: string }
>;

export type FactoryCommandReceipt = Readonly<{
  id: string;
  workspaceId: string;
  factoryId: string;
  scope: AdmissionInput["p_scope"];
  surface: AdmissionInput["p_surface"];
  executionGrantId: string;
  executionGrantVersion: number;
  expiresAt: string;
  actor: FactoryCommandActor;
}>;

const admissionBrand = Symbol("factory-command-admission");
export type FactoryCommandAdmission = Readonly<{
  receipt: FactoryCommandReceipt;
  [admissionBrand]: true;
}>;

const transactionInputs = new WeakMap<FactoryCommandAdmission, FactoryCommandTransactionInput>();

export type FactoryCommandDenial =
  | { ok: false; code: "invalid_request"; status: 400 }
  | { ok: false; code: "unauthorized"; status: 401 }
  | { ok: false; code: "forbidden"; status: 403 }
  | { ok: false; code: "request_conflict" | "already_admitted"; status: 409 }
  | {
      ok: false;
      code: "rate_limited" | "concurrency_limited";
      status: 429;
      retryAfterSeconds: number;
    }
  | { ok: false; code: "unavailable"; status: 503 };

export type FactoryCommandAuthorization =
  | { ok: true; admission: FactoryCommandAdmission }
  | FactoryCommandDenial;

const unavailable = Object.freeze({ ok: false, code: "unavailable", status: 503 });

function parseCredential(authorization: string | null) {
  const match = authorization?.match(/^Bearer (\S+)$/i);
  if (!match || match[0] !== authorization) return null;

  const machine = parseFactoryMachineToken(authorization);
  if (machine)
    return { kind: "machine_token", id: machine.tokenId, digest: machine.digest } as const;
  const oauth = parseFactoryOAuthCredential("access", match[1]);
  return oauth
    ? ({ kind: "oauth_access_token", id: oauth.id, digest: oauth.digest } as const)
    : null;
}

/** Admit one machine request. The hash describes canonical intent, separate from write idempotency. */
export async function authorizeFactoryCommand(
  request: AuthorizationRequest,
  admin?: Admin,
): Promise<FactoryCommandAuthorization> {
  const credential = parseCredential(request.authorization);
  if (!credential) return { ok: false, code: "unauthorized", status: 401 };
  const parsedRequest = requestSchema.safeParse(request);
  if (!parsedRequest.success) return { ok: false, code: "invalid_request", status: 400 };
  const { workspaceId, factoryId, scope, surface, requestHash } = parsedRequest.data;
  const input: AdmissionInput = {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_credential_kind: credential.kind,
    p_credential_id: credential.id,
    p_credential_digest: credential.digest,
    p_scope: scope,
    p_request_id: randomUUID(),
    p_request_hash: requestHash,
    p_surface: surface,
  };

  try {
    const client = admin ?? createSupabaseAdminClient();
    const { data, error } = await client.rpc("admit_factory_command", input).single();
    if (error) return unavailable;
    const parsedRow = admissionRowSchema.safeParse(data);
    if (!parsedRow.success) return unavailable;
    const row = parsedRow.data;
    switch (row.status) {
      case "unauthorized":
        return { ok: false, code: row.status, status: 401 };
      case "forbidden":
        return { ok: false, code: row.status, status: 403 };
      case "request_conflict":
      case "already_admitted":
        return { ok: false, code: row.status, status: 409 };
      case "rate_limited":
      case "concurrency_limited":
        return {
          ok: false,
          code: row.status,
          status: 429,
          retryAfterSeconds: row.retry_after_seconds,
        };
      case "admitted": {
        if (
          row.workspace_id !== workspaceId ||
          row.factory_id !== factoryId ||
          row.scope !== scope
        ) {
          return unavailable;
        }

        const {
          consenting_member_id: consentingMemberId,
          service_principal_id: servicePrincipalId,
        } = row;
        if ((credential.kind === "oauth_access_token") !== (consentingMemberId !== null)) {
          return unavailable;
        }
        const actor: FactoryCommandActor =
          consentingMemberId === null
            ? { kind: "machine_token", servicePrincipalId }
            : { kind: "oauth_access_token", servicePrincipalId, consentingMemberId };

        const admission: FactoryCommandAdmission = Object.freeze({
          receipt: Object.freeze({
            id: row.admission_id,
            workspaceId,
            factoryId,
            scope,
            surface,
            executionGrantId: row.execution_grant_id,
            executionGrantVersion: row.execution_grant_version,
            expiresAt: row.lease_expires_at,
            actor: Object.freeze(actor),
          }),
          [admissionBrand]: true as const,
        });
        transactionInputs.set(
          admission,
          Object.freeze({
            ...input,
            p_admission_id: row.admission_id,
            p_lease_id: row.lease_id,
          }),
        );
        return { ok: true, admission };
      }
    }
  } catch {
    return unavailable;
  }
}

/** Pass this only to a server RPC that calls the credential and lease guard in its transaction. */
export function factoryCommandTransactionInput(
  admission: FactoryCommandAdmission,
): FactoryCommandTransactionInput {
  const input = transactionInputs.get(admission);
  if (!input) throw new Error("Factory command admission is unavailable in this process.");
  return input;
}

/** Release the exact lease after a protected operation, including failed operations. */
export async function releaseFactoryCommandAdmission(
  admission: FactoryCommandAdmission,
  admin?: Admin,
): Promise<boolean> {
  const input = transactionInputs.get(admission);
  if (!input) return false;

  try {
    const client = admin ?? createSupabaseAdminClient();
    const { data, error } = await client.rpc("release_factory_command_admission", {
      p_admission_id: input.p_admission_id,
      p_lease_id: input.p_lease_id,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

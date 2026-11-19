import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import { issueFactoryMachineTokenSecret } from "@/lib/factory-machine-tokens/secret";
import { issueFactoryOAuthCredential } from "@/lib/factory-oauth/credentials";
import type { Database } from "@/lib/supabase/database.types";

import {
  authorizeFactoryCommand,
  factoryCommandTransactionInput,
  releaseFactoryCommandAdmission,
} from "./server";

const workspaceId = "186a64ac-7b2f-4cc4-8d82-2eb212929743";
const factoryId = "d65a10b3-becf-4d28-ad84-8c948e67fab1";
const admissionId = "936bce28-b57f-4080-9c57-e14457f161c2";
const leaseId = "b4715b22-07d6-4441-afe7-1991228c19a0";
const servicePrincipalId = "2fda6119-f993-4a1a-92e7-269fc76b9be6";
const executionGrantId = "4adf2b86-58ab-49f9-8d4d-fc157a3c0a3e";
const consentingMemberId = "b91b5bf5-f291-4094-bf3f-761ec65c9037";
const scope = "sessions:follow-up";
const requestHash = "c".repeat(64);
const expiresAt = "2026-11-19T08:09:10.123+00:00";

const request = {
  authorization: null,
  workspaceId,
  factoryId,
  scope,
  surface: "api",
  requestHash,
} as const;

const admittedRow = {
  status: "admitted",
  admission_id: admissionId,
  lease_id: leaseId,
  lease_expires_at: expiresAt,
  workspace_id: workspaceId,
  factory_id: factoryId,
  service_principal_id: servicePrincipalId,
  execution_grant_id: executionGrantId,
  execution_grant_version: 2,
  consenting_member_id: null,
  scope,
} as const;

function fixture(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const admin = createClient<Database>("https://database.example.test", "fixture", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch },
  });
  return { admin, fetch };
}

it("admits a machine request with a fresh receipt ID and keeps the credential and lease private", async () => {
  const { admin, fetch } = fixture(Response.json(admittedRow), Response.json(true));
  const machine = issueFactoryMachineTokenSecret();
  const untrustedRequestId = "2e5217be-0fb8-4f33-93ca-8c4bedeb6b61";
  const command = {
    ...request,
    authorization: `Bearer ${machine.credential}`,
    workspaceId: workspaceId.toUpperCase(),
    requestId: untrustedRequestId,
  };
  const result = await authorizeFactoryCommand(command, admin);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected an admitted command.");

  const { admission } = result;
  expect(JSON.parse(JSON.stringify(admission))).toEqual({
    receipt: {
      id: admissionId,
      workspaceId,
      factoryId,
      scope,
      surface: "api",
      executionGrantId,
      executionGrantVersion: 2,
      expiresAt,
      actor: { kind: "machine_token", servicePrincipalId },
    },
  });

  const transaction = factoryCommandTransactionInput(admission);
  expect(transaction.p_request_id).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(transaction.p_request_id).not.toBe(untrustedRequestId);
  const expectedInput = {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_scope: scope,
    p_surface: "api",
    p_credential_kind: "machine_token",
    p_credential_id: machine.tokenId,
    p_credential_digest: machine.digest,
    p_request_id: transaction.p_request_id,
    p_request_hash: requestHash,
  };
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(expectedInput);
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "https://database.example.test/rest/v1/rpc/admit_factory_command",
  );
  expect(transaction).toEqual({
    ...expectedInput,
    p_admission_id: admissionId,
    p_lease_id: leaseId,
  });
  expect(Object.isFrozen(transaction)).toBe(true);

  const clone = { ...admission };
  expect(() => factoryCommandTransactionInput(clone)).toThrow("admission is unavailable");
  await expect(releaseFactoryCommandAdmission(clone, admin)).resolves.toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);

  await expect(releaseFactoryCommandAdmission(admission, admin)).resolves.toBe(true);
  expect(fetch.mock.calls[1]?.[0]).toBe(
    "https://database.example.test/rest/v1/rpc/release_factory_command_admission",
  );
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
    p_admission_id: admissionId,
    p_lease_id: leaseId,
  });
});

it("keeps OAuth attribution and intent tied to the authorized MCP request", async () => {
  const row = { ...admittedRow, consenting_member_id: consentingMemberId };
  const { admin } = fixture(Response.json(row), Response.json(row), Response.json(false));
  const access = issueFactoryOAuthCredential("access");
  const command = {
    ...request,
    surface: "mcp",
    authorization: `Bearer ${access.credential}`,
  } as const;
  const first = await authorizeFactoryCommand(command, admin);
  const second = await authorizeFactoryCommand(command, admin);
  if (!first.ok || !second.ok) throw new Error("Expected both commands to be admitted.");

  expect(first.admission.receipt).toMatchObject({
    surface: "mcp",
    actor: { kind: "oauth_access_token", servicePrincipalId, consentingMemberId },
  });
  const firstInput = factoryCommandTransactionInput(first.admission);
  expect(firstInput).toMatchObject({
    p_credential_kind: "oauth_access_token",
    p_credential_id: access.id,
    p_credential_digest: access.digest,
    p_surface: "mcp",
    p_request_hash: requestHash,
  });
  expect(firstInput.p_request_id).not.toBe(
    factoryCommandTransactionInput(second.admission).p_request_id,
  );
  await expect(releaseFactoryCommandAdmission(first.admission, admin)).resolves.toBe(false);
});

it("rejects missing, browser, mixed, and other OAuth credential types before admission", async () => {
  const { admin, fetch } = fixture();
  const { credential } = issueFactoryMachineTokenSecret();
  const invalid = [
    null,
    `Basic ${credential}`,
    "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJicm93c2VyIn0.signature",
    `Bearer ${issueFactoryOAuthCredential("code").credential}`,
    `Bearer ${issueFactoryOAuthCredential("refresh").credential}`,
    `Bearer ${credential}, Bearer ${credential}`,
    `Bearer ${credential}\n`,
  ];

  for (const authorization of invalid) {
    await expect(authorizeFactoryCommand({ ...request, authorization }, admin)).resolves.toEqual({
      ok: false,
      code: "unauthorized",
      status: 401,
    });
  }
  await expect(
    authorizeFactoryCommand(
      { ...request, authorization: `Bearer ${credential}`, requestHash: "invalid" },
      admin,
    ),
  ).resolves.toEqual({ ok: false, code: "invalid_request", status: 400 });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ["unauthorized", 401],
  ["forbidden", 403],
  ["request_conflict", 409],
  ["already_admitted", 409],
])("returns the typed %s decision without issuing a receipt", async (code, status) => {
  const { admin } = fixture(Response.json({ ...admittedRow, status: code }));
  const { credential } = issueFactoryMachineTokenSecret();
  await expect(
    authorizeFactoryCommand({ ...request, authorization: `Bearer ${credential}` }, admin),
  ).resolves.toEqual({ ok: false, code, status });
});

it.each(["rate_limited", "concurrency_limited"])(
  "returns the stable %s decision with the authoritative Retry-After seconds",
  async (code) => {
    const { admin } = fixture(Response.json({ status: code, retry_after_seconds: 37 }));
    const { credential } = issueFactoryMachineTokenSecret();
    await expect(
      authorizeFactoryCommand({ ...request, authorization: `Bearer ${credential}` }, admin),
    ).resolves.toEqual({ ok: false, code, status: 429, retryAfterSeconds: 37 });
  },
);

it.each([
  { ...admittedRow, factory_id: workspaceId },
  { ...admittedRow, scope: "sessions:read" },
  { ...admittedRow, consenting_member_id: consentingMemberId },
  { status: "rate_limited", retry_after_seconds: 0 },
  { status: "unknown" },
])("fails closed for an inconsistent or malformed decision", async (row) => {
  const { admin } = fixture(Response.json(row));
  const { credential } = issueFactoryMachineTokenSecret();
  await expect(
    authorizeFactoryCommand({ ...request, authorization: `Bearer ${credential}` }, admin),
  ).resolves.toEqual({ ok: false, code: "unavailable", status: 503 });
});

it("returns a stable failure if the database includes a private diagnostic", async () => {
  const { credential, digest } = issueFactoryMachineTokenSecret();
  const { admin } = fixture(Response.json({ message: digest }, { status: 400 }));
  await expect(
    authorizeFactoryCommand({ ...request, authorization: `Bearer ${credential}` }, admin),
  ).resolves.toEqual({ ok: false, code: "unavailable", status: 503 });
});

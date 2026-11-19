import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import { issueFactoryMachineTokenSecret } from "@/lib/factory-machine-tokens/secret";
import type { Database } from "@/lib/supabase/database.types";

import { factoryDeploymentScope } from "./contracts";
import { handleFactoryDeploymentObservation } from "./server";

const workspaceId = "af620841-5687-4b81-b052-be4561d18a5b";
const factoryId = "6da879a8-5be7-4f36-a830-8624a31ae253";
const sourceId = "3b4474e2-ea9a-4775-a521-91cfdd331791";
const admissionId = "4fef5d64-ae02-4c32-8b42-cf13d9fa6245";
const leaseId = "2a592178-9b3e-4c1b-9760-e172401170b4";
const scope = { workspaceId, factoryId };
const report = {
  sourceId,
  externalDeploymentId: "deployment-592",
  environment: "production",
  revision: 1,
  outcome: "succeeded",
  sourceRevision: "a".repeat(40),
  providerOccurredAt: "2026-01-02T11:00:00Z",
};
const receipt = {
  deploymentId: "e36ddf05-8129-4204-8be9-fb94c2a08850",
  observationId: "44f53e0b-145e-4401-90a1-2699454e4237",
  repositoryId: "e3197f4c-7200-46d5-ba77-a58a2d6f3203",
  currentRevision: 2,
  revision: report.revision,
  environment: report.environment,
  outcome: report.outcome,
  sourceRevision: report.sourceRevision,
  providerOccurredAt: report.providerOccurredAt,
  authoritativeOccurredAt: report.providerOccurredAt,
  observedAt: "2026-01-03T11:00:00Z",
  replayed: false,
};

function admitted() {
  return Response.json({
    status: "admitted",
    admission_id: admissionId,
    lease_id: leaseId,
    lease_expires_at: "2026-01-03T11:01:00Z",
    workspace_id: workspaceId,
    factory_id: factoryId,
    service_principal_id: "1bd983f9-2f21-4b2b-ac08-cb60772c5b16",
    execution_grant_id: "ab4be954-42bb-4c52-a22d-d1a51cdb342a",
    execution_grant_version: 1,
    consenting_member_id: null,
    scope: factoryDeploymentScope,
  });
}

function fixture(...responses: Response[]) {
  const token = issueFactoryMachineTokenSecret();
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const admin = createClient<Database>("https://database.example.test", "fixture", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch },
  });
  function request(body: unknown, options: RequestInit = {}) {
    return new Request("https://wallie.example.test/api/v1/resource", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token.credential}`,
      },
      body: JSON.stringify(body),
      ...options,
    });
  }
  const rpcBody = (index: number) => JSON.parse(String(fetch.mock.calls[index]?.[1]?.body));
  const invoked = () =>
    fetch.mock.calls.map(([url]) => new URL(String(url)).pathname.split("/").at(-1));
  return { admin, token, request, fetch, rpcBody, invoked };
}

it("uses an observe-only admission and returns an exact private receipt for late reports and replay", async () => {
  const test = fixture(
    admitted(),
    Response.json({ ...receipt, untrustedPrivateField: "excluded" }),
    Response.json(true),
    admitted(),
    Response.json({ ...receipt, replayed: true }),
    Response.json(true),
  );
  const recorded = await handleFactoryDeploymentObservation(
    test.request(report),
    scope,
    test.admin,
  );
  const replayed = await handleFactoryDeploymentObservation(
    test.request(report),
    scope,
    test.admin,
  );
  expect(test.invoked()).toEqual([
    "admit_factory_command",
    "execute_factory_deployment_observation",
    "release_factory_command_admission",
    "admit_factory_command",
    "execute_factory_deployment_observation",
    "release_factory_command_admission",
  ]);
  expect(test.rpcBody(0)).toMatchObject({
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_credential_id: test.token.tokenId,
    p_scope: factoryDeploymentScope,
    p_surface: "api",
  });
  expect(test.rpcBody(1)).toMatchObject({
    p_request_hash: test.rpcBody(0).p_request_hash,
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_source_id: sourceId,
    p_external_deployment_id: report.externalDeploymentId,
    p_environment: report.environment,
    p_provider_occurred_at: report.providerOccurredAt,
    p_source_sha: report.sourceRevision,
    p_revision: report.revision,
    p_outcome: report.outcome,
    p_admission_id: admissionId,
    p_lease_id: leaseId,
  });
  expect(test.rpcBody(3).p_request_hash).toBe(test.rpcBody(0).p_request_hash);
  expect(test.rpcBody(3).p_request_id).not.toBe(test.rpcBody(0).p_request_id);
  expect(recorded.status).toBe(201);
  expect(recorded.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await recorded.json()).toEqual(receipt);
  expect(replayed.status).toBe(200);
  expect(await replayed.json()).toEqual({ ...receipt, replayed: true });
});

it("rejects tenant claims, invalid revisions and oversized streamed input before admission", async () => {
  const test = fixture();
  const invalidRequests = [
    test.request({ ...report, repositoryId: receipt.repositoryId }),
    test.request({ ...report, revision: 0 }),
    test.request({ ...report, providerOccurredAt: "2026-01-02" }),
    test.request({ ...report, sourceRevision: "latest" }),
  ];
  for (const request of invalidRequests) {
    const response = await handleFactoryDeploymentObservation(request, scope, test.admin);
    expect(response.status).toBe(400);
  }
  const oversized = await handleFactoryDeploymentObservation(
    test.request({ ...report, externalDeploymentId: "a".repeat(4200) }),
    scope,
    test.admin,
  );
  expect(oversized.status).toBe(413);
  expect(test.fetch).not.toHaveBeenCalled();
});

it("returns a bearer challenge, preserves unknown fields and releases a rejected source lease", async () => {
  const test = fixture(
    admitted(),
    Response.json({ code: "PT403", message: "Private SQL error" }, { status: 403 }),
    Response.json(true),
  );
  const bad = await handleFactoryDeploymentObservation(
    test.request(report, { headers: { "Content-Type": "application/json" } }),
    scope,
    test.admin,
  );
  expect(bad.status).toBe(401);
  expect(bad.headers.get("WWW-Authenticate")).toBe("Bearer");
  const unknown = { ...report, outcome: "unknown", sourceRevision: null, providerOccurredAt: null };
  const wrongSource = await handleFactoryDeploymentObservation(
    test.request(unknown),
    scope,
    test.admin,
  );
  expect(wrongSource.status).toBe(403);
  expect(await wrongSource.json()).toMatchObject({ code: "forbidden" });
  expect(test.rpcBody(1)).not.toHaveProperty("p_source_sha");
  expect(test.rpcBody(1)).not.toHaveProperty("p_provider_occurred_at");
  expect(test.invoked().at(-1)).toBe("release_factory_command_admission");
});

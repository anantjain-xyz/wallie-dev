import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, it, vi } from "vitest";

import { issueFactoryMachineTokenSecret } from "@/lib/factory-machine-tokens/secret";
import type { Database } from "@/lib/supabase/database.types";

import { factoryMutationRoutes } from "./contracts";
import { handleFactoryMutation } from "./server";

const postCommit = vi.hoisted(() => ({ cleanup: vi.fn(), wake: vi.fn() }));
vi.mock("@/lib/pipeline/cancel", () => ({ cleanupSessionWorkReceipt: postCommit.cleanup }));
vi.mock("@/lib/worker/wake", () => ({ wakeWorker: postCommit.wake }));

const workspaceId = "52f04e24-3346-4e4d-ba9e-b17d8967ce91";
const factoryId = "268b8668-c478-45fd-b5e4-1b1c7bf4b59c";
const actorId = "c4f45da6-0878-4081-8641-1bce59441347";
const agentId = "82dd5d76-ab3a-4d59-9ee2-c32c55b2e16c";
const admissionId = "05f63910-93f9-41e8-9b64-36b8bf7d79e5";
const leaseId = "ccb82d9d-5bcb-4069-a499-1e9e5df0dc92";
const sessionId = "adc689db-3a99-493a-8f2b-682307c79095";
const artifactId = "6c6ac2b8-3ae6-4457-bd95-e7cd26707a49";
const runId = "e20dd01a-6720-4d29-a496-a613cf4b2e15";
const stageId = "0f452959-9ee5-41c7-8b9a-142888a401eb";
const requestKey = "a57bfd37-6827-4c8b-9f01-996807d365d7";
const clarificationId = "8efbdd43-8653-4a23-a545-3364a4c8bdd1";
const receiptId = "f153edd4-bc8c-4b53-b780-06368d1e7e5d";
const repositoryId = "a5ce03d5-0a66-4110-a938-cda348dcfcf5";
const jobId = "b2b1b694-6484-4681-ba96-9e5c7a7edaad";

const scope = { workspaceId, factoryId };
const sessionScope = { ...scope, sessionId };
const createBody = {
  title: "Build a view",
  prompt: "Show the active projects.",
  agentId,
  repositoryId,
};
const exactReview = { artifactId, artifactVersion: 4, reviewRevision: 12 };
const result = {
  receiptId,
  sessionId,
  sessionNumber: 12,
  workspaceSlug: "work-fixture",
  phaseStatus: "in_progress",
  jobId,
  runId,
  replayed: false,
};

function admission(scope: string) {
  return Response.json({
    status: "admitted",
    admission_id: admissionId,
    lease_id: leaseId,
    lease_expires_at: "2026-11-19T08:09:10.092731+00:00",
    workspace_id: workspaceId,
    factory_id: factoryId,
    service_principal_id: actorId,
    execution_grant_id: agentId,
    execution_grant_version: 7,
    consenting_member_id: null,
    scope,
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
  const request = (body: unknown, headers?: Record<string, string>) =>
    new Request("https://wallie.test/api/v1/resource", {
      method: "POST",
      headers: headers ?? {
        "Content-Type": "application/json",
        "Idempotency-Key": requestKey,
        Authorization: `Bearer ${token.credential}`,
      },
      body: JSON.stringify(body),
    });
  const rpcBody = (call: number) => JSON.parse(String(fetch.mock.calls[call]?.[1]?.body));
  return { admin, token, fetch, request, rpcBody };
}

beforeEach(() => {
  postCommit.wake.mockReset();
  postCommit.cleanup.mockReset();
});

it("returns the same durable create receipt when an exact retry receives a fresh admission", async () => {
  const createScope = factoryMutationRoutes.create.scope;
  const { admin, token, fetch, request, rpcBody } = fixture(
    admission(createScope),
    Response.json({ ...result, privateDigest: "keep private" }),
    Response.json(true),
    admission(createScope),
    Response.json({ ...result, replayed: true }),
    Response.json(true),
  );
  const first = await handleFactoryMutation(
    "create",
    request({ ...createBody, title: ` ${createBody.title} `, agentId: agentId.toUpperCase() }),
    scope,
    admin,
  );
  const retry = await handleFactoryMutation(
    "create",
    request({ ...createBody, draftSpecification: false }),
    scope,
    admin,
  );
  expect(first.status).toBe(201);
  expect(retry.status).toBe(200);
  const expected = {
    ...result,
    canonicalUrl: "/w/work-fixture/sessions/12",
    conversationUrl: `/api/v1/workspaces/${workspaceId}/factories/${factoryId}/sessions/${sessionId}/conversation`,
  };
  expect(await first.json()).toEqual(expected);
  expect(await retry.json()).toEqual({ ...expected, replayed: true });
  expect(first.headers.get("Cache-Control")).toBe("private, no-store");
  expect(fetch.mock.calls.map(([url]) => String(url).split("/").at(-1))).toEqual([
    "admit_factory_command",
    "execute_factory_session_mutation",
    "release_factory_command_admission",
    "admit_factory_command",
    "execute_factory_session_mutation",
    "release_factory_command_admission",
  ]);
  expect(rpcBody(0)).toMatchObject({ p_scope: createScope });
  const command = rpcBody(1);
  expect(command).toEqual({
    p_operation: "create",
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_request_key: requestKey,
    p_request_id: rpcBody(0).p_request_id,
    p_request_hash: rpcBody(0).p_request_hash,
    p_credential_kind: "machine_token",
    p_credential_id: token.tokenId,
    p_credential_digest: token.digest,
    p_surface: "api",
    p_admission_id: admissionId,
    p_lease_id: leaseId,
    p_payload: { ...createBody, draftSpecification: false },
  });
  expect(rpcBody(4)).toEqual({ ...command, p_request_id: rpcBody(3).p_request_id });
  expect(command.p_request_id).not.toBe(rpcBody(4).p_request_id);
  expect(postCommit.wake).toHaveBeenCalledTimes(2);
  expect(fetch.mock.invocationCallOrder[2]).toBeLessThan(
    postCommit.wake.mock.invocationCallOrder[0],
  );
});

it("returns a committed receipt for a workspace slug generated from a long name", async () => {
  const workspaceSlug = `long-workspace-${"1234567890".repeat(6)}-2`;
  const { admin, request } = fixture(
    admission("sessions:create"),
    Response.json({ ...result, workspaceSlug, replayed: true }),
    Response.json(true),
  );

  const response = await handleFactoryMutation("create", request(createBody), scope, admin);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    receiptId,
    replayed: true,
    workspaceSlug,
    canonicalUrl: `/w/${workspaceSlug}/sessions/12`,
  });
});

it.each([
  {
    operation: "follow_up",
    scope: "sessions:follow-up",
    params: sessionScope,
    body: { ...exactReview, stageId, feedback: "Change the summary." },
    payload: { ...exactReview, sessionId, stageId, feedback: "Change the summary." },
    receipt: { ...result, feedbackBatchId: receiptId },
  },
  {
    operation: "answer_clarification",
    scope: "sessions:clarify",
    params: { ...sessionScope, clarificationId },
    body: { ...exactReview, answer: "Use the UTC deadline." },
    payload: { ...exactReview, sessionId, clarificationId, answer: "Use the UTC deadline." },
    receipt: { ...result, clarificationId, executionExhausted: false },
  },
  {
    operation: "cancel",
    scope: "sessions:cancel",
    params: sessionScope,
    body: { expectedRunId: runId },
    payload: { sessionId, expectedRunId: runId },
    receipt: {
      ...result,
      phaseStatus: "rejected",
      jobIds: [jobId],
      runIds: [runId],
      replayed: true,
    },
  },
] as const)("uses exact $scope authority and intent for $operation", async (test) => {
  const { admin, fetch, request, rpcBody } = fixture(
    admission(test.scope),
    Response.json(test.receipt),
    Response.json(true),
  );
  const response = await handleFactoryMutation(
    test.operation,
    request(test.body),
    test.params,
    admin,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject(test.receipt);
  expect(rpcBody(0)).toMatchObject({ p_scope: test.scope });
  expect(rpcBody(1)).toMatchObject({
    p_operation: test.operation,
    p_request_key: requestKey,
    p_payload: test.payload,
  });
  expect(rpcBody(2)).toEqual({ p_admission_id: admissionId, p_lease_id: leaseId });
  if (test.operation === "cancel") {
    expect(postCommit.wake).not.toHaveBeenCalled();
    expect(postCommit.cleanup).toHaveBeenCalledExactlyOnceWith(admin, {
      workspaceId,
      receipt: { job_ids: [jobId], run_ids: [runId] },
    });
    expect(fetch.mock.invocationCallOrder[2]).toBeLessThan(
      postCommit.cleanup.mock.invocationCallOrder[0],
    );
  }
});

it.each([
  ["P0005", 409, "idempotency_conflict"],
  ["P0003", 409, "stale_intent"],
  ["PT409", 409, "request_conflict"],
  ["PT423", 409, "clarification_required"],
  ["PT422", 422, "unready"],
  ["42501", 401, "unauthorized"],
  ["PT403", 403, "forbidden"],
  ["PT404", 404, "not_found"],
  ["XX001", 503, "unavailable"],
] as const)(
  "releases the admission and reports stable errors for %s",
  async (sqlCode, status, code) => {
    const { admin, fetch, request } = fixture(
      admission("sessions:follow-up"),
      Response.json({ code: sqlCode, message: "private DB information" }, { status: 400 }),
      Response.json(false),
    );
    const response = await handleFactoryMutation(
      "follow_up",
      request({ ...exactReview, stageId, feedback: "Change the summary." }),
      sessionScope,
      admin,
    );
    const body = await response.json();
    expect(response.status).toBe(status);
    expect(body).toMatchObject({ code });
    expect(JSON.stringify(body)).not.toContain("private DB information");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(postCommit.wake).not.toHaveBeenCalled();
    expect(postCommit.cleanup).not.toHaveBeenCalled();
  },
);

it("does not execute a denied operation and returns its authoritative retry interval", async () => {
  const { admin, fetch, request } = fixture(
    Response.json({
      status: "concurrency_limited",
      retry_after_seconds: 9,
    }),
  );
  const response = await handleFactoryMutation("create", request(createBody), scope, admin);
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("9");
  expect(await response.json()).toMatchObject({
    code: "concurrency_limited",
    retryAfterSeconds: 9,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects missing and oversized input or unexpected authority before the mutation RPC", async () => {
  const { admin, token, fetch, request } = fixture();
  const authorization = { Authorization: `Bearer ${token.credential}` };
  const headers = { "Idempotency-Key": requestKey, "Content-Type": "application/json" };
  const missing = await handleFactoryMutation(
    "create",
    request(createBody, { ...authorization, "Content-Type": "application/json" }),
    scope,
    admin,
  );
  const oversized = await handleFactoryMutation(
    "create",
    request({ ...createBody, prompt: "x".repeat(256 * 1024) }),
    scope,
    admin,
  );
  const media = await handleFactoryMutation(
    "create",
    request(createBody, { ...headers, ...authorization, "Content-Type": "text/plain" }),
    scope,
    admin,
  );
  const unexpected = await handleFactoryMutation(
    "create",
    request({ ...createBody, actorMemberId: actorId }),
    scope,
    admin,
  );
  const browser = await handleFactoryMutation(
    "create",
    request(createBody, { ...headers, Authorization: "Bearer browser.session.jwt" }),
    scope,
    admin,
  );
  expect([
    missing.status,
    oversized.status,
    media.status,
    unexpected.status,
    browser.status,
  ]).toEqual([400, 413, 415, 400, 401]);
  expect(fetch).not.toHaveBeenCalled();
});

it("preserves a committed receipt when post-commit recovery cannot run immediately", async () => {
  const { admin, request } = fixture(
    admission("sessions:create"),
    Response.json(result),
    Response.json(true),
  );
  postCommit.wake.mockRejectedValueOnce(new Error("background service unavailable"));
  const response = await handleFactoryMutation("create", request(createBody), scope, admin);
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject(result);
});

it("leaves cleanup untouched if a canceled run receipt omits the exact requested run", async () => {
  const { admin, request, fetch } = fixture(
    admission("sessions:cancel"),
    Response.json({ ...result, jobIds: [jobId], runIds: [artifactId] }),
    Response.json(true),
  );
  const response = await handleFactoryMutation(
    "cancel",
    request({ expectedRunId: runId }),
    sessionScope,
    admin,
  );
  expect(response.status).toBe(503);
  expect(postCommit.cleanup).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(3);
});

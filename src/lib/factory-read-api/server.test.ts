import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import { issueFactoryMachineTokenSecret } from "@/lib/factory-machine-tokens/secret";
import type { Database } from "@/lib/supabase/database.types";

import { decodeFactoryReadCursor, encodeFactoryReadCursor } from "./cursor";
import { handleFactoryRead } from "./server";

const workspaceId = "52f04e24-3346-4e4d-ba9e-b17d8967ce91";
const factoryId = "268b8668-c478-45fd-b5e4-1b1c7bf4b59c";
const servicePrincipalId = "c4f45da6-0878-4081-8641-1bce59441347";
const grantId = "82dd5d76-ab3a-4d59-9ee2-c32c55b2e16c";
const admissionId = "05f63910-93f9-41e8-9b64-36b8bf7d79e5";
const leaseId = "ccb82d9d-5bcb-4069-a499-1e9e5df0dc92";
const sessionId = "adc689db-3a99-493a-8f2b-682307c79095";
const artifactId = "6c6ac2b8-3ae6-4457-bd95-e7cd26707a49";
const runId = "e20dd01a-6720-4d29-a496-a613cf4b2e15";
const stageId = "0f452959-9ee5-41c7-8b9a-142888a401eb";
const sourceId = "a57bfd37-6827-4c8b-9f01-996807d365d7";
const workspaceSlug = "work-fixture";
const createdAt = "2026-11-19T08:09:10.092731+00:00";
const scope = { workspaceId, factoryId };
const sessionScope = { ...scope, sessionId };
const canonicalUrl = "/w/work-fixture/sessions/12";
const admitted = {
  status: "admitted",
  admission_id: admissionId,
  lease_id: leaseId,
  lease_expires_at: createdAt,
  workspace_id: workspaceId,
  factory_id: factoryId,
  service_principal_id: servicePrincipalId,
  execution_grant_id: grantId,
  execution_grant_version: 7,
  consenting_member_id: null,
  scope: "sessions:read",
};
const artifact = {
  id: artifactId,
  sessionId,
  sessionNumber: 12,
  stageId,
  stageSlug: "specification",
  version: 4,
  createdAt,
  bodyMarkdown: "**Exact context**",
  provenance: {
    runId,
    attemptCount: 2,
    checkpointRunId: runId,
    commitSha: "f".repeat(40),
  },
};
const conversationCursorScope = { ...sessionScope, kind: "conversation" } as const;

function success(data: unknown) {
  return Response.json({ status: "ok", workspaceSlug, data });
}

function fixture(responses: Response[], authorization?: string | null) {
  const bearer = issueFactoryMachineTokenSecret();
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const admin = createClient<Database>("https://database.example.test", "fixture", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch },
  });
  const request = (query = "") =>
    new Request(`https://wallie.test/api/v1/resource${query}`, {
      headers:
        authorization === null
          ? {}
          : { Authorization: authorization ?? `Bearer ${bearer.credential}` },
    });
  const rpcBody = (call: number) => JSON.parse(String(fetch.mock.calls[call]?.[1]?.body));
  return { admin, bearer, fetch, request, rpcBody };
}

it("returns the exact artifact and review revision in the human Workbench link", async () => {
  const review = {
    stageId,
    stageSlug: artifact.stageSlug,
    artifactId,
    artifactVersion: artifact.version,
    reviewRevision: 7,
    runId,
    attemptCount: 2,
    checkpointRunId: runId,
    clarification: null,
  };
  const { admin, request } = fixture([
    Response.json(admitted),
    success({
      id: sessionId,
      number: 12,
      title: "Exact review",
      archivedAt: null,
      status: "awaiting_review",
      createdAt,
      updatedAt: createdAt,
      currentStageId: stageId,
      currentRunId: runId,
      specificationStageId: null,
      review,
    }),
    Response.json(true),
  ]);
  const response = await handleFactoryRead("session", request(), sessionScope, admin);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.review).toMatchObject(review);
  const link = new URL(body.review.href, "https://wallie.test");
  expect(link.pathname).toBe(canonicalUrl);
  expect(Object.fromEntries(link.searchParams)).toEqual({
    artifactStage: artifact.stageSlug,
    artifactId,
    artifactVersion: String(artifact.version),
    reviewStageId: stageId,
    reviewRevision: "7",
  });
});

it("authenticates and reads the exact artifact under one permit, then releases it", async () => {
  const { admin, bearer, fetch, request, rpcBody } = fixture([
    Response.json(admitted),
    success({ ...artifact, checkpointPath: "private-checkpoint-path" }),
    Response.json(true),
  ]);
  const params = { ...sessionScope, artifactId };
  const response = await handleFactoryRead("artifact", request(), params, admin);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({
    id: artifactId,
    sessionId,
    sessionNumber: 12,
    stageId,
    stageSlug: "specification",
    version: 4,
    createdAt,
    provenance: artifact.provenance,
    canonicalUrl,
    href: `${canonicalUrl}?artifactStage=specification&artifactId=${artifactId}&artifactVersion=4`,
    bodyHtml: expect.stringMatching(/<strong\b[^>]*>Exact context<\/strong>/),
  });
  expect(fetch.mock.calls.map(([url]) => String(url).split("/").at(-1))).toEqual([
    "admit_factory_command",
    "read_factory_session_command",
    "release_factory_command_admission",
  ]);
  const admission = rpcBody(0);
  expect(admission).toMatchObject({
    p_scope: "sessions:read",
    p_surface: "api",
    p_credential_id: bearer.tokenId,
    p_credential_digest: bearer.digest,
  });
  expect(rpcBody(1)).toEqual({
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_surface: "api",
    p_credential_id: bearer.tokenId,
    p_credential_digest: bearer.digest,
    p_credential_kind: "machine_token",
    p_request_id: admission.p_request_id,
    p_request_hash: admission.p_request_hash,
    p_admission_id: admissionId,
    p_lease_id: leaseId,
    p_operation: "artifact",
    p_session_id: sessionId,
    p_artifact_id: artifactId,
  });
  expect(rpcBody(2)).toEqual({ p_admission_id: admissionId, p_lease_id: leaseId });
});

it.each([
  [null, 401, "unauthorized"],
  [`Bearer browser.session.jwt`, 401, "unauthorized"],
])(
  "rejects a browser or missing credential before a database call",
  async (authorization, status, code) => {
    const { admin, fetch, request } = fixture([], authorization);
    const response = await handleFactoryRead("sessions", request(), scope, admin);
    expect(response.status).toBe(status);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await response.json()).toMatchObject({ code });
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each(["rate_limited", "concurrency_limited"] as const)(
  "returns %s with Retry-After and makes no protected read",
  async (code) => {
    const { admin, fetch, request } = fixture([
      Response.json({ status: code, retry_after_seconds: 12 }),
    ]);
    const response = await handleFactoryRead("sessions", request(), scope, admin);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("12");
    expect(await response.json()).toMatchObject({ code, retryAfterSeconds: 12 });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ["not_found", 404, "not_found"],
  ["unavailable", 410, "resource_unavailable"],
] as const)("releases the protected lease for a scoped %s resource", async (status, http, code) => {
  const { admin, fetch, request } = fixture([
    Response.json(admitted),
    Response.json({ status, data: { private: "internal-only" } }),
    Response.json(true),
  ]);
  const response = await handleFactoryRead(
    "artifact",
    request(),
    { ...sessionScope, artifactId },
    admin,
  );
  expect(response.status).toBe(http);
  const body = await response.json();
  expect(body).toMatchObject({ code });
  expect(JSON.stringify(body)).not.toContain("internal-only");
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("releases a lease when its authority is revoked between admission and protected read", async () => {
  const { admin, fetch, request } = fixture([
    Response.json(admitted),
    Response.json({ code: "42501", message: "private diagnostics" }, { status: 403 }),
    Response.json(true),
  ]);
  const response = await handleFactoryRead("sessions", request(), scope, admin);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    code: "unauthorized",
    error: "A valid factory credential is required.",
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("returns a stable conflict and releases an expired or already used lease", async () => {
  const { admin, fetch, request } = fixture([
    Response.json(admitted),
    Response.json({ code: "PT409", message: "private diagnostics" }, { status: 409 }),
    Response.json(false),
  ]);
  const response = await handleFactoryRead("sessions", request(), scope, admin);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    code: "request_conflict",
    error: "The request conflicts with an existing admission.",
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("rejects duplicated options and cursors from another factory or session before admission", async () => {
  const { admin, fetch, request } = fixture([]);
  const cursor = encodeFactoryReadCursor({
    ...sessionScope,
    kind: "runs",
    version: 1,
    key: { createdAt, id: runId },
  });
  const params = { ...scope, factoryId: grantId };
  const mismatchedFactory = await handleFactoryRead(
    "runs",
    request(`?cursor=${cursor}&sessionId=${sessionId}`),
    params,
    admin,
  );
  const mismatchedSession = await handleFactoryRead(
    "runs",
    request(`?cursor=${cursor}&sessionId=${runId}`),
    scope,
    admin,
  );
  for (const response of [mismatchedFactory, mismatchedSession]) {
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_cursor" });
  }
  const duplicate = await handleFactoryRead("runs", request("?limit=1&limit=2"), scope, admin);
  expect(duplicate.status).toBe(400);
  expect(await duplicate.json()).toMatchObject({ code: "invalid_request" });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  { ...scope, kind: "sessions", version: 1, key: { number: 2_147_483_648 } },
  { ...conversationCursorScope, version: 1, key: { sequence: 2_147_483_648 } },
  ...[
    "0000-01-01T00:00:00Z",
    "2026-02-29T08:09:10Z",
    "2026-11-19T08:09:10+16:00",
    "2026-11-19T08:09:10.0927311+00:00",
  ].map((timestamp) => ({
    ...scope,
    kind: "runs" as const,
    version: 1 as const,
    key: { createdAt: timestamp, id: runId },
  })),
] as const)("returns invalid_cursor before admission for $kind $key", async (cursor) => {
  const { admin, fetch, request } = fixture([]);
  const response = await handleFactoryRead(
    cursor.kind,
    request(`?cursor=${encodeFactoryReadCursor(cursor)}`),
    cursor.kind === "conversation" ? sessionScope : scope,
    admin,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "invalid_cursor" });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  createdAt,
  "2026-11-19T08:09:10.092731Z",
  "2024-02-29T08:09:10.092731+05:45",
  "2026-11-19T08:09:10.092731-03:30",
  "2026-11-19T08:09:10.092731+14:00",
])("round-trips exact run keyset timestamps at database precision for %s", async (timestamp) => {
  const { admin, request, rpcBody } = fixture([
    Response.json(admitted),
    success({ items: [], nextCursor: { createdAt: timestamp, id: runId } }),
    Response.json(true),
    Response.json(admitted),
    success({ items: [], nextCursor: null }),
    Response.json(true),
  ]);
  const response = await handleFactoryRead(
    "runs",
    request(`?sessionId=${sessionId}`),
    scope,
    admin,
  );
  const { nextCursor } = await response.json();
  const second = await handleFactoryRead(
    "runs",
    request(`?sessionId=${sessionId}&cursor=${nextCursor}&limit=2`),
    scope,
    admin,
  );
  expect(second.status).toBe(200);
  expect(rpcBody(4)).toMatchObject({
    p_session_id: sessionId,
    p_before_created_at: timestamp,
    p_before_id: runId,
    p_limit: 2,
  });
});

it("keeps a forward conversation resume cursor independent of older page traversal", async () => {
  const source = {
    id: sourceId,
    provider: "linear",
    label: "Linear",
    url: "https://linear.app/example/issue/OP-1?token=secret",
  };
  const message = {
    kind: "initial_prompt",
    authorKind: "user",
    authorLabel: "Operator",
    createdAt,
    bodyMarkdown: "**Start**",
    bodyTruncated: false,
    runId: null,
    attemptCount: null,
    artifactId: null,
    source,
  };
  const { admin, request, rpcBody } = fixture([
    Response.json(admitted),
    success({
      sessionNumber: 12,
      items: [
        { ...message, sequence: 4 },
        { ...message, sequence: 9 },
      ],
      sourceLinks: [source],
      nextCursor: { sequence: 4 },
    }),
    Response.json(true),
    Response.json(admitted),
    success({ sessionNumber: 12, items: [], sourceLinks: [], nextCursor: null }),
    Response.json(true),
  ]);
  const first = await handleFactoryRead("conversation", request(), sessionScope, admin);
  expect(first.status).toBe(200);
  const page = await first.json();
  expect(page.items[0].bodyHtml).toMatch(/<strong\b[^>]*>Start<\/strong>/);
  expect(page.sources[0].url).toBe("https://linear.app/example/issue/OP-1");
  expect(decodeFactoryReadCursor(page.nextCursor, conversationCursorScope)?.key).toEqual({
    sequence: 4,
  });
  expect(decodeFactoryReadCursor(page.resumeCursor, conversationCursorScope)?.key).toEqual({
    sequence: 9,
  });

  const after = await handleFactoryRead(
    "conversation",
    request(`?direction=after&cursor=${page.resumeCursor}`),
    sessionScope,
    admin,
  );
  expect(await after.json()).toEqual({
    canonicalUrl,
    items: [],
    sources: [],
    nextCursor: null,
    resumeCursor: page.resumeCursor,
  });
  expect(rpcBody(4)).toMatchObject({
    p_conversation_direction: "after",
    p_conversation_sequence: 9,
  });
});

it("returns and accepts a zero resume anchor for an empty conversation", async () => {
  const { admin, request, rpcBody } = fixture([
    Response.json(admitted),
    success({ sessionNumber: 12, items: [], sourceLinks: [], nextCursor: null }),
    Response.json(true),
    Response.json(admitted),
    success({ sessionNumber: 12, items: [], sourceLinks: [], nextCursor: null }),
    Response.json(true),
  ]);
  const first = await handleFactoryRead("conversation", request(), sessionScope, admin);
  const { resumeCursor } = await first.json();
  expect(decodeFactoryReadCursor(resumeCursor, conversationCursorScope)?.key).toEqual({
    sequence: 0,
  });
  const second = await handleFactoryRead(
    "conversation",
    request(`?direction=after&cursor=${resumeCursor}`),
    sessionScope,
    admin,
  );
  expect(second.status).toBe(200);
  expect(rpcBody(4)).toMatchObject({ p_conversation_sequence: 0 });
});

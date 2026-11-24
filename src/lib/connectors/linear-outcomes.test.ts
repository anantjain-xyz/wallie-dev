import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLinearOutboundAdapter } from "@/lib/connectors/linear-outcomes";
import type { ConnectorOutboundTarget } from "@/lib/connectors/outbound";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

function id(slot: number) {
  return `67300000-0000-4000-8000-${slot.toString().padStart(12, "0")}`;
}

const key = "synthetic-linear-outcomes-api-key";
const startedAt = "2026-11-24T03:00:00.000Z";
const nextStartedAt = "2026-11-24T03:15:00.000Z";
const target = {
  correlationId: id(1),
  leaseId: id(2),
  externalResourceId: id(3),
  externalThreadId: id(4),
  installationId: id(5),
  installationGeneration: 7,
  mappingRevision: 8,
  credentialRef: id(6),
  credentialMaterialRevision: 9,
  message: {
    operation: "reply",
    content: {
      kind: "review_ready",
      workspaceSlug: "linked-fixture",
      sessionId: id(7),
      sessionNumber: 12,
      body: "The build is ready for review.",
      reviewTarget: {
        stageId: id(8),
        stageSlug: "build",
        artifactId: id(9),
        artifactVersion: 3,
        reviewRevision: 4,
      },
    },
  },
} satisfies ConnectorOutboundTarget;
const statusTarget = {
  ...target,
  message: { operation: "linear_status", content: { kind: "linear_status" } },
} satisfies ConnectorOutboundTarget;
const originalSpan = { id: id(10), stateId: id(11), startedAt, endedAt: null };
const origin = {
  issue_id: target.externalThreadId,
  external_tenant_id: id(12),
  resource_kind: "project",
  resource_external_id: target.externalResourceId,
  origin_state_id: originalSpan.stateId,
  origin_team_id: id(13),
  origin_project_id: target.externalResourceId,
  origin_span_id: originalSpan.id,
  origin_span_started_at: startedAt,
  credential_material_revision: target.credentialMaterialRevision,
  may_send: true,
  from_state_id: originalSpan.stateId,
  to_state_id: id(14),
};
const issue = {
  id: target.externalThreadId,
  team: { id: origin.origin_team_id },
  project: { id: target.externalResourceId },
  archivedAt: null,
  trashed: null,
  updatedAt: nextStartedAt,
  state: { id: originalSpan.stateId },
  stateHistory: { nodes: [originalSpan] },
};
const scope = {
  organization: { id: origin.external_tenant_id },
  issue,
  workflowState: { id: origin.to_state_id, team: issue.team, archivedAt: null },
};
const inactiveIssues = [
  ["archived", { ...issue, archivedAt: nextStartedAt }],
  ["trashed", { ...issue, trashed: true }],
] as const;

function graph(data: unknown) {
  return Response.json({ data });
}

function fixture() {
  let current = { ...origin, encrypted_api_key: encryptSecretValue(key) };
  const database = vi.fn<typeof fetch>().mockImplementation(async () => Response.json([current]));
  const provider = vi.fn<typeof fetch>();
  const admin = createClient<Database>("https://database.example.test", "fixture-service", {
    global: { fetch: database },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    adapter: createLinearOutboundAdapter(admin, provider),
    database,
    provider,
    updateDelivery: (changes: Partial<typeof current>) => {
      current = { ...current, ...changes };
    },
  };
}

describe("Linear linked outcomes", () => {
  beforeEach(() => {
    vi.stubEnv("WALLIE_ENCRYPTION_KEY", "synthetic-linear-outcomes-encryption");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://wallie.example.test");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("posts one exact review comment under the immutable outbox UUID", async () => {
    const { adapter, provider, database } = fixture();
    provider.mockResolvedValueOnce(graph(scope)).mockImplementationOnce(async (...args) => {
      const request = new Request(...args);
      const { query, variables } = await request.json();
      expect(query).toContain("mutation WallieLinearCreateComment");
      expect(request.url).toBe("https://api.linear.app/graphql");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("authorization")).toBe(key);
      expect(variables.input).toMatchObject({
        id: target.correlationId,
        issueId: target.externalThreadId,
        doNotSubscribeToIssue: true,
      });
      const reviewLink = new URL(variables.input.body.match(/\[Review in Wallie\]\(([^)]+)\)/)[1]);
      expect(reviewLink.pathname).toBe("/w/linked-fixture/sessions/12");
      expect(Object.fromEntries(reviewLink.searchParams)).toEqual({
        artifactStage: "build",
        artifactId: id(9),
        artifactVersion: "3",
        reviewStageId: id(8),
        reviewRevision: "4",
      });
      return graph({
        commentCreate: {
          success: true,
          comment: {
            id: target.correlationId,
            issue: { id: issue.id },
            body: variables.input.body,
          },
        },
      });
    });

    await expect(adapter.send(target, AbortSignal.timeout(5_000))).resolves.toEqual({
      kind: "sent",
      providerReplyId: target.correlationId,
    });
    expect(database).toHaveBeenCalledTimes(2);
    expect(await new Request(...database.mock.calls[1]!).json()).toEqual({
      p_delivery_id: target.correlationId,
      p_lease_id: target.leaseId,
      p_credential_ref: target.credentialRef,
      p_credential_material_revision: target.credentialMaterialRevision,
    });
  });

  it.each([["active", issue] as const, ...inactiveIssues])(
    "observes the exact written comment after losing the mutation response on a readable %s issue",
    async (_, observedIssue) => {
      const { adapter, provider, updateDelivery } = fixture();
      let body = "";
      provider.mockResolvedValueOnce(graph(scope)).mockImplementationOnce(async (...args) => {
        body = (await new Request(...args).json()).variables.input.body;
        throw new Error("Provider wrote the comment but the connection closed");
      });
      await expect(adapter.send(target, AbortSignal.timeout(5_000))).resolves.toEqual({
        kind: "uncertain",
      });

      updateDelivery({ may_send: false });
      provider
        .mockResolvedValueOnce(graph({ ...scope, issue: observedIssue }))
        .mockResolvedValueOnce(
          graph({ comment: { id: target.correlationId, issue: { id: issue.id }, body } }),
        );
      await expect(adapter.observe(target, AbortSignal.timeout(5_000))).resolves.toEqual({
        kind: "found",
        providerReplyId: target.correlationId,
      });
      const lookup = new Request(...provider.mock.calls[3]!);
      expect(await lookup.json()).toMatchObject({
        query: expect.stringContaining("query WallieLinearReadComment"),
        variables: { id: target.correlationId },
      });
      expect(provider).toHaveBeenCalledTimes(4);
    },
  );

  it.each(inactiveIssues)(
    "withholds comments and status writes for a %s issue",
    async (_, inactive) => {
      const { adapter, provider } = fixture();
      provider
        .mockResolvedValueOnce(graph({ ...scope, issue: inactive }))
        .mockResolvedValueOnce(graph({ ...scope, issue: inactive }));
      const signal = AbortSignal.timeout(5_000);
      await expect(adapter.send(target, signal)).resolves.toEqual({ kind: "not_sent" });
      await expect(adapter.send(statusTarget, signal)).resolves.toEqual({ kind: "not_sent" });
      expect(provider).toHaveBeenCalledTimes(2);
    },
  );

  it("does not mutate after the lease becomes stale during eligibility preflight", async () => {
    const { adapter, provider, updateDelivery } = fixture();
    provider.mockImplementationOnce(async () => {
      updateDelivery({ may_send: false });
      return graph(scope);
    });
    await expect(adapter.send(target, AbortSignal.timeout(5_000))).resolves.toEqual({
      kind: "rejected",
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("treats a connection failure during the pre-write fence as a known non-write", async () => {
    const { adapter, provider, database } = fixture();
    provider.mockImplementationOnce(async () => {
      database.mockRejectedValueOnce(new Error("Database not reachable"));
      return graph(scope);
    });
    await expect(adapter.send(target, AbortSignal.timeout(5_000))).resolves.toEqual({
      kind: "not_sent",
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("does not post outside the exact mapped project", async () => {
    const { adapter, provider } = fixture();
    provider.mockResolvedValueOnce(
      graph({ ...scope, issue: { ...issue, project: { id: id(15) } } }),
    );
    await expect(adapter.send(target, AbortSignal.timeout(5_000))).resolves.toEqual({
      kind: "rejected",
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("keeps a known Linear permission denial retryable", async () => {
    const { adapter, provider } = fixture();
    provider
      .mockResolvedValueOnce(graph(scope))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(adapter.send(target, AbortSignal.timeout(5_000))).resolves.toEqual({
      kind: "not_sent",
    });
  });

  it("leaves a missing observation inconclusive without posting again", async () => {
    const { adapter, provider } = fixture();
    provider.mockResolvedValueOnce(graph(scope)).mockResolvedValueOnce(graph({ comment: null }));
    await expect(adapter.observe(target, AbortSignal.timeout(5_000))).resolves.toEqual({
      kind: "inconclusive",
    });
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("reuses the verified origin and exact same-team destination for a status write", async () => {
    const { adapter, provider } = fixture();
    provider.mockResolvedValueOnce(graph(scope)).mockResolvedValueOnce(
      graph({
        issueUpdate: {
          success: true,
          issue: { id: issue.id, state: { id: origin.to_state_id } },
        },
      }),
    );
    await expect(adapter.send(statusTarget, AbortSignal.timeout(5_000))).resolves.toEqual({
      kind: "sent",
      providerReplyId: issue.id,
    });
    expect(await new Request(...provider.mock.calls[1]!).json()).toMatchObject({
      query: expect.stringContaining("mutation WallieLinearUpdateStatus"),
      variables: { id: issue.id, stateId: origin.to_state_id },
    });
  });

  it("does not overwrite a newer span that has the same visible status", async () => {
    const { adapter, provider } = fixture();
    provider.mockResolvedValueOnce(
      graph({
        ...scope,
        issue: {
          ...issue,
          stateHistory: { nodes: [{ ...originalSpan, id: id(16), startedAt: nextStartedAt }] },
        },
      }),
    );
    await expect(adapter.send(statusTarget, AbortSignal.timeout(5_000))).resolves.toEqual({
      kind: "rejected",
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("recognizes an uncertain status write only when the exact originating span precedes the target", async () => {
    const { adapter, provider, updateDelivery } = fixture();
    provider
      .mockResolvedValueOnce(graph(scope))
      .mockRejectedValueOnce(new Error("Lost successful status update"));
    await expect(adapter.send(statusTarget, AbortSignal.timeout(5_000))).resolves.toEqual({
      kind: "uncertain",
    });
    updateDelivery({ may_send: false });

    const predecessor = { ...originalSpan, endedAt: nextStartedAt };
    const current = {
      id: id(17),
      stateId: origin.to_state_id,
      startedAt: nextStartedAt,
      endedAt: null,
    };
    const updated = { ...issue, archivedAt: nextStartedAt, state: { id: origin.to_state_id } };
    provider
      .mockResolvedValueOnce(
        graph({
          ...scope,
          issue: { ...updated, stateHistory: { nodes: [{ ...predecessor, id: id(18) }, current] } },
        }),
      )
      .mockResolvedValueOnce(
        graph({ ...scope, issue: { ...updated, stateHistory: { nodes: [predecessor, current] } } }),
      );
    const signal = AbortSignal.timeout(5_000);
    await expect(adapter.observe(statusTarget, signal)).resolves.toEqual({ kind: "inconclusive" });
    await expect(adapter.observe(statusTarget, signal)).resolves.toEqual({
      kind: "found",
      providerReplyId: issue.id,
    });
    expect(provider).toHaveBeenCalledTimes(4);
  });
});

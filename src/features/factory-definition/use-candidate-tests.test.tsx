// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { CandidateSmokeTest } from "@/lib/factory-definitions/candidate-smoke-contracts";

import { useCandidateTests } from "./use-candidate-tests";

const api = "/api/workspaces/10000000-0000-4000-8000-000000000001/factory-definition";
const collection = `${api}/candidate-tests`;
const activationNumber = 2;
type Candidate = NonNullable<Parameters<typeof useCandidateTests>[0]["target"]>;
const revision: Candidate = {
  kind: "revision",
  id: "10000000-0000-4000-8000-000000000002",
  digest: "a".repeat(64),
};
const otherRevision: Candidate = {
  ...revision,
  id: "10000000-0000-4000-8000-000000000003",
  digest: "b".repeat(64),
};
const draft: Candidate = { ...revision, kind: "draft" };

function runningReceipt(target: Candidate): CandidateSmokeTest {
  return {
    id: "10000000-0000-4000-8000-000000000004",
    target: { kind: target.kind, id: target.id },
    definitionDigest: target.digest,
    baseActivationNumber: activationNumber,
    policyVersion: 1,
    status: "running",
    createdAt: "2026-11-16T16:00:00Z",
    finishedAt: null,
    evidence: null,
    error: null,
  };
}

function history(tests: CandidateSmokeTest[], canTest = true) {
  return Response.json({
    tests,
    eligibility: { eligible: false, reason: null, activationNumber, canTest },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reconciles a revision on return after aborting its earlier request", async () => {
  const earlierPost = Promise.withResolvers<Response>();
  const currentPost = Promise.withResolvers<Response>();
  const receipt = runningReceipt(revision);
  const earlierReceipt = { ...receipt, id: "10000000-0000-4000-8000-000000000005" };
  const finishedEarlier = {
    ...earlierReceipt,
    status: "failed",
    finishedAt: "2026-11-16T16:01:00Z",
  } as const;
  const posts: RequestInit[] = [];
  let latestTests: CandidateSmokeTest[] = [];
  vi.stubGlobal("fetch", (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      posts.push(options);
      return posts.length === 1 ? earlierPost.promise : currentPost.promise;
    }
    const query = new URL(url, "http://localhost").searchParams;
    return Promise.resolve(history(query.get("targetId") === revision.id ? latestTests : []));
  });
  const { rerender, result } = renderHook(
    ({ target }: { target: Candidate }) =>
      useCandidateTests({ api, target, activationNumber, active: true }),
    { initialProps: { target: revision } },
  );
  await waitFor(() => expect(result.current.canTest).toBe(true));
  act(() => result.current.panel.onStart());
  expect(result.current.panel.pending).toBe("start");

  rerender({ target: otherRevision });
  await waitFor(() => expect(result.current.canTest).toBe(true));
  expect(posts[0].signal?.aborted).toBe(true);
  latestTests = [finishedEarlier];
  rerender({ target: revision });
  await waitFor(() => expect(result.current.panel.tests).toEqual([finishedEarlier]));
  expect(result.current.panel.pending).toBeNull();
  expect(result.current.canTest).toBe(true);

  act(() => result.current.panel.onStart());
  expect(result.current.panel.pending).toBe("start");
  expect(posts).toHaveLength(2);
  await act(async () =>
    earlierPost.resolve(Response.json({ test: earlierReceipt }, { status: 202 })),
  );
  expect(result.current.panel.pending).toBe("start");
  expect(posts[1].signal?.aborted).toBe(false);

  latestTests = [receipt, finishedEarlier];
  await act(async () => currentPost.resolve(Response.json({ test: receipt }, { status: 202 })));
  await waitFor(() => expect(result.current.panel.tests).toEqual([receipt, finishedEarlier]));
  expect(result.current.panel.pending).toBeNull();
});

it("cancels an exact running receipt after the draft is superseded and keeps starts disabled", async () => {
  const running = runningReceipt(draft);
  const canceled = { ...running, status: "canceled", finishedAt: running.createdAt } as const;
  const writes: Array<{ url: string; method: string }> = [];
  let latest = running;
  let canTest = true;
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    if (options?.method) writes.push({ url, method: options.method });
    if (options?.method === "DELETE") {
      latest = canceled;
      return Response.json({ test: canceled });
    }
    return history([latest], canTest);
  });
  const { result } = renderHook(() =>
    useCandidateTests({ api, target: draft, activationNumber, active: true }),
  );
  await waitFor(() => expect(result.current.canTest).toBe(true));
  canTest = false;
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.panel.eligibility?.canTest).toBe(false));
  act(() => result.current.panel.onCancel(running.id));
  expect(writes).toEqual([
    { method: "DELETE", url: `${collection}/${running.id}?digest=${draft.digest}` },
  ]);
  await waitFor(() => expect(result.current.panel.tests).toEqual([canceled]));
  act(() => result.current.panel.onStart());
  expect(writes).toHaveLength(1);
});

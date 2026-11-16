"use client";

import { useEffect, useRef, useState } from "react";
import type { z } from "zod";

import {
  candidateSmokeHistoryResponseSchema,
  candidateSmokeTestResponseSchema,
  type CandidateSmokeTest,
} from "@/lib/factory-definitions/candidate-smoke-contracts";
import type { FactoryEditorDocument } from "@/lib/factory-definitions/editor-contracts";

import { factoryEditorPost, fetchFactoryEditor } from "./editor-requests";

type History = z.infer<typeof candidateSmokeHistoryResponseSchema>;
type Candidate = Pick<FactoryEditorDocument, "id" | "kind" | "digest">;
type Action = { kind: "start" } | { kind: "cancel"; testId: string };

function pageIsVisible() {
  return document.visibilityState !== "hidden";
}

function requestError(error: unknown, fallback: string) {
  return error instanceof Error && error.name !== "ZodError" ? error.message : fallback;
}

export function useCandidateTests({
  api,
  target,
  activationNumber,
  initialTestId,
  active,
}: {
  api: string;
  target: Candidate | null;
  activationNumber: number;
  initialTestId?: string;
  active: boolean;
}) {
  const query = target
    ? new URLSearchParams({ targetKind: target.kind, targetId: target.id, digest: target.digest })
    : null;
  const endpoint = `${api}/candidate-tests`;
  const listUrl = query ? `${endpoint}?${query}` : null;
  const scope = listUrl ? `${listUrl}&base=${activationNumber}` : null;
  const [history, setHistory] = useState<{
    scope: string;
    value: History | null;
    error: string | null;
    version: number;
  } | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const [action, setAction] = useState<{
    scope: string;
    pending: Action["kind"] | null;
    error: string | null;
  } | null>(null);
  const mutation = useRef<{ scope: string; controller: AbortController } | null>(null);
  const [selection, setSelection] = useState<{ scope: string; id: string | null } | null>(null);
  const [evidenceVersion, setEvidenceVersion] = useState(0);
  const selectedTestId =
    selection?.scope === scope ? (selection?.id ?? null) : (initialTestId ?? null);
  const detailUrl = query && selectedTestId ? `${endpoint}/${selectedTestId}?${query}` : null;
  const [detail, setDetail] = useState<{
    url: string;
    test: CandidateSmokeTest | null;
    error: string | null;
  } | null>(null);
  const current = history?.scope === scope ? history : null;
  const currentAction = action?.scope === scope ? action : null;
  const tests = current?.value?.tests ?? [];
  const pending = currentAction?.pending ?? null;
  const selectedTestSummary = tests.find(({ id }) => id === selectedTestId);
  const selectedStatus = selectedTestSummary?.status;

  useEffect(() => {
    if (!listUrl || !scope || pending) return;
    const url = listUrl;
    const key = scope;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;

    async function reconcile() {
      clearTimeout(timer);
      if (signal.aborted || reading || !pageIsVisible()) return;
      reading = true;
      let wait = 20_000;
      try {
        const value = await fetchFactoryEditor(url, candidateSmokeHistoryResponseSchema, {
          signal,
        });
        if (signal.aborted) return;
        setHistory({ scope: key, value, error: null, version: refreshCount });
        if (
          value.tests.some(
            ({ status, baseActivationNumber }) =>
              status === "running" && baseActivationNumber === activationNumber,
          )
        ) {
          wait = 2_000;
        }
      } catch (error) {
        if (signal.aborted) return;
        setHistory((previous) => ({
          scope: key,
          value: previous?.scope === key ? previous.value : null,
          version: refreshCount,
          error: requestError(error, "Could not load configuration tests."),
        }));
      } finally {
        reading = false;
        if (active && !signal.aborted && pageIsVisible()) {
          timer = setTimeout(() => void reconcile(), wait);
        }
      }
    }

    void reconcile();
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
    };
  }, [activationNumber, active, listUrl, pending, refreshCount, scope]);

  useEffect(() => {
    if (!detailUrl) return;
    const controller = new AbortController();
    const { signal } = controller;
    void fetchFactoryEditor(detailUrl, candidateSmokeTestResponseSchema, { signal }).then(
      ({ test }) => {
        if (!signal.aborted) setDetail({ url: detailUrl, test, error: null });
      },
      (error: unknown) => {
        if (!signal.aborted) {
          setDetail({
            url: detailUrl,
            test: null,
            error: requestError(error, "Could not load this test receipt."),
          });
        }
      },
    );
    return () => controller.abort();
  }, [detailUrl, evidenceVersion, refreshCount, selectedStatus]);

  useEffect(
    () => () => {
      const current = mutation.current;
      if (current && current.scope === scope) {
        current.controller.abort();
        mutation.current = null;
      }
    },
    [scope],
  );

  function refresh() {
    setRefreshCount((value) => value + 1);
  }

  async function mutate(command: Action) {
    if (!scope || !target || !active || !canTest || mutation.current) return;
    const running = tests.find(
      ({ status, baseActivationNumber }) =>
        status === "running" && baseActivationNumber === activationNumber,
    );
    if (command.kind === "start" ? running : running?.id !== command.testId) return;
    const controller = new AbortController();
    const { signal } = controller;
    mutation.current = { scope, controller };
    setAction({ scope, pending: command.kind, error: null });
    try {
      if (command.kind === "start") {
        await fetchFactoryEditor(endpoint, candidateSmokeTestResponseSchema, {
          ...factoryEditorPost({
            target: { kind: target.kind, id: target.id },
            expectedActivationNumber: activationNumber,
            expectedDigest: target.digest,
          }),
          signal,
        });
      } else {
        await fetchFactoryEditor(
          `${endpoint}/${command.testId}?${new URLSearchParams({ digest: target.digest })}`,
          candidateSmokeTestResponseSchema,
          { method: "DELETE", signal },
        );
      }
      if (!signal.aborted) setAction({ scope, pending: null, error: null });
    } catch (error) {
      if (!signal.aborted) {
        setAction({
          scope,
          pending: null,
          error: requestError(error, "Could not update the test."),
        });
      }
    } finally {
      if (!signal.aborted) {
        mutation.current = null;
        refresh();
      }
    }
  }

  const eligibility =
    !pending && current?.version === refreshCount && !current.error
      ? (current.value?.eligibility ?? null)
      : null;
  const canTest =
    eligibility?.activationNumber === activationNumber && eligibility.canTest !== false;
  const latest = tests.find(
    ({ baseActivationNumber }) => baseActivationNumber === activationNumber,
  );
  const eligible =
    eligibility?.eligible === true &&
    eligibility.activationNumber === activationNumber &&
    latest?.status === "passed" &&
    (!eligibility.testId || eligibility.testId === latest.id);
  const selectedDetail = detail?.url === detailUrl ? detail : null;

  return {
    eligible,
    canTest,
    refresh,
    panel: {
      tests,
      eligibility: eligibility ? { ...eligibility, eligible } : null,
      loading: Boolean(listUrl && !current),
      error: current?.error ?? null,
      actionError: currentAction?.error ?? null,
      pending,
      onStart: () => void mutate({ kind: "start" }),
      onCancel: (testId: string) => void mutate({ kind: "cancel", testId }),
      onRefresh: refresh,
      selectedTestId,
      selectedTest: selectedDetail?.test ?? null,
      evidenceLoading: Boolean(detailUrl && !selectedDetail),
      evidenceError: selectedDetail?.error ?? null,
      onSelectTest: (id: string | null) => {
        if (!scope) return;
        if (id && id === selectedTestId) {
          setDetail(null);
          setEvidenceVersion((value) => value + 1);
        }
        setSelection({ scope, id });
      },
    },
  };
}

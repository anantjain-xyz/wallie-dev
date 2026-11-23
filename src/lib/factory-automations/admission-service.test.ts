import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import {
  drainFactoryAutomationOccurrences,
  recordFactoryAutomationOccurrence,
} from "./admission-service";

function id(value: number) {
  return `66000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const now = "2026-11-23T17:30:00.000123+00:00";
const commonReceipt = {
  occurrenceId: id(1),
  workspaceId: id(2),
  factoryId: id(3),
  automationId: id(4),
  revisionId: id(5),
  status: "pending",
  reason: null,
  sessionId: null,
  mutationReceiptId: null,
  attemptCount: 0,
  nextAttemptAt: now,
  recordedAt: now,
  settledAt: null,
  replayed: false,
};
const admitted = {
  ...commonReceipt,
  status: "admitted",
  sessionId: id(6),
  mutationReceiptId: id(7),
  nextAttemptAt: null,
  settledAt: now,
  attemptCount: 1,
};
const recordInput = {
  workspaceId: commonReceipt.workspaceId,
  factoryId: commonReceipt.factoryId,
  automationId: commonReceipt.automationId,
  expectedRevisionId: commonReceipt.revisionId,
  sourceNamespace: "github.pull-request",
  sourceKey: "repo/17/pr/5/head/698b5ba",
  event: { kind: "pull-request", repositoryId: id(8), action: "merged", baseBranch: "main" },
  causalSessionId: id(9),
} as const;

function fixture(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => responses.shift() ?? Response.json(null),
  );
  const admin = createClient<Database>("https://automation-fixture.invalid", "service-key", {
    auth: { persistSession: false },
    global: { fetch },
  });
  return { admin, fetch };
}

it("records normalized events with their source identity and returns the durable replay receipt", async () => {
  const existing = { ...admitted, replayed: true };
  const { admin, fetch } = fixture(Response.json(existing));
  await expect(recordFactoryAutomationOccurrence(admin, recordInput)).resolves.toEqual(existing);
  const [url, request] = fetch.mock.calls[0];
  expect(String(url)).toMatch(/\/record_factory_automation_occurrence$/);
  expect(JSON.parse(String(request?.body))).toEqual({
    p_workspace_id: recordInput.workspaceId,
    p_factory_id: recordInput.factoryId,
    p_automation_id: recordInput.automationId,
    p_expected_revision_id: recordInput.expectedRevisionId,
    p_source_namespace: recordInput.sourceNamespace,
    p_source_key: recordInput.sourceKey,
    p_event: recordInput.event,
    p_causal_session_id: recordInput.causalSessionId,
  });
});

it("rejects an invalid source identity before sending a privileged record request", async () => {
  const { admin, fetch } = fixture();
  await expect(
    recordFactoryAutomationOccurrence(admin, { ...recordInput, sourceKey: "\n" }),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("continues after a deferred occurrence and stops when no occurrence is due", async () => {
  const deferred = { ...commonReceipt, reason: "capacity", attemptCount: 1 };
  const { admin, fetch } = fixture(
    Response.json(deferred),
    Response.json(admitted),
    Response.json(null),
  );
  await drainFactoryAutomationOccurrences(admin);
  expect(fetch).toHaveBeenCalledTimes(3);
  const deadline = fetch.mock.calls[0][1]?.signal;
  expect(deadline).toBeInstanceOf(AbortSignal);
  for (const [url, request] of fetch.mock.calls) {
    expect(String(url)).toMatch(/\/admit_next_factory_automation_occurrence$/);
    expect(request?.signal).toBe(deadline);
  }
});

it("processes at most four occurrences per maintenance cycle", async () => {
  const { admin, fetch } = fixture(...Array.from({ length: 5 }, () => Response.json(admitted)));
  await drainFactoryAutomationOccurrences(admin);
  expect(fetch).toHaveBeenCalledTimes(4);
});

it("reports an unavailable admission RPC and leaves the next cycle free to retry", async () => {
  const { admin, fetch } = fixture(
    Response.json({ code: "XX000", message: "Database temporarily unavailable" }, { status: 500 }),
    Response.json(admitted),
    Response.json(null),
  );
  await expect(drainFactoryAutomationOccurrences(admin)).rejects.toThrow(
    "Could not admit factory automation occurrences.",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(drainFactoryAutomationOccurrences(admin)).resolves.toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(3);
});

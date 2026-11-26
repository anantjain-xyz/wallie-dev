import { afterEach, expect, it, vi } from "vitest";

import {
  createSessionSearchContinuation,
  readSessionSearchContinuation,
} from "./session-search-continuation";

afterEach(() => vi.useRealTimers());

it("binds free text to one browser continuation without including it in the path", () => {
  const base = "/w/acme/sessions?scope=archived&status=failed";
  const attempt = createSessionSearchContinuation(base, "private phrase")!;
  const anotherAttempt = createSessionSearchContinuation(base, "another phrase")!;
  expect(attempt.next).toMatch(/^\/w\/acme\/sessions\?scope=archived&status=failed&resumeSearch=/);
  expect(attempt.next).not.toContain("private");
  expect(readSessionSearchContinuation(attempt.next, attempt.cookie)).toBe("private phrase");
  expect(readSessionSearchContinuation(attempt.next, undefined)).toBeNull();
  expect(readSessionSearchContinuation(attempt.next, anotherAttempt.cookie)).toBeNull();
  expect(
    readSessionSearchContinuation(attempt.next.replace("acme", "other"), attempt.cookie),
  ).toBeNull();
  expect(
    readSessionSearchContinuation(attempt.next.replace("archived", "all"), attempt.cookie),
  ).toBeNull();
  expect(
    readSessionSearchContinuation(attempt.next.replace("failed", "approved"), attempt.cookie),
  ).toBeNull();
});

it("discards expired and oversized cookie state after applying actual serialization", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const next = "/w/acme/sessions";
  const attempt = createSessionSearchContinuation(next, "sample")!;
  vi.setSystemTime(10 * 60 * 1_000);
  expect(readSessionSearchContinuation(attempt.next, attempt.cookie)).toBeNull();
  expect(createSessionSearchContinuation(next, "🌎".repeat(400))).toBeNull();
});

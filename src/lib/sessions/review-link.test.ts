import { expect, it } from "vitest";
import { parseSessionBrowseReturn } from "./browse-return";

import {
  exactSessionReviewHref,
  parseSessionReviewTarget,
  sessionReviewReturnPath,
} from "./review-link";

const target = {
  stageId: "57200000-0000-4000-8000-000000000001",
  stageSlug: "specification",
  artifactId: "57200000-0000-4000-8000-000000000002",
  artifactVersion: 4,
  reviewRevision: 9,
  clarificationId: "57200000-0000-4000-8000-000000000003",
};
const href = exactSessionReviewHref("acme", 12, target);

it("round-trips a fully identified review and its clarification through sign-in", () => {
  const url = new URL(href, "https://wallie.test");
  expect(parseSessionReviewTarget(Object.fromEntries(url.searchParams))).toEqual({
    kind: "exact",
    target,
  });
  url.searchParams.set("foreign", "ignored");
  expect(sessionReviewReturnPath(url, "acme")).toBe(href);
  expect(sessionReviewReturnPath(url, "neighbor")).toBeUndefined();
});

it("keeps ordinary artifact browsing available", () => {
  expect(
    parseSessionReviewTarget({ artifactStage: "specification", artifactId: target.artifactId }),
  ).toEqual({ kind: "ordinary" });
});

it("forwards only canonical browse context through session sign-in", () => {
  const inbox = "/w/acme/inbox?factory=factory-id&kind=review&cursor=opaque";
  const ledger = "/w/acme/sessions?scope=archived&q=API+schema&stage=plan";
  const exact = new URL(href, "https://wallie.test");
  exact.searchParams.set("returnTo", inbox);
  expect(sessionReviewReturnPath(exact, "acme")).toBe(
    `${href}&returnTo=${encodeURIComponent(inbox)}`,
  );
  exact.searchParams.append("returnTo", ledger);
  expect(sessionReviewReturnPath(exact, "acme")).toBe(href);
  const ordinary = new URL("/w/acme/sessions/12", "https://wallie.test");
  ordinary.searchParams.set("returnTo", ledger);
  expect(sessionReviewReturnPath(ordinary)).toBe(
    `/w/acme/sessions/12?returnTo=${encodeURIComponent(ledger)}`,
  );
  expect(parseSessionBrowseReturn("acme", inbox)).toEqual({ href: inbox, label: "Inbox" });
  expect(parseSessionBrowseReturn("acme", ledger)).toEqual({ href: ledger, label: "Sessions" });
});

it.each([
  ["/w/acme/inbox"],
  "https://wallie.test/w/acme/inbox",
  "//wallie.test/w/acme/inbox",
  "/w/neighbor/inbox",
  "/w/acme/inbox#review",
  "/w/acme/sessions/12",
  "/w/acme/../acme/inbox",
  "/w/acme/inbox/",
])("ignores an unsupported return value %j", (input: unknown) => {
  expect(parseSessionBrowseReturn("acme", input)).toBeNull();
});

it("fails closed on ambiguous targets and unsupported exact revisions", () => {
  const url = new URL(href, "https://wallie.test");
  const query = Object.fromEntries(url.searchParams);
  for (const changed of [
    { artifactId: [target.artifactId, target.artifactId] },
    { reviewRevision: "9007199254740992" },
    { artifactVersion: "2147483648" },
    { artifactVersion: "1e3" },
    { reviewStageId: "not-a-stage" },
    { artifactStage: undefined },
  ]) {
    expect(parseSessionReviewTarget({ ...query, ...changed })).toEqual({ kind: "invalid" });
  }
  url.searchParams.append("reviewRevision", String(target.reviewRevision));
  expect(sessionReviewReturnPath(url)).toBeUndefined();
});

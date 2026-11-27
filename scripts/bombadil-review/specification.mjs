import { always, eventually, now } from "@antithesishq/bombadil";
import { actions, extract, registerCustomAction, weighted } from "@antithesishq/bombadil/browser";

import { matchesDecision } from "./expectation.mjs";
import fixture from "./scenario.json" with { type: "json" };

/** @typedef {import("./expectation.mjs").Persisted} Persisted */

const reject = fixture.decision === "reject";
const dialog = '[role="dialog"]';
const approve = '#session-review-decision button[aria-label="Approve Plan"]';
const heading = "#session-review-handoff-heading";
const input = `${dialog} textarea`;
const listLink = `nav[aria-label="Breadcrumb"] a[href="${fixture.listPath}"]`;
const sessionLink = `a[href="${fixture.sessionPath}"]`;

/** @param {Document} document @param {string} selector @param {string} [text] */
function control(document, selector, text) {
  for (const element of document.querySelectorAll(selector)) {
    if (
      element instanceof HTMLElement &&
      (!text || element.innerText.trim() === text) &&
      !element.matches(":disabled") &&
      !element.closest("[inert]") &&
      element.getClientRects().length > 0
    )
      return element;
  }
}

/** @param {string} name @param {string} selector @param {string} [text] */
function click(name, selector, text) {
  return registerCustomAction(name, async (document) => {
    control(document, selector, text)?.click();
  });
}

const approvePlan = click("approvePlanV1", approve);
const requestChanges = click(
  "openRequestChanges",
  "#session-review-decision button",
  "Request changes",
);
const submitFeedback = click("queueRerun", `${dialog} button`, "Queue rerun");
const reopenSession = click("reopenSession", sessionLink);
const leaveSession = registerCustomAction("openSessionList", async (document, window) => {
  const link = control(document, listLink);
  if (link) {
    window.sessionStorage.setItem("fixture-listed", "yes");
    link.click();
  }
});
const fillFeedback = registerCustomAction("typeFixedFeedback", async (document) => {
  const field = control(document, input);
  if (!(field instanceof HTMLTextAreaElement)) return;
  field.focus();
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setValue?.call(field, fixture.feedback);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
const reloadBeforeDecision = registerCustomAction(
  "reloadBeforeDecision",
  async (_document, window) => {
    window.sessionStorage.setItem("fixture-reloaded-early", "yes");
    window.location.reload();
  },
);
const reloadAfterDecision = registerCustomAction(
  "reloadAfterDecision",
  async (_document, window) => {
    window.sessionStorage.setItem("fixture-reloaded-after", String(window.performance.timeOrigin));
    window.location.reload();
  },
);

const review = extract(({ document, errors, navigationHistory, window }) => {
  const onOrigin = window.location.origin === fixture.origin;
  const onSession = onOrigin && window.location.pathname === fixture.sessionPath;
  const onList = onOrigin && window.location.pathname === fixture.listPath;
  const db = /** @type {Window & {__wallieReview?: Persisted}} */ (window).__wallieReview ?? null;
  const text = onSession ? (document.querySelector(heading)?.textContent?.trim() ?? "") : "";
  const visibleReview = /^Review (Plan|Build) v\d+$/.test(text) ? text : null;
  const activeStage =
    document
      .querySelector('nav[aria-label="Pipeline stages"] [aria-current="step"]')
      ?.getAttribute("aria-label")
      ?.split(":")[0] ?? null;
  const loading = window.performance.getEntriesByType("navigation")[0];
  const reloadMarker = window.sessionStorage.getItem("fixture-reloaded-after");
  const didReload =
    reloadMarker !== null &&
    reloadMarker !== String(window.performance.timeOrigin) &&
    loading instanceof PerformanceNavigationTiming &&
    loading.type === "reload";
  const field = control(document, input);
  const failedResponses = window.performance.getEntriesByType("resource").flatMap((entry) => {
    if (!(entry instanceof PerformanceResourceTiming)) return [];
    const status = entry.responseStatus;
    return status >= 500 ||
      (entry.name === fixture.origin + fixture.decisionPath && status >= 400 && status !== 409)
      ? [status]
      : [];
  });
  return {
    onSession,
    onList,
    db,
    expectedNewRuns: fixture.expectedNewRuns,
    visibleReview,
    activeStage,
    didReload,
    matchesReload: Boolean(
      onSession &&
      didReload &&
      db?.hasExactArtifact &&
      visibleReview === `Review ${db.stage} v${db.version}` &&
      activeStage === db.stage,
    ),
    crashes: errors.uncaughtExceptions.length,
    failedResponses,
    documentStatus: loading instanceof PerformanceNavigationTiming ? loading.responseStatus : 0,
    approveReady: Boolean(control(document, approve)),
    rejectReady: Boolean(control(document, "#session-review-decision button", "Request changes")),
    needsFeedback: field instanceof HTMLTextAreaElement && field.value !== fixture.feedback,
    feedbackReady:
      field instanceof HTMLTextAreaElement &&
      field.value === fixture.feedback &&
      Boolean(control(document, `${dialog} button`, "Queue rerun")),
    canLeave:
      !window.sessionStorage.getItem("fixture-listed") && Boolean(control(document, listLink)),
    canOpen: Boolean(control(document, sessionLink)),
    canGoBack: navigationHistory.back.at(-1)?.url === fixture.origin + fixture.sessionPath,
    earlyReload: window.sessionStorage.getItem("fixture-reloaded-early") !== null,
    lateReload: reloadMarker !== null,
  };
});

export const noUnexpectedBrowserFailure = always(
  () =>
    review.current.crashes === 0 &&
    review.current.documentStatus < 400 &&
    review.current.failedResponses.length === 0,
);

export const exactDecision = always(() => {
  const { db, expectedNewRuns } = review.current;
  return !db?.jobs || matchesDecision(db, fixture.decision, expectedNewRuns);
});

export const reloadShowsPersistedReview = always(
  now(() => review.current.lateReload).implies(
    eventually(() => review.current.matchesReload).within(8, "seconds"),
  ),
);

const seededReview = () => {
  const view = review.current;
  return (
    view.onSession &&
    view.visibleReview === "Review Plan v1" &&
    view.db?.phase === "awaiting_review" &&
    view.db.jobs === 0
  );
};

export const reviewActions = weighted([
  [
    7,
    actions(() => {
      const view = review.current;
      if (!seededReview()) return [];
      if (!reject) return view.approveReady ? [approvePlan()] : [];
      if (view.feedbackReady) return [submitFeedback()];
      if (view.needsFeedback) return [fillFeedback()];
      return view.rejectReady ? [requestChanges()] : [];
    }),
  ],
  [
    2,
    actions(() => (seededReview() && !review.current.earlyReload ? [reloadBeforeDecision()] : [])),
  ],
  [2, actions(() => (seededReview() && review.current.canLeave ? [leaveSession()] : []))],
  [
    4,
    actions(() => {
      if (!review.current.onList) return [];
      return [
        ...(review.current.canOpen ? [reopenSession()] : []),
        ...(review.current.canGoBack ? /** @type {const} */ (["Back"]) : []),
      ];
    }),
  ],
  [
    8,
    actions(() =>
      review.current.onSession &&
      review.current.db?.finishedJobs === 1 &&
      !review.current.lateReload
        ? [reloadAfterDecision()]
        : [],
    ),
  ],
  [1, "Wait"],
]);

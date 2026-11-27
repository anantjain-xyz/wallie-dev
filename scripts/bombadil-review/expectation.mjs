/** @typedef {{stage: string, phase: string, version: number, hasExactArtifact: boolean, rejections: number, planRuns: number, buildRuns: number, runs: number, jobs: number, finishedJobs: number, approval: number, feedback: number}} Persisted */

/** @param {Persisted} db @param {string} decision @param {number} expectedNewRuns */
export function matchesDecision(db, decision, expectedNewRuns) {
  const reject = decision === "reject";
  const stage = reject ? "Plan" : "Build";
  const version = reject ? 2 : 1;
  const newRuns = reject ? db.planRuns - 1 : db.buildRuns;
  return (
    db.stage === stage &&
    db.jobs === 1 &&
    db.runs === 2 &&
    newRuns === (db.finishedJobs === 0 ? 1 : expectedNewRuns) &&
    db.approval === (reject ? 0 : 1) &&
    db.feedback === (reject ? 1 : 0) &&
    db.rejections === (reject ? 1 : 0) &&
    (db.finishedJobs === 0 ||
      (db.finishedJobs === 1 &&
        db.phase === "awaiting_review" &&
        db.hasExactArtifact &&
        db.version === version))
  );
}

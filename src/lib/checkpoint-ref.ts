const CHECKPOINT_REF =
  /^refs\/(?:heads\/)?wallie\/checkpoints\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/([a-f0-9]{40})$/;

/** Retained checkpoint names encode the producing run and exact source commit. */
export function isWallieCheckpointRef(ref: string, headSha: string, runId?: string): boolean {
  const match = CHECKPOINT_REF.exec(ref);
  return (
    match !== null &&
    match[0] === ref &&
    match[2] === headSha &&
    (runId === undefined || match[1] === runId)
  );
}

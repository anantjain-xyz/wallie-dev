export function reviewArtifactLink(
  artifactId: string,
  version: number,
  stage: string,
  threadId?: string,
) {
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  params.delete("reviewStageId");
  params.delete("reviewRevision");
  params.delete("clarificationId");
  params.set("artifactId", artifactId);
  params.set("artifactVersion", String(version));
  params.set("artifactStage", stage);
  if (threadId) params.set("reviewThread", threadId);
  else params.delete("reviewThread");
  return `?${params}`;
}

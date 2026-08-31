type PipelineDashboardCursor = {
  pipelineId: string;
  stageId: string;
};

export function encodePipelineDashboardCursor(cursor: PipelineDashboardCursor) {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

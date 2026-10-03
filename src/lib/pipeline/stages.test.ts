import { describe, expect, it } from "vitest";
import { loadCompletedStageArtifacts } from "./stages";

function fixture(input: {
  completedStageIds: Array<string | null>;
  completionError?: Error;
  stageError?: Error;
  additionalArtifacts?: Array<{
    stage_id: string | null;
    stage_slug: string;
    version: number;
    artifact_json: string;
  }>;
  stageRows?: Array<{ id: string; slug: string }>;
}) {
  const artifacts = [
    { stage_id: "plan-id", stage_slug: "plan", version: 1, artifact_json: "old plan" },
    { stage_id: "plan-id", stage_slug: "plan", version: 2, artifact_json: "approved plan" },
    {
      stage_id: "build-id",
      stage_slug: "build",
      version: 1,
      artifact_json: "obsolete downstream build",
    },
    { stage_id: "build-id", stage_slug: "build", version: 2, artifact_json: "new approved build" },
    {
      stage_id: "release-id",
      stage_slug: "release",
      version: 1,
      artifact_json: "obsolete release",
    },
    {
      stage_id: "orphan-id",
      stage_slug: "plan",
      version: 3,
      artifact_json: "orphan output must not replace plan",
    },
    {
      stage_id: null,
      stage_slug: "plan",
      version: 4,
      artifact_json: "deleted stage output must not replace plan",
    },
  ];
  artifacts.push(...(input.additionalArtifacts ?? []));
  const stageRows = input.stageRows ?? [
    { id: "plan-id", slug: "plan" },
    { id: "build-id", slug: "build" },
    { id: "release-id", slug: "release" },
  ];
  const reads: Array<{ table: string; column?: string; ids?: string[] }> = [];
  const admin = {
    from(table: string) {
      const read: (typeof reads)[number] = { table };
      reads.push(read);
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: (column: string, ids: string[]) => {
          read.column = column;
          read.ids = ids;
          return builder;
        },
        order: () => builder,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(
            resolve(
              table === "session_phase_completions"
                ? {
                    data: input.completedStageIds.map((stage_id) => ({ stage_id })),
                    error: input.completionError ?? null,
                  }
                : table === "pipeline_stages"
                  ? {
                      data: stageRows.filter((row) => read.ids?.includes(row.id)),
                      error: input.stageError ?? null,
                    }
                  : {
                      data: artifacts.filter(
                        (row) => row.stage_id && read.ids?.includes(row.stage_id),
                      ),
                      error: null,
                    },
            ),
          ),
      };
      return builder;
    },
  };
  return { admin, reads };
}
describe("loadCompletedStageArtifacts", () => {
  it("excludes preserved downstream history after its completion is invalidated", async () => {
    const { admin } = fixture({ completedStageIds: ["plan-id"] });
    await expect(loadCompletedStageArtifacts(admin as never, "session")).resolves.toEqual({
      plan: "approved plan",
    });
  });
  it("exposes the latest artifact when the stage is completed again", async () => {
    const { admin } = fixture({ completedStageIds: ["plan-id", "build-id"] });
    await expect(loadCompletedStageArtifacts(admin as never, "session")).resolves.toEqual({
      plan: "approved plan",
      build: "new approved build",
    });
  });
  it("returns no prior-stage context when all completions were invalidated", async () => {
    const { admin, reads } = fixture({ completedStageIds: [] });
    await expect(loadCompletedStageArtifacts(admin as never, "session")).resolves.toEqual({});
    expect(reads).toEqual([{ table: "session_phase_completions" }]);
  });
  it("does not fall back to historical output when the completion read fails", async () => {
    const { admin, reads } = fixture({
      completedStageIds: [],
      completionError: new Error("database unavailable"),
    });
    await expect(loadCompletedStageArtifacts(admin as never, "session")).rejects.toThrow(
      "database unavailable",
    );
    expect(reads).toEqual([{ table: "session_phase_completions" }]);
  });
  it("maps renamed completed-stage output only to its current slug, never another stage reusing its old slug", async () => {
    const { admin, reads } = fixture({
      completedStageIds: ["plan-id"],
      stageRows: [
        { id: "plan-id", slug: "discovery" },
        { id: "build-id", slug: "plan" },
      ],
    });
    await expect(loadCompletedStageArtifacts(admin as never, "session")).resolves.toEqual({
      discovery: "approved plan",
    });
    expect(reads).toContainEqual({
      table: "session_artifacts",
      column: "stage_id",
      ids: ["plan-id"],
    });
  });
  it("keeps two completed stages distinct when their current names swap", async () => {
    const { admin } = fixture({
      completedStageIds: ["plan-id", "build-id"],
      stageRows: [
        { id: "plan-id", slug: "build" },
        { id: "build-id", slug: "plan" },
      ],
    });
    await expect(loadCompletedStageArtifacts(admin as never, "session")).resolves.toEqual({
      build: "approved plan",
      plan: "new approved build",
    });
  });
  it("does not infer null or orphaned stage identity from a matching historical label", async () => {
    const { admin } = fixture({ completedStageIds: [null, "orphan-id", "plan-id"] });
    await expect(loadCompletedStageArtifacts(admin as never, "session")).resolves.toEqual({
      plan: "approved plan",
    });
  });
  it("does not guess a prompt key when the current-stage lookup fails", async () => {
    const { admin } = fixture({
      completedStageIds: ["plan-id"],
      stageError: new Error("stage lookup failed"),
    });
    await expect(loadCompletedStageArtifacts(admin as never, "session")).rejects.toThrow(
      "stage lookup failed",
    );
  });
  it("fails closed when the highest retained version is duplicated for a completed stable stage", async () => {
    const { admin } = fixture({
      completedStageIds: ["plan-id"],
      additionalArtifacts: [
        {
          stage_id: "plan-id",
          stage_slug: "old-plan",
          version: 2,
          artifact_json: "different legacy output",
        },
      ],
    });
    await expect(loadCompletedStageArtifacts(admin as never, "session")).rejects.toThrow(
      'Completed stage "plan" has multiple artifacts at version 2',
    );
  });
  it("allows a unique latest version above ambiguous older history", async () => {
    const { admin } = fixture({
      completedStageIds: ["plan-id"],
      additionalArtifacts: [
        {
          stage_id: "plan-id",
          stage_slug: "old-plan",
          version: 1,
          artifact_json: "different old output",
        },
      ],
    });
    await expect(loadCompletedStageArtifacts(admin as never, "session")).resolves.toEqual({
      plan: "approved plan",
    });
  });
  it("does not treat equal numeric versions from distinct stable stages as a tie", async () => {
    const { admin } = fixture({ completedStageIds: ["plan-id", "build-id"] });
    await expect(loadCompletedStageArtifacts(admin as never, "session")).resolves.toEqual({
      plan: "approved plan",
      build: "new approved build",
    });
  });
});

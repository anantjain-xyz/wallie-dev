import { describe, expect, it, vi } from "vitest";
import { loadCompletedStageArtifacts } from "./stages";

function fixture(completedSlugs: string[], completionError: unknown = null) {
  const artifacts = [
    { stage_slug: "plan", version: 1, artifact_json: "old plan" },
    { stage_slug: "plan", version: 2, artifact_json: "approved plan" },
    { stage_slug: "build", version: 1, artifact_json: "obsolete downstream build" },
    { stage_slug: "build", version: 2, artifact_json: "new approved build" },
    { stage_slug: "release", version: 1, artifact_json: "obsolete release" },
  ];
  const tables: string[] = [];
  const admin = {
    from(table: string) {
      tables.push(table);
      let slugs: string[] = [];
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: vi.fn((_column: string, values: string[]) => {
          slugs = values;
          return builder;
        }),
        order: () => builder,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(
            resolve(
              table === "session_phase_completions"
                ? {
                    data: completedSlugs.map((stage_slug) => ({ stage_slug })),
                    error: completionError,
                  }
                : { data: artifacts.filter((row) => slugs.includes(row.stage_slug)), error: null },
            ),
          ),
      };
      return builder;
    },
  };
  return { admin, tables };
}
describe("loadCompletedStageArtifacts", () => {
  it("excludes preserved downstream history after its completion is invalidated", async () => {
    const { admin } = fixture(["plan"]);
    await expect(loadCompletedStageArtifacts(admin as never, "session")).resolves.toEqual({
      plan: "approved plan",
    });
  });
  it("exposes the latest artifact when the stage is completed again", async () => {
    const { admin } = fixture(["plan", "build"]);
    await expect(loadCompletedStageArtifacts(admin as never, "session")).resolves.toEqual({
      plan: "approved plan",
      build: "new approved build",
    });
  });
  it("returns no prior-stage context when all completions were invalidated", async () => {
    const { admin, tables } = fixture([]);
    await expect(loadCompletedStageArtifacts(admin as never, "session")).resolves.toEqual({});
    expect(tables).toEqual(["session_phase_completions"]);
  });
  it("does not fall back to historical output when the completion read fails", async () => {
    const { admin, tables } = fixture([], new Error("database unavailable"));
    await expect(loadCompletedStageArtifacts(admin as never, "session")).rejects.toThrow(
      "database unavailable",
    );
    expect(tables).toEqual(["session_phase_completions"]);
  });
});

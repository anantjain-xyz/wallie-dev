import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadArtifactEvidenceLinks } from "./artifact-links";

const sessionId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const assetId = "55555555-5555-4555-8555-555555555555";
const sha = "a".repeat(40);
type Row = Record<string, unknown>;
let rows: Record<string, Row[]>;
let errors: Record<string, unknown>;

function from(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let maximum = Infinity;
  const result = () => ({
    data: (rows[table] ?? [])
      .filter((row) => filters.every((filter) => filter(row)))
      .slice(0, maximum),
    error: errors[table] ?? null,
  });
  return {
    select() {
      return this;
    },
    eq(column: string, value: unknown) {
      filters.push((row) => row[column] === value);
      return this;
    },
    limit(value: number) {
      maximum = value;
      return this;
    },
    async maybeSingle() {
      const value = result();
      return { ...value, data: value.data[0] ?? null };
    },
    then(resolve: (value: ReturnType<typeof result>) => unknown) {
      return Promise.resolve(result()).then(resolve);
    },
  };
}

const supabase = { from: vi.fn(from) };
const load = () =>
  loadArtifactEvidenceLinks({ supabase: supabase as never, sessionId, workspaceId, artifactId });

beforeEach(() => {
  vi.clearAllMocks();
  errors = {};
  rows = {
    session_git_checkpoints: [
      {
        run_id: runId,
        artifact_id: artifactId,
        session_id: sessionId,
        workspace_id: workspaceId,
        output_sha: sha,
      },
    ],
    session_validation_evidence: [
      { run_id: runId, session_id: sessionId, workspace_id: workspaceId, commit_sha: sha },
    ],
    session_validation_assets: [
      {
        id: assetId,
        evidence_key: "checks/report",
        run_id: runId,
        session_id: sessionId,
        workspace_id: workspaceId,
      },
    ],
  };
});

describe("artifact evidence links", () => {
  it("resolves a persisted key to an authenticated route with the exact artifact identity", async () => {
    expect(await load()).toEqual(
      new Map([
        [
          "wallie-evidence:checks/report",
          `/api/sessions/${sessionId}/validation-evidence/assets/${assetId}?artifactId=${artifactId}`,
        ],
      ]),
    );
  });

  it("never substitutes a newer run with the same key", async () => {
    rows.session_validation_evidence.unshift({
      ...rows.session_validation_evidence[0],
      run_id: "newer-run",
    });
    rows.session_validation_assets.unshift({
      ...rows.session_validation_assets[0],
      id: "newer-asset",
      run_id: "newer-run",
    });
    const links = await load();
    expect(links.size).toBe(1);
    expect(links.get("wallie-evidence:checks/report")).toContain(`/assets/${assetId}?`);
  });

  it("leaves legacy artifacts without a checkpoint explicitly unresolved", async () => {
    rows.session_git_checkpoints = [];
    expect((await load()).size).toBe(0);
    expect(supabase.from).not.toHaveBeenCalledWith("session_validation_assets");
  });

  it.each([
    ["session_git_checkpoints", "artifact_id", "another-artifact"],
    ["session_git_checkpoints", "session_id", "another-session"],
    ["session_git_checkpoints", "workspace_id", "another-workspace"],
    ["session_validation_evidence", "run_id", "another-run"],
    ["session_validation_evidence", "session_id", "another-session"],
    ["session_validation_evidence", "workspace_id", "another-workspace"],
    ["session_validation_evidence", "commit_sha", "b".repeat(40)],
    ["session_validation_assets", "run_id", "another-run"],
    ["session_validation_assets", "session_id", "another-session"],
    ["session_validation_assets", "workspace_id", "another-workspace"],
  ])("does not resolve mismatched %s.%s", async (table, field, value) => {
    rows[table]![0]![field] = value;
    expect((await load()).size).toBe(0);
  });

  it.each(["session_git_checkpoints", "session_validation_evidence", "session_validation_assets"])(
    "fails closed when %s is inaccessible",
    async (table) => {
      errors[table] = { message: "private database detail" };
      expect((await load()).size).toBe(0);
    },
  );
});

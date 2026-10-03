import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

import { GET } from "./route";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const STAGE_ID = "22222222-2222-4222-8222-222222222222";
const PIPELINE_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";

function routeContext(sessionId = SESSION_ID) {
  return { params: Promise.resolve({ sessionId }) };
}

function request(query: string) {
  return new Request(`http://localhost/api/sessions/${SESSION_ID}/artifacts?${query}`);
}

function buildSupabaseMock({
  artifactRows = [],
  feedbackError = null,
  feedbackRows = [],
  runError = null,
  runRows = [],
  sessionRow = { id: SESSION_ID, pipeline_id: PIPELINE_ID, workspace_id: WORKSPACE_ID },
  stageError = null,
  stageRow = { id: STAGE_ID, pipeline_id: PIPELINE_ID, slug: "build" },
}: {
  artifactRows?: Array<{
    artifact_json?: unknown;
    created_at: string;
    id: string;
    stage_slug: string;
    stage_id?: string;
    version: number;
  }>;
  feedbackError?: { message: string } | null;
  feedbackRows?: Array<{ target_version: number; stage_id?: string; stage_slug?: string }>;
  runError?: { message: string } | null;
  runRows?: Array<{
    stage_id?: string;
    stage_slug?: string;
    created_at?: string;
    finished_at: string;
    model_name: string;
    model_provider: string;
    status: string;
  }>;
  sessionRow?: { id: string; pipeline_id: string; workspace_id: string } | null;
  stageError?: { message: string } | null;
  stageRow?: { id: string; pipeline_id: string; slug: string } | null;
} = {}) {
  const selects: string[] = [];
  const filters: Array<[string, unknown]> = [];
  const tableFilters: Array<[string, string, unknown]> = [];
  const rowsByTable: Record<string, Record<string, unknown>[]> = {
    sessions: sessionRow ? [sessionRow] : [],
    session_selected_stages: stageRow
      ? [{ session_id: SESSION_ID, workspace_id: WORKSPACE_ID, stage: stageRow }]
      : [],
    session_artifacts: artifactRows.map((row) => ({
      session_id: SESSION_ID,
      stage_id: STAGE_ID,
      ...row,
    })),
    session_artifact_feedback: feedbackRows.map((row) => ({
      session_id: SESSION_ID,
      stage_id: STAGE_ID,
      ...row,
    })),
    agent_runs: runRows.map((row) => ({ session_id: SESSION_ID, stage_id: STAGE_ID, ...row })),
  };
  const errorsByTable: Record<string, { message: string } | null> = {
    session_selected_stages: stageError,
    session_artifact_feedback: feedbackError,
    agent_runs: runError,
  };
  const valueAt = (row: Record<string, unknown>, column: string): unknown =>
    column.split(".").reduce<unknown>((value, key) => {
      return value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;
    }, row);

  return {
    client: {
      from(table: string) {
        if (!rowsByTable[table]) throw new Error(`Unexpected table ${table}`);
        let rows = [...rowsByTable[table]];
        const error = errorsByTable[table] ?? null;
        const builder = {
          select(columns: string) {
            selects.push(
              table === "session_artifact_feedback"
                ? "feedback"
                : table === "agent_runs"
                  ? "runs"
                  : columns,
            );
            return builder;
          },
          eq(column: string, value: unknown) {
            filters.push([column, value]);
            tableFilters.push([table, column, value]);
            rows = rows.filter((row) => valueAt(row, column) === value);
            return builder;
          },
          limit(count: number) {
            rows = rows.slice(0, count);
            return builder;
          },
          maybeSingle: async () => ({ data: error ? null : (rows[0] ?? null), error }),
          order(column: string, { ascending }: { ascending: boolean }) {
            rows.sort((left, right) => {
              const a = valueAt(left, column);
              const b = valueAt(right, column);
              const comparison =
                typeof a === "number" && typeof b === "number"
                  ? a - b
                  : String(a).localeCompare(String(b));
              return ascending ? comparison : -comparison;
            });
            return builder;
          },
          then<TResult1 = { data: typeof rows | null; error: typeof error }, TResult2 = never>(
            onfulfilled?:
              | ((value: {
                  data: typeof rows | null;
                  error: typeof error;
                }) => TResult1 | PromiseLike<TResult1>)
              | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ) {
            return Promise.resolve({ data: error ? null : rows, error }).then(
              onfulfilled,
              onrejected,
            );
          },
        };
        return builder;
      },
    },
    filters,
    tableFilters,
    selects,
  };
}

describe("GET /api/sessions/[sessionId]/artifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
  });

  it("returns version metadata with attempt, author, and changes-requested markers", async () => {
    const supabase = buildSupabaseMock({
      artifactRows: [
        {
          created_at: "2026-06-07T11:00:00.000Z",
          id: "artifact-2",
          stage_slug: "build",
          version: 2,
        },
        {
          created_at: "2026-06-07T10:00:00.000Z",
          id: "artifact-1",
          stage_slug: "build",
          version: 1,
        },
      ],
      feedbackRows: [{ target_version: 1 }],
      runRows: [
        {
          created_at: "2026-06-07T09:50:00.000Z",
          finished_at: "2026-06-07T10:00:05.000Z",
          model_name: "opus",
          model_provider: "claude-code",
          status: "success",
        },
        {
          created_at: "2026-06-07T10:50:00.000Z",
          finished_at: "2026-06-07T11:00:05.000Z",
          model_name: "gpt-5",
          model_provider: "codex",
          status: "success",
        },
      ],
    });
    mocked.createSupabaseServerClient.mockResolvedValue(supabase.client);

    const result = await GET(request("stage=build"), routeContext());

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({
      artifacts: [
        {
          attempt: 2,
          authorLabel: "Codex (gpt-5)",
          changesRequested: false,
          createdAt: "2026-06-07T11:00:00.000Z",
          id: "artifact-2",
          stageSlug: "build",
          version: 2,
        },
        {
          attempt: 1,
          authorLabel: "Claude Code (opus)",
          changesRequested: true,
          createdAt: "2026-06-07T10:00:00.000Z",
          id: "artifact-1",
          stageSlug: "build",
          version: 1,
        },
      ],
    });
    expect(supabase.selects).toContain("created_at, id, stage_slug, version");
    expect(supabase.selects).toContain("feedback");
    expect(supabase.selects).toContain("runs");
  });

  it("maps authors from post-reset runs only when older successful runs remain", async () => {
    const supabase = buildSupabaseMock({
      artifactRows: [
        {
          created_at: "2026-06-08T10:00:00.000Z",
          id: "artifact-1",
          stage_slug: "build",
          version: 1,
        },
      ],
      runRows: [
        {
          created_at: "2026-06-07T09:50:00.000Z",
          finished_at: "2026-06-07T10:00:05.000Z",
          model_name: "opus",
          model_provider: "claude-code",
          status: "success",
        },
        {
          created_at: "2026-06-07T10:50:00.000Z",
          finished_at: "2026-06-07T11:00:05.000Z",
          model_name: "gpt-4.1",
          model_provider: "codex",
          status: "success",
        },
        {
          created_at: "2026-06-08T09:50:00.000Z",
          finished_at: "2026-06-08T10:00:05.000Z",
          model_name: "gpt-5",
          model_provider: "codex",
          status: "success",
        },
      ],
    });
    mocked.createSupabaseServerClient.mockResolvedValue(supabase.client);

    const result = await GET(request("stage=build"), routeContext());
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({
      artifacts: [
        {
          attempt: 1,
          authorLabel: "Codex (gpt-5)",
          changesRequested: false,
          createdAt: "2026-06-08T10:00:00.000Z",
          id: "artifact-1",
          stageSlug: "build",
          version: 1,
        },
      ],
    });
  });

  it("returns Agent while the post-reset producing run is not yet marked success", async () => {
    const supabase = buildSupabaseMock({
      artifactRows: [
        {
          created_at: "2026-06-08T10:00:00.000Z",
          id: "artifact-1",
          stage_slug: "build",
          version: 1,
        },
      ],
      runRows: [
        {
          created_at: "2026-06-07T09:50:00.000Z",
          finished_at: "2026-06-07T10:00:05.000Z",
          model_name: "opus",
          model_provider: "claude-code",
          status: "success",
        },
        {
          created_at: "2026-06-07T10:50:00.000Z",
          finished_at: "2026-06-07T11:00:05.000Z",
          model_name: "gpt-4.1",
          model_provider: "codex",
          status: "success",
        },
      ],
    });
    mocked.createSupabaseServerClient.mockResolvedValue(supabase.client);

    const result = await GET(request("stage=build"), routeContext());
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({
      artifacts: [
        {
          attempt: 1,
          authorLabel: "Agent",
          changesRequested: false,
          createdAt: "2026-06-08T10:00:00.000Z",
          id: "artifact-1",
          stageSlug: "build",
          version: 1,
        },
      ],
    });
  });

  it("returns 500 when feedback or agent-run metadata queries fail", async () => {
    const feedbackFailure = buildSupabaseMock({
      artifactRows: [
        {
          created_at: "2026-06-07T10:00:00.000Z",
          id: "artifact-1",
          stage_slug: "build",
          version: 1,
        },
      ],
      feedbackError: { message: "feedback unavailable" },
    });
    mocked.createSupabaseServerClient.mockResolvedValue(feedbackFailure.client);

    const feedbackResult = await GET(request("stage=build"), routeContext());
    expect(feedbackResult.status).toBe(500);
    await expect(feedbackResult.json()).resolves.toEqual({ error: "feedback unavailable" });

    const runFailure = buildSupabaseMock({
      artifactRows: [
        {
          created_at: "2026-06-07T10:00:00.000Z",
          id: "artifact-1",
          stage_slug: "build",
          version: 1,
        },
      ],
      runError: { message: "runs unavailable" },
    });
    mocked.createSupabaseServerClient.mockResolvedValue(runFailure.client);

    const runResult = await GET(request("stage=build"), routeContext());
    expect(runResult.status).toBe(500);
    await expect(runResult.json()).resolves.toEqual({ error: "runs unavailable" });
  });

  it("returns one requested body with sanitized server-rendered Markdown", async () => {
    const supabase = buildSupabaseMock({
      artifactRows: [
        {
          artifact_json:
            "# Safe\n\n<script>alert(1)</script> [bad](javascript:alert(2))\n\n| A | B |\n| - | - |\n| x | y |\n\n- [x] done",
          created_at: "2026-06-07T10:00:00.000Z",
          id: "artifact-1",
          stage_slug: "build",
          version: 1,
        },
      ],
    });
    mocked.createSupabaseServerClient.mockResolvedValue(supabase.client);

    const result = await GET(request("stage=build&version=1"), routeContext());
    const payload = (await result.json()) as {
      artifact: { payload: string; sanitizedHtml: string; version: number };
    };

    expect(result.status).toBe(200);
    expect(payload.artifact.version).toBe(1);
    expect(payload.artifact.sanitizedHtml).toContain("<h1");
    expect(payload.artifact.sanitizedHtml).toContain("<table");
    expect(payload.artifact.sanitizedHtml).toContain('type="checkbox"');
    expect(payload.artifact.sanitizedHtml).toContain('aria-label="Table"');
    expect(payload.artifact.sanitizedHtml).toContain("artifact-table-scroll");
    expect(payload.artifact.sanitizedHtml).not.toContain("<script");
    expect(payload.artifact.sanitizedHtml).not.toContain("javascript:");
    expect(supabase.filters).toContainEqual(["version", 1]);
  });

  it.each(["latest=true", "version=1"])(
    "loads the exact artifact after its selected stage is renamed (%s)",
    async (selector) => {
      const artifact = {
        artifact_json: "# Review this original output",
        created_at: "2026-06-07T10:00:00.000Z",
        id: "artifact-before-rename",
        stage_id: STAGE_ID,
        stage_slug: "build",
        version: 1,
      };
      const supabase = buildSupabaseMock({
        artifactRows: [
          {
            ...artifact,
            id: "wrong-stage",
            stage_id: "another-stage",
            stage_slug: "implement",
            version: 2,
          },
          artifact,
        ],
        stageRow: { id: STAGE_ID, pipeline_id: PIPELINE_ID, slug: "implement" },
      });
      mocked.createSupabaseServerClient.mockResolvedValue(supabase.client);

      const result = await GET(request(`stage=implement&${selector}`), routeContext());
      expect(result.status).toBe(200);
      await expect(result.json()).resolves.toMatchObject({
        artifact: {
          id: artifact.id,
          stageSlug: "implement",
          version: 1,
          payload: artifact.artifact_json,
        },
      });
      expect(artifact.stage_slug).toBe("build");
      expect(supabase.tableFilters).toContainEqual(["session_artifacts", "stage_id", STAGE_ID]);
      expect(supabase.tableFilters).toContainEqual([
        "session_selected_stages",
        "stage.pipeline_id",
        PIPELINE_ID,
      ]);
    },
  );

  it("keeps renamed-stage versions, feedback, and authors bound to the selected stage ID", async () => {
    const supabase = buildSupabaseMock({
      stageRow: { id: STAGE_ID, pipeline_id: PIPELINE_ID, slug: "implement" },
      artifactRows: [
        {
          created_at: "2026-06-07T10:00:00.000Z",
          id: "artifact-1",
          stage_slug: "build",
          version: 1,
        },
      ],
      feedbackRows: [{ stage_slug: "build", target_version: 1 }],
      runRows: [
        {
          stage_id: "another-stage",
          stage_slug: "implement",
          finished_at: "2026-06-07T10:00:01.000Z",
          model_provider: "cursor",
          model_name: "wrong",
          status: "success",
        },
        {
          stage_slug: "build",
          finished_at: "2026-06-07T10:00:05.000Z",
          model_provider: "codex",
          model_name: "gpt-5",
          status: "success",
        },
      ],
    });
    mocked.createSupabaseServerClient.mockResolvedValue(supabase.client);

    const result = await GET(request("stage=implement"), routeContext());
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({
      artifacts: [
        {
          id: "artifact-1",
          stageSlug: "implement",
          changesRequested: true,
          authorLabel: "Codex (gpt-5)",
        },
      ],
    });
    for (const table of ["session_artifacts", "session_artifact_feedback", "agent_runs"]) {
      expect(supabase.tableFilters).toContainEqual([table, "stage_id", STAGE_ID]);
    }
  });

  it.each([
    { stageRow: null, expectedStatus: 404 },
    {
      stageRow: { id: STAGE_ID, pipeline_id: "another-pipeline", slug: "build" },
      expectedStatus: 404,
    },
    { stageError: { message: "stage unavailable" }, expectedStatus: 500 },
  ])(
    "does not load artifacts without a verified selected stage ($expectedStatus)",
    async ({ expectedStatus, ...options }) => {
      const supabase = buildSupabaseMock(options);
      mocked.createSupabaseServerClient.mockResolvedValue(supabase.client);
      const result = await GET(request("stage=build&latest=true"), routeContext());
      expect(result.status).toBe(expectedStatus);
      expect(supabase.tableFilters.some(([table]) => table === "session_artifacts")).toBe(false);
    },
  );

  it("requires a stage and rejects conflicting body selectors", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue(buildSupabaseMock().client);

    const missingStage = await GET(request("version=1"), routeContext());
    const conflicting = await GET(request("stage=build&version=1&latest=true"), routeContext());

    expect(missingStage.status).toBe(400);
    expect(conflicting.status).toBe(400);
    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
  });
});

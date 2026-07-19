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
  sessionRow = { id: SESSION_ID },
}: {
  artifactRows?: Array<{
    artifact_json?: unknown;
    created_at: string;
    id: string;
    stage_slug: string;
    version: number;
  }>;
  feedbackError?: { message: string } | null;
  feedbackRows?: Array<{ target_version: number }>;
  runError?: { message: string } | null;
  runRows?: Array<{
    created_at: string;
    model_name: string;
    model_provider: string;
    status: string;
  }>;
  sessionRow?: { id: string } | null;
} = {}) {
  const selects: string[] = [];
  const filters: Array<[string, unknown]> = [];

  return {
    client: {
      from(table: string) {
        if (table === "sessions") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: sessionRow, error: null }),
              }),
            }),
          };
        }
        if (table === "session_artifact_feedback") {
          return {
            select() {
              selects.push("feedback");
              const builder = {
                eq() {
                  return builder;
                },
                then<
                  TResult1 = {
                    data: typeof feedbackRows | null;
                    error: { message: string } | null;
                  },
                  TResult2 = never,
                >(
                  onfulfilled?:
                    | ((value: {
                        data: typeof feedbackRows | null;
                        error: { message: string } | null;
                      }) => TResult1 | PromiseLike<TResult1>)
                    | null,
                  onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
                ) {
                  return Promise.resolve({
                    data: feedbackError ? null : feedbackRows,
                    error: feedbackError,
                  }).then(onfulfilled, onrejected);
                },
              };
              return builder;
            },
          };
        }
        if (table === "agent_runs") {
          return {
            select() {
              selects.push("runs");
              const builder = {
                eq() {
                  return builder;
                },
                order() {
                  return builder;
                },
                then<
                  TResult1 = {
                    data: typeof runRows | null;
                    error: { message: string } | null;
                  },
                  TResult2 = never,
                >(
                  onfulfilled?:
                    | ((value: {
                        data: typeof runRows | null;
                        error: { message: string } | null;
                      }) => TResult1 | PromiseLike<TResult1>)
                    | null,
                  onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
                ) {
                  return Promise.resolve({
                    data: runError ? null : runRows,
                    error: runError,
                  }).then(onfulfilled, onrejected);
                },
              };
              return builder;
            },
          };
        }
        if (table !== "session_artifacts") throw new Error(`Unexpected table ${table}`);

        return {
          select(columns: string) {
            selects.push(columns);
            const builder = {
              eq(column: string, value: unknown) {
                filters.push([column, value]);
                return builder;
              },
              limit() {
                return builder;
              },
              maybeSingle: async () => ({ data: artifactRows[0] ?? null, error: null }),
              order() {
                return builder;
              },
              then<TResult1 = { data: typeof artifactRows; error: null }, TResult2 = never>(
                onfulfilled?:
                  | ((value: {
                      data: typeof artifactRows;
                      error: null;
                    }) => TResult1 | PromiseLike<TResult1>)
                  | null,
                onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
              ) {
                return Promise.resolve({ data: artifactRows, error: null }).then(
                  onfulfilled,
                  onrejected,
                );
              },
            };
            return builder;
          },
        };
      },
    },
    filters,
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
          model_name: "opus",
          model_provider: "claude-code",
          status: "success",
        },
        {
          created_at: "2026-06-07T10:50:00.000Z",
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
          model_name: "opus",
          model_provider: "claude-code",
          status: "success",
        },
        {
          created_at: "2026-06-07T10:50:00.000Z",
          model_name: "gpt-4.1",
          model_provider: "codex",
          status: "success",
        },
        {
          created_at: "2026-06-08T09:50:00.000Z",
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

  it("requires a stage and rejects conflicting body selectors", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue(buildSupabaseMock().client);

    const missingStage = await GET(request("version=1"), routeContext());
    const conflicting = await GET(request("stage=build&version=1&latest=true"), routeContext());

    expect(missingStage.status).toBe(400);
    expect(conflicting.status).toBe(400);
    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
  });
});

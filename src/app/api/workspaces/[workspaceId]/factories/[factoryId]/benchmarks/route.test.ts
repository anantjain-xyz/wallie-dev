import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));

import { POST as saveSuite } from "./suites/route";
import { POST as saveTask } from "./tasks/route";

const workspaceId = "61300000-0000-4000-8000-000000000001";
const factoryId = "61300000-0000-4000-8000-000000000002";
const userId = "61300000-0000-4000-8000-000000000003";
const suiteId = "61300000-0000-4000-8000-000000000004";
const taskId = "61300000-0000-4000-8000-000000000005";
const baseRevisionId = "61300000-0000-4000-8000-000000000006";
const newRevisionId = "61300000-0000-4000-8000-000000000007";
const staleRevisionId = "61300000-0000-4000-8000-000000000008";
const params = Promise.resolve({ workspaceId, factoryId });
const baseUrl = `http://factory.test/api/workspaces/${workspaceId}/factories/${factoryId}/benchmarks`;
const createCommand = {
  name: "  UI regressions  ",
  purpose: "regression",
  allowEmpty: true,
  selection: { kind: "explicit", taskRevisionIds: [] },
};
const suiteEdit = {
  suiteId,
  expectedRevisionId: baseRevisionId,
  name: "Review holdout",
  purpose: "holdout",
  selection: {
    kind: "tags",
    tags: ["  review  ", "triage"],
    previewTaskRevisionIds: [baseRevisionId],
  },
};
const taskEdit = {
  taskId,
  expectedRevisionId: baseRevisionId,
  name: " Review a stage ",
  acceptanceCriteria: " Preserve the stage output. ",
  tags: ["  review  "],
};

function useDatabase({
  visible = true,
  taskVisible = true,
  currentTaskRevision = baseRevisionId,
  writeError,
}: {
  visible?: boolean;
  taskVisible?: boolean;
  currentTaskRevision?: string;
  writeError?: string;
} = {}) {
  const read = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith("/factories"))
      return Response.json(visible ? { id: factoryId } : null);
    if (url.pathname.endsWith("/factory_benchmark_task_revisions")) {
      return Response.json(
        taskVisible
          ? {
              id: currentTaskRevision,
              replay_eligibility: "ineligible",
              eligibility_reason: "The original source was removed.",
            }
          : null,
      );
    }
    throw new Error(`Unexpected authenticated read of ${url.pathname}`);
  });
  const write = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (writeError) {
      return Response.json(
        { code: writeError, message: "Private database error." },
        { status: 400 },
      );
    }
    if (url.pathname.endsWith("/curate_factory_benchmark_suite")) {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        id: newRevisionId,
        suite_id: suiteId,
        revision_number: body.p_suite_id ? 2 : 1,
      });
    }
    if (url.pathname.endsWith("/save_factory_benchmark_task_revision")) {
      return Response.json({ id: newRevisionId, task_id: taskId, revision_number: 2 });
    }
    throw new Error(`Unexpected privileged write to ${url.pathname}`);
  });
  const client = createClient<Database>("http://factory.test", "reader", {
    auth: { persistSession: false },
    global: { fetch: read },
  });
  const writer = createClient<Database>("http://factory.test", "writer", {
    auth: { persistSession: false },
    global: { fetch: write },
  });
  mocks.access.mockResolvedValue({ ok: true, context: { user: { id: userId }, supabase: client } });
  mocks.admin.mockReturnValue(writer);
  return { read, write };
}

function post(resource: "suites" | "tasks", body: unknown) {
  return new Request(`${baseUrl}/${resource}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const actor = { p_workspace_id: workspaceId, p_factory_id: factoryId, p_actor_user_id: userId };

describe("benchmark suite and task mutations", () => {
  beforeEach(() => vi.resetAllMocks());

  it("writes exact suite selection modes and uses the authenticated actor and requested revision", async () => {
    const { write } = useDatabase();
    const created = await saveSuite(post("suites", createCommand), { params });
    const edited = await saveSuite(post("suites", suiteEdit), { params });
    const renamed = await saveSuite(
      post("suites", { ...suiteEdit, name: "Renamed holdout", selection: { kind: "preserve" } }),
      { params },
    );

    expect(created.status).toBe(200);
    expect(created.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await created.json()).toEqual({ suiteId, revisionId: newRevisionId, revisionNumber: 1 });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toEqual({ suiteId, revisionId: newRevisionId, revisionNumber: 2 });
    expect(renamed.status).toBe(200);
    expect(write.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      {
        ...actor,
        p_name: "UI regressions",
        p_purpose: "regression",
        p_task_revision_ids: [],
        p_allow_empty: true,
      },
      {
        ...actor,
        p_name: "Review holdout",
        p_purpose: "holdout",
        p_suite_id: suiteId,
        p_expected_revision_id: baseRevisionId,
        p_selection_tags: ["review", "triage"],
        p_preview_task_revision_ids: [baseRevisionId],
      },
      {
        ...actor,
        p_name: "Renamed holdout",
        p_purpose: "holdout",
        p_suite_id: suiteId,
        p_expected_revision_id: baseRevisionId,
        p_preserve_selection: true,
      },
    ]);
  });

  it("reads the scoped current task and preserves its eligibility evidence when criteria change", async () => {
    const { read, write } = useDatabase();
    const edited = await saveTask(post("tasks", taskEdit), { params });

    expect(edited.status).toBe(200);
    expect(await edited.json()).toEqual({ taskId, revisionId: newRevisionId, revisionNumber: 2 });
    const taskQuery = read.mock.calls
      .map(([input]) => new URL(input instanceof Request ? input.url : input))
      .find((url) => url.pathname.endsWith("/factory_benchmark_task_revisions"));
    expect(taskQuery?.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
    expect(taskQuery?.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
    expect(taskQuery?.searchParams.get("task_id")).toBe(`eq.${taskId}`);
    expect(taskQuery?.searchParams.get("order")).toBe("revision_number.desc");
    expect(taskQuery?.searchParams.get("limit")).toBe("1");
    expect(write.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      {
        ...actor,
        p_task_id: taskId,
        p_expected_revision_id: baseRevisionId,
        p_name: "Review a stage",
        p_acceptance_criteria: "Preserve the stage output.",
        p_tags: ["review"],
        p_replay_eligibility: "ineligible",
        p_eligibility_reason: "The original source was removed.",
      },
    ]);
  });

  it("rejects missing expected revisions and client-supplied eligibility before writing", async () => {
    useDatabase();
    const missingBase = await saveSuite(post("suites", { ...createCommand, suiteId }), { params });
    const noSelection = await saveSuite(
      post("suites", { ...createCommand, selection: { kind: "preserve" } }),
      { params },
    );
    const spoofed = await saveTask(post("tasks", { ...taskEdit, replayEligibility: "eligible" }), {
      params,
    });

    expect(missingBase.status).toBe(400);
    expect(noSelection.status).toBe(400);
    expect(spoofed.status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("rejects inaccessible factories and tasks through the session client", async () => {
    useDatabase({ visible: false });
    expect((await saveSuite(post("suites", createCommand), { params })).status).toBe(404);
    useDatabase({ taskVisible: false });
    expect((await saveTask(post("tasks", taskEdit), { params })).status).toBe(404);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("keeps the database manager gate for writes and masks private errors", async () => {
    useDatabase({ writeError: "42501" });
    for (const response of [
      await saveSuite(post("suites", createCommand), { params }),
      await saveTask(post("tasks", taskEdit), { params }),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "Only a factory manager can save benchmark revisions.",
      });
    }
  });

  it("reports a stale task before invoking the writer", async () => {
    useDatabase({ currentTaskRevision: staleRevisionId });
    const staleTask = await saveTask(post("tasks", taskEdit), { params });
    expect(staleTask.status).toBe(409);
    expect(await staleTask.json()).toEqual({
      error: "The benchmark task changed. Reload the latest revision before saving.",
    });
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("reports revision races from either database mutation as conflicts", async () => {
    useDatabase({ writeError: "PT409" });
    const staleSuite = await saveSuite(post("suites", suiteEdit), { params });
    const racedTask = await saveTask(post("tasks", taskEdit), { params });
    expect(staleSuite.status).toBe(409);
    expect(racedTask.status).toBe(409);
    expect(await staleSuite.json()).toEqual({
      error: "The benchmark suite changed. Reload the latest revision before saving.",
    });
    expect(await racedTask.json()).toEqual({
      error: "The benchmark task changed. Reload the latest revision before saving.",
    });
  });

  it("reports an unavailable task selection without returning database details", async () => {
    useDatabase({ writeError: "PT422" });
    const response = await saveSuite(post("suites", suiteEdit), { params });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "A selected benchmark task revision is unavailable in this factory.",
    });
  });

  it.each([
    [
      "PT412",
      412,
      "Tag matches changed while you were editing. Refresh the preview and review it before saving.",
    ],
    ["PT428", 428, "Confirm that you want to save a suite with no tasks."],
  ] as const)("returns actionable selection feedback for %s", async (writeError, status, error) => {
    useDatabase({ writeError });
    const response = await saveSuite(post("suites", suiteEdit), { params });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });
});

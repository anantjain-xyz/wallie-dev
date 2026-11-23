import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

const mocked = vi.hoisted(() => ({ workspaceAccess: vi.fn(), adminClient: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocked.workspaceAccess }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocked.adminClient }));

import { POST as dryRun } from "./[automationId]/dry-run/route";
import { GET as getDetail, POST as mutate } from "./[automationId]/route";
import { GET, POST } from "./route";

function id(value: number) {
  return `65800000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const scope = { workspaceId: id(1), factoryId: id(2) };
const automationId = id(3);
const revisionId = id(4);
const actorId = id(5);
const params = Promise.resolve(scope);
const detailParams = Promise.resolve({ ...scope, automationId });
const api = "https://wallie.test/api/automations";
const definition = {
  name: "Deliver reviewed changes",
  trigger: { kind: "pull-request", repositoryId: id(6) },
  filters: { actions: ["merged"], baseBranches: ["main"] },
  target: { kind: "agent", definitionRevisionId: id(7), agentId: id(8) },
  executionGrant: { id: id(9), version: 1 },
  servicePrincipalId: id(10),
  budgetPayerMemberId: id(11),
  credentialBindingId: id(12),
};
const automation = {
  automationId,
  draftRevisionId: revisionId,
  publishedRevisionId: null,
  archivedAt: null,
  revision: {
    id: revisionId,
    revision: 1,
    definition,
    createdAt: "2026-11-23T16:00:00.000123+00:00",
    createdByMemberId: id(13),
  },
};
const event = { kind: "pull-request", repositoryId: id(6), action: "merged", baseBranch: "main" };
const preview = {
  automationId,
  revisionId,
  matched: true,
  checks: [{ field: "kind", actual: "pull-request", expected: ["pull-request"], passed: true }],
  budgetPayerMemberId: definition.budgetPayerMemberId,
  assignment: {
    status: "eligible",
    agentName: "Reviewer",
    workflowName: null,
    executionPolicyRevisionId: id(14),
  },
};

function fixture({
  visible = true,
  readable = true,
  errorCode,
  dryRunResult = preview,
}: {
  visible?: boolean;
  readable?: boolean;
  errorCode?: string;
  dryRunResult?: unknown;
} = {}) {
  const signedInFetch = vi.fn<typeof fetch>(async (input) => {
    const name = new URL(String(input)).pathname.split("/").at(-1);
    if (name === "factories") return Response.json(visible ? [{ id: scope.factoryId }] : []);
    if (!readable) return Response.json(null);
    if (name === "dry_run_factory_automation") return Response.json(dryRunResult);
    return Response.json(
      name === "list_factory_automations"
        ? { automations: [automation], nextCursor: null }
        : automation,
    );
  });
  const writeFetch = vi.fn<typeof fetch>(async () =>
    errorCode
      ? Response.json({ code: errorCode, message: "Private assignment detail" }, { status: 400 })
      : Response.json(automation),
  );
  const reader = createClient<Database>("https://fixture.invalid", "reader-key", {
    global: { fetch: signedInFetch },
  });
  const writer = createClient<Database>("https://fixture.invalid", "writer-key", {
    global: { fetch: writeFetch },
  });
  mocked.workspaceAccess.mockResolvedValue({
    ok: true,
    context: { user: { id: actorId }, supabase: reader },
  });
  mocked.adminClient.mockReturnValue(writer);
  return { signedInFetch, writeFetch };
}

function command(body: unknown) {
  return new Request(api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function scheduleDefinition(cron: string) {
  return { ...definition, trigger: { kind: "schedule", cron, timeZone: "UTC" }, filters: {} };
}

describe("factory automation definition routes", () => {
  beforeEach(() => vi.resetAllMocks());

  it("reads current and selected revisions using the signed-in client and disables caching", async () => {
    const { signedInFetch } = fixture();
    const list = await GET(new Request(api), { params });
    const detail = await getDetail(new Request(`${api}/${automationId}?revisionId=${revisionId}`), {
      params: detailParams,
    });
    expect(list.status).toBe(200);
    expect(list.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await list.json()).toEqual({ automations: [automation], nextCursor: null });
    expect(await detail.json()).toEqual({ automation });
    const request = signedInFetch.mock.calls.find(([url]) =>
      String(url).endsWith("/read_factory_automation"),
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_automation_id: automationId,
      p_selected_revision_id: revisionId,
    });
    expect(mocked.adminClient).not.toHaveBeenCalled();
  });

  it("masks unavailable rules and never writes in a hidden factory", async () => {
    fixture({ readable: false });
    expect((await getDetail(new Request(api), { params: detailParams })).status).toBe(404);
    fixture({ visible: false });
    expect((await POST(command({ automationId, definition }), { params })).status).toBe(404);
    expect(mocked.adminClient).not.toHaveBeenCalled();
  });

  it("uses the signed-in actor and expected publication for guarded archive", async () => {
    const { writeFetch } = fixture();
    const result = await mutate(
      command({
        action: "archive",
        expectedRevisionId: revisionId,
        expectedPublication: { revisionId: null },
      }),
      { params: detailParams },
    );
    expect(result.status).toBe(200);
    const [url, request] = writeFetch.mock.calls[0];
    expect(String(url)).toMatch(/\/archive_factory_automation$/);
    expect(JSON.parse(String(request?.body))).toEqual({
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_actor_user_id: actorId,
      p_automation_id: automationId,
      p_expected_revision_id: revisionId,
      p_expected_publication: { revisionId: null },
    });
  });

  it.each([
    { code: "42501", status: 403 },
    { code: "PT409", status: 409 },
    { code: "PT422", status: 422 },
  ])("maps $code to $status without exposing database details", async ({ code, status }) => {
    fixture({ errorCode: code });
    const result = await mutate(command({ action: "publish", expectedRevisionId: revisionId }), {
      params: detailParams,
    });
    expect(result.status).toBe(status);
    expect(await result.text()).not.toContain("Private assignment detail");
  });

  it.each([
    { ...definition, credentials: { token: "credential-material" } },
    { ...definition, filters: { stateIds: ["Done"], teamIds: [], projectIds: [] } },
  ])("rejects an undeclared or mismatched definition field before a write", async (invalid) => {
    fixture();
    expect((await POST(command({ automationId, definition: invalid }), { params })).status).toBe(
      400,
    );
    expect(mocked.adminClient).not.toHaveBeenCalled();
  });

  it.each([
    "99 99 99 99 99",
    "*/0 * * * *",
    "- - - - -",
    "20-10 * * * *",
    "1/2 * * * *",
    "0 9 * * 1\n",
  ])("rejects invalid cron %s before a privileged write", async (cron) => {
    fixture();
    const result = await POST(command({ automationId, definition: scheduleDefinition(cron) }), {
      params,
    });
    expect(result.status).toBe(400);
    expect(mocked.adminClient).not.toHaveBeenCalled();
  });

  it("passes valid cron lists, ranges and steps through to the definition store", async () => {
    const { writeFetch } = fixture();
    const schedule = scheduleDefinition("05,59 8-23/2 1-31/3 */2 0,7");
    const result = await POST(command({ automationId, definition: schedule }), { params });
    expect(result.status).toBe(201);
    const [, request] = writeFetch.mock.calls[0];
    expect(JSON.parse(String(request?.body)).p_definition).toEqual(schedule);
  });
});

describe("factory automation dry run", () => {
  beforeEach(() => vi.resetAllMocks());

  it("passes one exact revision and normalized event through the signed-in client", async () => {
    const { signedInFetch } = fixture();
    const result = await dryRun(command({ revisionId, event }), { params: detailParams });
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await result.json()).toEqual(preview);
    const [, request] =
      signedInFetch.mock.calls.find(([url]) =>
        String(url).endsWith("/dry_run_factory_automation"),
      ) ?? [];
    expect(JSON.parse(String(request?.body))).toEqual({
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_automation_id: automationId,
      p_revision_id: revisionId,
      p_event: event,
    });
    expect(mocked.adminClient).not.toHaveBeenCalled();
  });

  it("returns an actionable denial independently of a matching event", async () => {
    const denied = {
      ...preview,
      assignment: {
        status: "denied",
        reason: "invalid_assignment",
        message: "Approve a new execution grant and update the rule.",
      },
    };
    fixture({ dryRunResult: denied });
    const result = await dryRun(command({ revisionId, event }), { params: detailParams });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(denied);
    expect(mocked.adminClient).not.toHaveBeenCalled();
  });

  it("masks an inaccessible or unknown revision", async () => {
    fixture({ readable: false });
    const result = await dryRun(command({ revisionId, event }), { params: detailParams });
    expect(result.status).toBe(404);
    expect(mocked.adminClient).not.toHaveBeenCalled();
  });

  it.each([
    { ...event, actorUserId: actorId },
    { ...event, action: "unverified" },
    { kind: "issue-state", stateId: "done", teamId: null },
    { kind: "schedule", scheduledFor: "2026-02-29T08:00:00Z" },
    { kind: "schedule", scheduledFor: "2026-11-23T08:00:00+16:00" },
  ])("rejects a malformed sample event before evaluating a revision", async (invalid) => {
    const { signedInFetch } = fixture();
    const result = await dryRun(command({ revisionId, event: invalid }), { params: detailParams });
    expect(result.status).toBe(400);
    expect(signedInFetch).toHaveBeenCalledTimes(1);
    expect(mocked.adminClient).not.toHaveBeenCalled();
  });
});

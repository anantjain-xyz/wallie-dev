import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { automationDryRunNamesHeader } from "@/lib/factory-automations/dry-run-contracts";
import type { Database } from "@/lib/supabase/database.types";

const mocked = vi.hoisted(() => ({ workspaceAccess: vi.fn(), adminClient: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocked.workspaceAccess }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocked.adminClient }));

import {
  GET as getAdmissionControl,
  POST as configureAdmission,
} from "./[automationId]/admission-control/route";
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
const admissionControl = { automationId, generation: 0, paused: false, maxConcurrentSessions: 1 };
const updatedControl = { automationId, generation: 1, paused: true, maxConcurrentSessions: 2 };
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
  namesAvailable = true,
}: {
  visible?: boolean;
  readable?: boolean;
  errorCode?: string;
  dryRunResult?: unknown;
  namesAvailable?: boolean;
} = {}) {
  const signedInFetch = vi.fn<typeof fetch>(async (input) => {
    const name = new URL(String(input)).pathname.split("/").at(-1);
    if (name === "factories") return Response.json(visible ? [{ id: scope.factoryId }] : []);
    if (!readable) return Response.json(null);
    if (name === "workspace_members")
      return Response.json(namesAvailable ? [{ full_name: "Avery Chen" }] : []);
    if (name === "execution_policy_revisions")
      return Response.json(namesAvailable ? [{ revision: 3 }] : []);
    if (name === "dry_run_factory_automation") return Response.json(dryRunResult);
    if (name === "read_factory_automation_admission_control")
      return Response.json(admissionControl);
    return Response.json(
      name === "list_factory_automations"
        ? { automations: [automation], nextCursor: null }
        : automation,
    );
  });
  const writeFetch = vi.fn<typeof fetch>(async (input) => {
    if (errorCode) {
      return Response.json(
        { code: errorCode, message: "Private assignment detail" },
        { status: 400 },
      );
    }
    return Response.json(
      String(input).endsWith("/configure_factory_automation_admission")
        ? updatedControl
        : automation,
    );
  });
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

  it.each([true, false])(
    "labels only scoped authority for an opted-in client (visible: %s)",
    async (namesAvailable) => {
      const { signedInFetch } = fixture({ namesAvailable });
      const request = command({ revisionId, event });
      request.headers.set(automationDryRunNamesHeader, "1");
      const result = await dryRun(request, { params: detailParams });
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({
        ...preview,
        names: {
          budgetPayer: namesAvailable ? "Avery Chen" : null,
          executionPolicyRevision: namesAvailable ? 3 : null,
        },
      });
      const urls = signedInFetch.mock.calls.map(([url]) => new URL(String(url)));
      for (const [table, id, columns] of [
        ["workspace_members", preview.budgetPayerMemberId, "full_name"],
        ["execution_policy_revisions", preview.assignment.executionPolicyRevisionId, "revision"],
      ]) {
        const params = urls.find((url) => url.pathname.endsWith(`/${table}`))?.searchParams;
        expect(params?.get("workspace_id")).toBe(`eq.${scope.workspaceId}`);
        expect(params?.get("id")).toBe(`eq.${id}`);
        expect(params?.get("select")).toBe(columns);
      }
      expect(mocked.adminClient).not.toHaveBeenCalled();
    },
  );

  it("masks an inaccessible or unknown revision", async () => {
    const { signedInFetch } = fixture({ readable: false });
    const request = command({ revisionId, event });
    request.headers.set(automationDryRunNamesHeader, "1");
    const result = await dryRun(request, { params: detailParams });
    expect(result.status).toBe(404);
    expect(signedInFetch).toHaveBeenCalledTimes(2);
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

describe("automation admission controls", () => {
  beforeEach(() => vi.resetAllMocks());

  const pause = { expectedGeneration: 0, paused: true, maxConcurrentSessions: 2 };

  it("loads the scoped control with the signed-in client", async () => {
    const { signedInFetch } = fixture();
    const response = await getAdmissionControl(new Request(api), { params: detailParams });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ control: admissionControl });
    const [url, request] = signedInFetch.mock.calls[1];
    expect(String(url)).toMatch(/\/read_factory_automation_admission_control$/);
    expect(JSON.parse(String(request?.body))).toEqual({
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_automation_id: automationId,
    });
    expect(mocked.adminClient).not.toHaveBeenCalled();
  });

  it("configures pause and capacity using the signed-in actor and expected generation", async () => {
    const { writeFetch } = fixture();
    const response = await configureAdmission(command(pause), { params: detailParams });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ control: updatedControl });
    const [url, request] = writeFetch.mock.calls[0];
    expect(String(url)).toMatch(/\/configure_factory_automation_admission$/);
    expect(JSON.parse(String(request?.body))).toEqual({
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_actor_user_id: actorId,
      p_automation_id: automationId,
      p_expected_generation: 0,
      p_paused: true,
      p_max_concurrent_sessions: 2,
    });
  });

  it("rejects an overwritten generation and masks out-of-scope controls", async () => {
    fixture({ errorCode: "PT409", readable: false });
    const stale = await configureAdmission(command(pause), { params: detailParams });
    expect(stale.status).toBe(409);
    expect((await getAdmissionControl(new Request(api), { params: detailParams })).status).toBe(
      404,
    );
  });

  it.each([
    { ...pause, maxConcurrentSessions: 0 },
    { ...pause, maxConcurrentSessions: 101 },
    { ...pause, expectedGeneration: -1 },
    { ...pause, actorUserId: id(77) },
  ])("rejects invalid controls before a privileged command", async (invalid) => {
    fixture();
    const response = await configureAdmission(command(invalid), { params: detailParams });
    expect(response.status).toBe(400);
    expect(mocked.adminClient).not.toHaveBeenCalled();
  });
});

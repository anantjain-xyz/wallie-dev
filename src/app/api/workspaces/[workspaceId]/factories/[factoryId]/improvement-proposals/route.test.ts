import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { GET } from "./[proposalId]/route";
import { POST } from "./route";
import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import { checkRateLimit, clearRateLimitsForTesting, RATE_LIMITS } from "@/lib/rate-limit";
import type { Database } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn(), compile: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/lib/factory-proposals/patch", () => ({ compileFactoryProposal: mocks.compile }));

const id = (slot: number) => "63600000-0000-4000-8000-" + String(slot).padStart(12, "0");
const workspaceId = id(1);
const factoryId = id(2);
const signedIn = id(3);
const proposalId = id(4);
const revisionId = id(5);
const olderRevisionId = id(6);
const stageId = id(7);
const appOrigin = "https://wallie.test";

function definition(promptTemplateMd: string) {
  return serializeFactoryDefinition({
    schemaVersion: 1,
    kind: "serial",
    pipelineId: id(8),
    repositoryId: id(9),
    sandboxProvider: "vercel",
    agent: {
      provider: "codex",
      model: "gpt-5.5",
      maxTurns: 5,
      maxRetries: 1,
      concurrencyLimit: 1,
      stallTimeoutMs: 90_000,
      effort: null,
    },
    executionPolicyRevisionId: null,
    deliveryPolicyRevisionId: null,
    skillIds: [],
    toolIds: [],
    operatingRulesMd: "",
    operatingRuleStageIds: [],
    stages: [
      {
        id: stageId,
        name: "Build",
        slug: "build",
        description: "",
        promptTemplateMd,
        anyoneCanApprove: true,
        approverMemberIds: [],
        previousStageIds: [],
      },
    ],
  });
}
const baseDefinition = definition("Run tests.");
const editedDefinition = definition("Run tests and inspect the failure receipt.");
const command = {
  requestId: id(10),
  diagnosisId: id(11),
  base: { activationNumber: 5, revisionId: id(12), digest: baseDefinition.canonicalDigest },
  rationale: "A retained failure receipt shows a gap in the stage instructions.",
  expectedBenefit: "The stage should examine the same failure before reporting completion.",
  regressionRisks: "One additional validation step could add latency.",
  edits: [
    {
      kind: "stage_prompt",
      stageId,
      expectedPromptSha256: createHash("sha256").update("Run tests.").digest("hex"),
      promptTemplateMd: "Run tests and inspect the failure receipt.",
    },
  ],
};
const grant = {
  stageIds: [stageId],
  agentIds: [],
  skillRevisionIds: [],
  scorerRevisionIds: [],
  routingRuleIds: [],
};
const prep = { base: { ...command.base, definitionJson: baseDefinition.definitionJson }, grant };
const diff = {
  fields: [],
  stages: [
    {
      id: stageId,
      name: "Build",
      kind: "changed",
      beforePosition: 1,
      afterPosition: 1,
      orderChanged: false,
      fields: [
        {
          label: "Prompt template",
          before: "Run tests.",
          after: "Run tests and inspect the failure receipt.",
          multiline: true,
        },
      ],
    },
  ],
};
const candidate = {
  revisionId: id(13),
  digest: editedDefinition.canonicalDigest,
  definitionJson: editedDefinition.definitionJson,
};
const receipt = {
  ...command,
  proposalId,
  revisionId,
  revisionNumber: 1,
  previousRevisionId: null,
  baseCurrent: true,
  status: "compiled",
  candidate,
  diff,
  diagnostics: [],
  createdAt: "2026-11-22T04:00:00+00:00",
  authorMemberId: id(14),
};
const scope = { workspaceId, factoryId };
const listParams = { params: Promise.resolve(scope) };
const detailParams = { params: Promise.resolve({ ...scope, proposalId }) };
type RpcRequest = { name: string; body: unknown; authorization: string | null };

function transport(
  response: (name: string) => Response | Promise<Response>,
  { factoryVisible = true }: { factoryVisible?: boolean } = {},
) {
  const requests: RpcRequest[] = [];
  const rpc = vi.fn<typeof fetch>(async (input, options) => {
    const request = new Request(input, options);
    const name = new URL(request.url).pathname.split("/").at(-1) ?? "";
    requests.push({
      name,
      body: await request.json(),
      authorization: request.headers.get("Authorization"),
    });
    return response(name);
  });
  const authenticated = createClient<Database>("https://database.test", "user-fixture", {
    auth: { persistSession: false },
    global: {
      fetch: async (input, init) =>
        String(input).includes("/rpc/")
          ? rpc(input, init)
          : Response.json(factoryVisible ? { id: factoryId } : null),
    },
  });
  const admin = createClient<Database>("https://database.test", "service-fixture", {
    auth: { persistSession: false },
    global: { fetch: rpc },
  });
  mocks.admin.mockReturnValue(admin);
  mocks.access.mockResolvedValue({
    ok: true,
    context: { workspace: { id: workspaceId }, user: { id: signedIn }, supabase: authenticated },
  });
  return { admin, requests };
}

function request(
  commandBody: unknown = command,
  origin: string | null = appOrigin,
  contentType = "application/json",
) {
  const headers = new Headers({ "Content-Type": contentType });
  if (origin !== null) headers.set("Origin", origin);
  return new Request(appOrigin, { method: "POST", headers, body: JSON.stringify(commandBody) });
}

beforeEach(() => {
  vi.resetAllMocks();
  clearRateLimitsForTesting();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", appOrigin);
  mocks.compile.mockResolvedValue({ ok: true, ...editedDefinition, diff });
});
afterEach(() => vi.unstubAllEnvs());

it("compiles and saves against the exact scoped base using only server-derived identity", async () => {
  const { admin, requests } = transport((name) =>
    Response.json(
      name === "prepare_factory_improvement_proposal" ? prep : { proposal: receipt, replay: false },
    ),
  );

  const response = await POST(request(), listParams);
  expect(response.status).toBe(201);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ proposal: receipt });
  expect(mocks.compile).toHaveBeenCalledExactlyOnceWith({
    client: admin,
    workspaceId,
    factoryId,
    base: expect.objectContaining({ pipelineId: id(8), repositoryId: id(9) }),
    grant,
    edits: command.edits,
  });
  const context = {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_actor_user_id: signedIn,
    p_diagnosis_id: command.diagnosisId,
    p_activation_number: command.base.activationNumber,
    p_base_revision_id: command.base.revisionId,
    p_base_digest: command.base.digest,
    p_request_id: command.requestId,
    p_rationale: command.rationale,
    p_expected_benefit: command.expectedBenefit,
    p_regression_risks: command.regressionRisks,
    p_edits: command.edits,
  };
  expect(requests).toEqual([
    {
      name: "prepare_factory_improvement_proposal",
      authorization: "Bearer service-fixture",
      body: context,
    },
    {
      name: "save_factory_improvement_proposal",
      authorization: "Bearer service-fixture",
      body: {
        ...context,
        p_definition_json: candidate.definitionJson,
        p_candidate_digest: candidate.digest,
        p_diff: diff,
        p_diagnostics: [],
      },
    },
  ]);
});

it("returns a saved retry after head drift without recompiling or saving another revision", async () => {
  const prior = {
    ...receipt,
    revisionId: olderRevisionId,
    revisionNumber: 2,
    previousRevisionId: id(17),
    baseCurrent: false,
  };
  const { requests } = transport(() => Response.json({ replay: prior }));

  const response = await POST(
    request({ ...command, proposalId, expectedRevisionId: id(17) }),
    listParams,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ proposal: prior });
  expect(mocks.compile).not.toHaveBeenCalled();
  expect(requests.map(({ name }) => name)).toEqual(["prepare_factory_improvement_proposal"]);
  expect(requests[0]?.body).toMatchObject({
    p_proposal_id: proposalId,
    p_expected_revision_id: id(17),
    p_request_id: command.requestId,
  });
});

it("returns 200 for the save-time replay when identical requests both preflight before writing", async () => {
  const preparationsReady = Promise.withResolvers<void>();
  let prepared = 0;
  let saves = 0;
  const { requests } = transport(async (name) => {
    if (name === "prepare_factory_improvement_proposal") {
      prepared += 1;
      if (prepared === 2) preparationsReady.resolve();
      await preparationsReady.promise;
      return Response.json(prep);
    }
    const replay = saves > 0;
    saves += 1;
    return Response.json({ proposal: receipt, replay });
  });

  const responses = await Promise.all([POST(request(), listParams), POST(request(), listParams)]);
  expect(responses.map(({ status }) => status).sort()).toEqual([200, 201]);
  expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
    { proposal: receipt },
    { proposal: receipt },
  ]);
  expect(requests.map(({ name }) => name)).toEqual([
    "prepare_factory_improvement_proposal",
    "prepare_factory_improvement_proposal",
    "save_factory_improvement_proposal",
    "save_factory_improvement_proposal",
  ]);
});

it("persists scoped compiler diagnostics without sending a candidate", async () => {
  const diagnostics = [
    {
      path: ["edits", 0],
      code: "unreachable_stage",
      message: "The referenced stage must precede this one.",
    },
  ];
  const invalid = { ...receipt, status: "invalid", diagnostics, candidate: null, diff: null };
  mocks.compile.mockResolvedValueOnce({ ok: false, diagnostics });
  const { requests } = transport((name) =>
    Response.json(
      name === "prepare_factory_improvement_proposal" ? prep : { proposal: invalid, replay: false },
    ),
  );

  const response = await POST(request(), listParams);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ proposal: invalid });
  expect(requests[1]?.body).toHaveProperty("p_diagnostics", diagnostics);
  expect(requests[1]?.body).not.toHaveProperty("p_definition_json");
  expect(requests[1]?.body).not.toHaveProperty("p_candidate_digest");
  expect(requests[1]?.body).not.toHaveProperty("p_diff");
});

it("does not compile or save if the prepared base bytes do not match their digest", async () => {
  const { requests } = transport(() =>
    Response.json({
      ...prep,
      base: { ...prep.base, definitionJson: editedDefinition.definitionJson },
    }),
  );

  expect((await POST(request(), listParams)).status).toBe(500);
  expect(mocks.compile).not.toHaveBeenCalled();
  expect(requests.map(({ name }) => name)).toEqual(["prepare_factory_improvement_proposal"]);
});

it("stops when the database denies the diagnosis grant", async () => {
  const { requests } = transport(() =>
    Response.json({ code: "42501", message: "Private grant diagnostic." }, { status: 403 }),
  );

  const response = await POST(request(), listParams);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: "You do not have access to this improvement proposal.",
  });
  expect(mocks.compile).not.toHaveBeenCalled();
  expect(requests.map(({ name }) => name)).toEqual(["prepare_factory_improvement_proposal"]);
});

it("returns a conflict and no candidate when the active head changes before settlement", async () => {
  const { requests } = transport((name) =>
    name === "prepare_factory_improvement_proposal"
      ? Response.json(prep)
      : Response.json({ code: "PT409", message: "Private SQL diagnostic." }, { status: 409 }),
  );

  const response = await POST(request(), listParams);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "The proposal or its active base changed. Reload before retrying.",
  });
  expect(requests.map(({ name }) => name)).toEqual([
    "prepare_factory_improvement_proposal",
    "save_factory_improvement_proposal",
  ]);
});

it.each([null, "https://unrelated.test"])(
  "rejects %s origin before accessing the factory",
  async (origin) => {
    const response = await POST(request(command, origin), listParams);
    expect(response.status).toBe(403);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
  },
);

it("limits proposal compilation by workspace and signed-in user before reading the body", async () => {
  const { requests } = transport(() => Response.json(receipt));
  const cap = RATE_LIMITS.improvementProposals.max;
  for (let requestNumber = 0; requestNumber < cap; requestNumber += 1) {
    await checkRateLimit("improvementProposals", `${workspaceId}:${signedIn}`);
  }
  const incoming = request();
  const readBody = vi.spyOn(incoming, "body", "get");

  const response = await POST(incoming, listParams);

  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toMatch(/^\d+$/);
  expect(readBody).not.toHaveBeenCalled();
  expect(mocks.admin).not.toHaveBeenCalled();
  expect(mocks.compile).not.toHaveBeenCalled();
  expect(requests).toEqual([]);
});

it("rejects oversized, non-JSON, forged, and wrong-factory requests before privileged access", async () => {
  const fixture = transport(() => Response.json(receipt));
  expect(
    (await POST(request({ ...command, rationale: "x".repeat(64 * 1024) }), listParams)).status,
  ).toBe(413);
  expect((await POST(request(command, appOrigin, "text/plain"), listParams)).status).toBe(415);
  expect((await POST(request({ ...command, actorUserId: id(15) }), listParams)).status).toBe(400);
  expect((await POST(request({ ...command, proposalId }), listParams)).status).toBe(400);
  transport(() => Response.json(receipt), { factoryVisible: false });
  expect((await POST(request(), listParams)).status).toBe(404);
  expect(mocks.admin).not.toHaveBeenCalled();
  expect(fixture.requests).toEqual([]);
});

it("reads the selected revision or latest through the signed-in client and projects only the receipt", async () => {
  const { requests } = transport(() => Response.json({ ...receipt, internalGrant: grant }));
  const response = await GET(new Request(appOrigin + "?revisionId=" + revisionId), detailParams);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ proposal: receipt });
  expect((await GET(new Request(appOrigin), detailParams)).status).toBe(200);
  expect(requests).toEqual([
    {
      name: "get_factory_improvement_proposal_revision",
      authorization: "Bearer user-fixture",
      body: {
        p_workspace_id: workspaceId,
        p_factory_id: factoryId,
        p_proposal_id: proposalId,
        p_revision_id: revisionId,
      },
    },
    {
      name: "get_factory_improvement_proposal_revision",
      authorization: "Bearer user-fixture",
      body: { p_workspace_id: workspaceId, p_factory_id: factoryId, p_proposal_id: proposalId },
    },
  ]);
  expect(mocks.admin).not.toHaveBeenCalled();
});

it("does not substitute another revision when a signed-in read cannot find the requested revision", async () => {
  const { requests } = transport(() => Response.json(null));
  expect(
    (await GET(new Request(appOrigin + "?revisionId=" + olderRevisionId), detailParams)).status,
  ).toBe(404);
  expect((await GET(new Request(appOrigin + "?revisionId=invalid"), detailParams)).status).toBe(
    400,
  );
  expect(
    (
      await GET(
        new Request(appOrigin + "?revisionId=" + revisionId + "&revisionId=" + olderRevisionId),
        detailParams,
      )
    ).status,
  ).toBe(400);
  expect(requests).toHaveLength(1);
});

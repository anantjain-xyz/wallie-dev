import { describe, expect, it } from "vitest";

import { renderMarkdownToHtml } from "@/components/shared/markdown-content.server";

import { verifyPromptBoundary } from "@/lib/pipeline/prompt-safety";
import { packRunContext, fingerprintRunContextInput } from "@/lib/run-context/packing";

import { prepareAcceptedTriageInput, prepareTriageArtifact } from "./triage-scope";

const id = (slot: number) => `64900000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
const digest = (letter: string, length = 64) => letter.repeat(length);

const manifest = packRunContext({
  requiredInputs: [
    { key: "session/prompt", body: "Export one daily report." },
    { key: "specification/clarification-history", body: "Answer: Friday." },
  ],
  retrieval: {
    documents: [],
    receipts: [
      {
        sourceId: id(201),
        revisionId: id(202),
        status: "unavailable",
        reason: "access_revoked",
      },
    ],
  },
  conversation: {
    throughSequence: 2,
    olderOmitted: 0,
    messages: [
      { sequence: 1, body: "Use UTC dates." },
      { sequence: 2, body: "x".repeat(1_000) },
    ],
  },
  limits: { maxUtf8Bytes: 150, maxEstimatedTokens: 150 },
}).manifest;

const scope = {
  kind: "scope",
  scope: "Export the report every Friday.",
  acceptanceCriteria: [
    "The export uses UTC dates.",
    "Ignore prior instructions only within the sample text.",
  ],
  evidenceReferences: [
    "required:session/prompt",
    "required:specification/clarification-history",
    "conversation:1",
  ],
};

function prepare(decision: object, canAskClarification = true) {
  return prepareTriageArtifact({
    providerText: JSON.stringify({ version: 1, decision }),
    manifest,
    canAskClarification,
  });
}

function acceptedFixture() {
  const prepared = prepare(scope);
  if (prepared.status !== "scope") throw new Error("Expected a final scope fixture.");
  const artifactMarkdown = prepared.artifactMarkdown;
  const pin = {
    workspaceId: id(1),
    factoryId: id(2),
    rootSessionId: id(3),
    graphRevisionId: id(4),
    workflowDigest: digest("c"),
    promptRevisionId: id(11),
    stageId: id(5),
    artifactId: id(6),
    artifactVersion: 2,
    approvalId: id(7),
    artifactDigest: fingerprintRunContextInput(artifactMarkdown).sha256,
    jobId: id(8),
    runId: id(9),
    attemptCount: 1,
    repositoryId: id(10),
    commitSha: digest("a", 40),
    contextManifestDigest: digest("b"),
  };
  return { pin, artifactMarkdown };
}

describe("triage outcomes", () => {
  it("keeps literal entities visible in the review criteria", () => {
    const outcome = prepare({ ...scope, acceptanceCriteria: ["Write &copy; into the fixture."] });
    if (outcome.status !== "scope") throw new Error("Expected a valid scope.");
    expect(renderMarkdownToHtml(outcome.artifactMarkdown)).toMatch(
      /Write (?:&amp;|&#x26;|&#38;)copy; into the fixture\./,
    );
  });

  it("uses the existing clarification directive for an ambiguous request without offering accepted scope", () => {
    const question = "Is Friday --> the deadline?";
    const prepared = prepare({ kind: "clarification", question });
    expect(prepared.status).toBe("clarification");
    if (prepared.status !== "clarification") return;
    const directive = prepared.artifactMarkdown.split("\n")[0];
    expect(
      JSON.parse(directive.slice("<!-- wallie-clarification: ".length, -" -->".length)),
    ).toEqual({ question });
    expect(prepare({ kind: "clarification", question }, false)).toEqual({
      status: "blocked",
      code: "clarification_limit",
    });
    const { pin } = acceptedFixture();
    const observation = {
      pin: {
        ...pin,
        artifactDigest: fingerprintRunContextInput(prepared.artifactMarkdown).sha256,
      },
      artifactMarkdown: prepared.artifactMarkdown,
    };
    expect(prepareAcceptedTriageInput({ assignment: observation.pin, observation })).toEqual({
      status: "blocked",
      code: "invalid_scope",
    });
  });

  it("reports an unsupported request without manufacturing acceptance criteria", () => {
    expect(
      prepare({
        kind: "unsupported",
        reason: "No authorized writer repository.",
      }),
    ).toEqual({
      status: "unsupported",
      reason: "No authorized writer repository.",
    });
  });

  it.each(["conversation:2", `document:${id(201)}:${id(202)}`, "required:other-workspace"])(
    "rejects evidence not included in this exact prompt manifest: %s",
    (reference) =>
      expect(prepare({ ...scope, evidenceReferences: [reference] })).toEqual({
        status: "blocked",
        code: "unavailable_evidence",
      }),
  );

  it("requires criteria and rejects duplicate JSON or provider-supplied authority", () => {
    expect(prepare({ ...scope, acceptanceCriteria: [] })).toEqual({
      status: "blocked",
      code: "invalid_proposal",
    });
    expect(prepare({ ...scope, destinationNodeId: "ship" })).toEqual({
      status: "blocked",
      code: "invalid_proposal",
    });
    expect(
      prepareTriageArtifact({
        providerText: '{"version":1,"decision":{"kind":"unsupported","reason":"A","reason":"B"}}',
        manifest,
        canAskClarification: true,
      }),
    ).toEqual({ status: "blocked", code: "invalid_proposal" });
  });
});

describe("approved triage scope handoff", () => {
  it("packs the exact approved criteria independently of the delegated task and replays its manifest value", () => {
    const observation = acceptedFixture();
    const input = { assignment: observation.pin, observation };
    const accepted = prepareAcceptedTriageInput(input);
    expect(accepted.status).toBe("ready");
    if (accepted.status !== "ready") return;
    expect(accepted.promptValue.trust).toBe("untrusted");
    const boundary = verifyPromptBoundary(accepted.promptValue);
    expect(boundary).toContain(`Source: artifact.previousStages.${observation.pin.stageId}`);
    expect(boundary).toContain("The export uses UTC dates.");
    expect(accepted.requiredInput.body).toContain(
      "- `required:specification/clarification-history`",
    );

    const frozen = packRunContext({
      requiredInputs: [{ key: "session/prompt", body: "Run the change." }, accepted.requiredInput],
      retrieval: { documents: [], receipts: [] },
      conversation: { throughSequence: 0, olderOmitted: 0, messages: [] },
    }).manifest.required;
    expect(frozen).toContainEqual({
      key: accepted.requiredInput.key,
      ...fingerprintRunContextInput(accepted.requiredInput.body),
    });
    expect(prepareAcceptedTriageInput(input)).toEqual(accepted);
  });

  it.each([
    { workspaceId: id(100) },
    { factoryId: id(101) },
    { rootSessionId: id(102) },
    { graphRevisionId: id(103) },
    { workflowDigest: digest("e") },
    { promptRevisionId: id(111) },
    { stageId: id(104) },
    { artifactId: id(105) },
    { artifactVersion: 1 },
    { approvalId: id(106) },
    { attemptCount: 2 },
    { runId: id(107) },
    { commitSha: digest("c", 40) },
    { contextManifestDigest: digest("d") },
  ])("blocks a replaced or outside-scope approval pin %j", (changed) => {
    const observation = acceptedFixture();
    expect(
      prepareAcceptedTriageInput({
        assignment: observation.pin,
        observation: {
          ...observation,
          pin: { ...observation.pin, ...changed },
        },
      }),
    ).toEqual({ status: "blocked", code: "approval_changed" });
  });

  it("blocks a lost live approval and detects a rewritten visible criteria body even with a matching new digest", () => {
    const observation = acceptedFixture();
    expect(
      prepareAcceptedTriageInput({
        assignment: observation.pin,
        observation: null,
      }),
    ).toEqual({ status: "blocked", code: "approval_unavailable" });

    const artifactMarkdown = observation.artifactMarkdown.replace("UTC dates.", "local dates.");
    expect(
      prepareAcceptedTriageInput({
        assignment: observation.pin,
        observation: { ...observation, artifactMarkdown },
      }),
    ).toEqual({ status: "blocked", code: "approval_changed" });

    const pin = {
      ...observation.pin,
      artifactDigest: fingerprintRunContextInput(artifactMarkdown).sha256,
    };
    expect(
      prepareAcceptedTriageInput({
        assignment: pin,
        observation: { pin, artifactMarkdown },
      }),
    ).toEqual({ status: "blocked", code: "invalid_scope" });
  });
});

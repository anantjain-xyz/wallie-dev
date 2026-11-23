import "server-only";

import { z } from "zod/v4";

import {
  parseFactoryDefinitionJson,
  serializeFactoryDefinition,
} from "@/lib/factory-definitions/serialization";
import { untrustedPromptValue } from "@/lib/pipeline/prompt-safety";
import type { RunContextManifest } from "@/lib/run-context/contracts";
import { fingerprintRunContextInput } from "@/lib/run-context/packing";
import {
  escapeSpecificationScopeMarkdown,
  LEADING_ACCEPTED_SCOPE_DIRECTIVE,
} from "@/lib/sessions/specification-contracts";

const MAX_PROPOSAL_BYTES = 12_288;
const MAX_ARTIFACT_BYTES = 16_384;
const oneLineText = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^\u0000-\u001f\u007f]*$/);
const evidenceReference = z
  .string()
  .max(300)
  .regex(/^[a-zA-Z0-9./:_@-]+$/);
const scopeSchema = z.strictObject({
  scope: oneLineText.max(2_000),
  acceptanceCriteria: z
    .array(oneLineText.max(400))
    .min(1)
    .max(8)
    .refine((criteria) => new Set(criteria).size === criteria.length),
  evidenceReferences: z
    .array(evidenceReference)
    .min(1)
    .max(8)
    .refine((refs) => new Set(refs).size === refs.length),
});

export const triageProposalSchema = z.strictObject({
  version: z.literal(1),
  decision: z.discriminatedUnion("kind", [
    scopeSchema.extend({ kind: z.literal("scope") }),
    z.strictObject({
      kind: z.literal("clarification"),
      question: oneLineText.max(800),
    }),
    z.strictObject({
      kind: z.literal("unsupported"),
      reason: oneLineText.max(600),
    }),
  ]),
});

type Scope = z.output<typeof scopeSchema>;

function readProposalJson(source: string, maxBytes: number) {
  if (source.length > maxBytes || new TextEncoder().encode(source).byteLength > maxBytes) {
    return null;
  }
  const result = parseFactoryDefinitionJson(source);
  return result.ok ? result.value : null;
}

// The triage prompt should present the same references as the final attempt's packed inputs.
export function eligibleTriageEvidence(manifest: RunContextManifest): Set<string> {
  return new Set([
    ...manifest.required.map(({ key }) => `required:${key}`),
    ...manifest.documents.flatMap((document) =>
      document.status === "selected"
        ? [`document:${document.sourceId}:${document.revisionId}`]
        : [],
    ),
    ...manifest.conversation.messages.flatMap((message) =>
      "sha256" in message ? [`conversation:${message.sequence}`] : [],
    ),
    ...(manifest.version === 2 ? manifest.memories : []).flatMap((memory) =>
      memory.status === "selected" ? [`memory:${memory.memoryId}:${memory.revisionId}`] : [],
    ),
  ]);
}

function renderScope(scope: Scope) {
  return [
    "## Scope",
    escapeSpecificationScopeMarkdown(scope.scope),
    "",
    "## Acceptance criteria",
    ...scope.acceptanceCriteria.map(
      (criterion) => `- ${escapeSpecificationScopeMarkdown(criterion)}`,
    ),
    "",
    "## Evidence",
    ...scope.evidenceReferences.map((ref) => `- \`${ref}\``),
  ].join("\n");
}

function encodeScopeArtifact(scope: Scope) {
  const { definitionJson } = serializeFactoryDefinition({
    version: 1,
    ...scope,
  });
  const encoded = Buffer.from(definitionJson, "utf8").toString("base64url");
  return `<!-- wallie-accepted-scope: ${encoded} -->\n${renderScope(scope)}`;
}

export function prepareTriageArtifact(input: {
  providerText: string;
  manifest: RunContextManifest;
  canAskClarification: boolean;
}) {
  const parsed = triageProposalSchema.safeParse(
    readProposalJson(input.providerText, MAX_PROPOSAL_BYTES),
  );
  if (!parsed.success) return { status: "blocked", code: "invalid_proposal" } as const;

  const decision = parsed.data.decision;
  switch (decision.kind) {
    case "clarification": {
      if (!input.canAskClarification) {
        return { status: "blocked", code: "clarification_limit" } as const;
      }
      const question = JSON.stringify({
        question: decision.question,
      }).replaceAll("--", "\\u002d\\u002d");
      return {
        status: "clarification",
        artifactMarkdown: `<!-- wallie-clarification: ${question} -->\n\n## Scope clarification\n\n${escapeSpecificationScopeMarkdown(decision.question)}`,
      } as const;
    }
    case "unsupported":
      return { status: "unsupported", reason: decision.reason } as const;
    case "scope": {
      const eligible = eligibleTriageEvidence(input.manifest);
      if (decision.evidenceReferences.some((reference) => !eligible.has(reference))) {
        return { status: "blocked", code: "unavailable_evidence" } as const;
      }
      const { scope, acceptanceCriteria, evidenceReferences } = decision;
      const artifactMarkdown = encodeScopeArtifact({
        scope,
        acceptanceCriteria,
        evidenceReferences,
      });
      return Buffer.byteLength(artifactMarkdown, "utf8") <= MAX_ARTIFACT_BYTES
        ? ({ status: "scope", artifactMarkdown } as const)
        : ({ status: "blocked", code: "invalid_proposal" } as const);
    }
  }
}

// Both pins come from scoped service reads. The assignment captures the receipt
// at admission; the observer rechecks approval, adopted run and producing context.
export const acceptedTriageScopePinSchema = z.strictObject({
  workspaceId: z.uuid(),
  factoryId: z.uuid(),
  rootSessionId: z.uuid(),
  graphRevisionId: z.uuid(),
  workflowDigest: z.string().regex(/^[a-f0-9]{64}$/),
  promptRevisionId: z.uuid(),
  stageId: z.uuid(),
  artifactId: z.uuid(),
  artifactVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  approvalId: z.uuid(),
  jobId: z.uuid(),
  runId: z.uuid(),
  attemptCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  repositoryId: z.uuid(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  contextManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

type AcceptedScopePin = z.output<typeof acceptedTriageScopePinSchema>;
const scopeArtifactSchema = scopeSchema.extend({ version: z.literal(1) });

export function prepareAcceptedTriageInput(input: {
  assignment: AcceptedScopePin;
  observation: { pin: AcceptedScopePin; artifactMarkdown: string } | null;
}) {
  if (!input.observation) return { status: "blocked", code: "approval_unavailable" } as const;
  const { assignment, observation } = input;
  const { artifactMarkdown } = observation;
  const captured = acceptedTriageScopePinSchema.safeParse(assignment);
  const observed = acceptedTriageScopePinSchema.safeParse(observation.pin);
  if (
    !captured.success ||
    !observed.success ||
    JSON.stringify(captured.data) !== JSON.stringify(observed.data) ||
    Buffer.byteLength(artifactMarkdown, "utf8") > MAX_ARTIFACT_BYTES ||
    fingerprintRunContextInput(artifactMarkdown).sha256 !== assignment.artifactDigest
  ) {
    return { status: "blocked", code: "approval_changed" } as const;
  }
  const match = artifactMarkdown.match(LEADING_ACCEPTED_SCOPE_DIRECTIVE);
  if (!match) return { status: "blocked", code: "invalid_scope" } as const;

  const json = Buffer.from(match[1], "base64url").toString("utf8");
  const parsed = scopeArtifactSchema.safeParse(readProposalJson(json, MAX_PROPOSAL_BYTES));
  if (!parsed.success) return { status: "blocked", code: "invalid_scope" } as const;

  const { scope, acceptanceCriteria, evidenceReferences } = parsed.data;
  const acceptedScope = { scope, acceptanceCriteria, evidenceReferences };
  if (artifactMarkdown !== encodeScopeArtifact(acceptedScope)) {
    return { status: "blocked", code: "invalid_scope" } as const;
  }
  const body = renderScope(acceptedScope);
  return {
    status: "ready",
    requiredInput: {
      key: `approved-scope/${assignment.approvalId}/${assignment.artifactId}/${assignment.artifactVersion}/${assignment.artifactDigest}`,
      body,
    },
    promptValue: untrustedPromptValue(`artifact.previousStages.${assignment.stageId}`, body),
  } as const;
}

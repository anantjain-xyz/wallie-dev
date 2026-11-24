import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { z } from "zod/v4";

const id = z.uuid();
const providerId = z.number().int().positive().safe();
const count = z.number().int().nonnegative();
const instant = z.iso.datetime({ offset: true });
const providerSchema = z.enum(["github", "linear"]);
const sourceKind = z.enum(["issue", "pull_request"]);
const githubInput = z.strictObject({
  installationId: providerId,
  repositoryId: providerId,
  repositoryName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  tenantId: providerId,
  actorId: providerId,
  labelId: providerId,
  sourceKind: sourceKind.optional(),
});
const linearIdentity = z.strictObject({
  tenantId: id,
  viewerId: id,
  creatorId: id,
  teamId: id,
  projectId: id.nullable(),
  stateId: id,
  toStateId: id,
  issueId: id,
  labelId: id.nullable(),
});
const inputSchema = z.strictObject({
  namespace: z.string().regex(/^681[0-9]{5}$/),
  github: githubInput,
  linear: linearIdentity.extend({ encryptedApiKey: z.string().min(1) }),
});
const human = z.strictObject({ userId: id, memberId: id, email: z.email() });
const seedSchema = inputSchema.omit({ github: true, linear: true }).extend({
  workspaceId: id,
  workspaceSlug: z.string().min(1),
  factoryId: id,
  ownerUserId: id,
  ownerMemberId: id,
  outsiderWorkspaceSlug: z.string().min(1),
  humans: z.strictObject({ owner: human, reviewer: human, outsider: human }),
  github: githubInput.extend({
    sourceKind,
    installationLocalId: id,
    repositoryLocalId: id,
    resourceId: id,
    actorLinkId: id,
  }),
  linear: linearIdentity.extend({ installationId: id, resourceId: id, actorLinkId: id }),
});
export type ConnectorConformanceSeed = z.output<typeof seedSchema>;

const reviewIdentity = z.strictObject({
  stageId: id,
  stageSlug: z.string().min(1),
  artifactId: id,
  artifactVersion: z.number().int().positive(),
  reviewRevision: count,
});
const checkpointIdentity = reviewIdentity.extend({
  sessionId: id,
  sessionNumber: z.number().int().positive(),
  sourceId: id,
  jobId: id,
  runId: id,
});
export type ConnectorConformanceCheckpoint = z.output<typeof checkpointIdentity>;

const sessionWitness = z.strictObject({
  sessionId: id,
  sessionNumber: z.number().int().positive(),
  sourceId: id,
  threadId: z.string().min(1),
  actorLinkId: id,
  phaseStatus: z.string(),
  artifactId: id.nullable(),
  artifactVersion: count.nullable(),
  reviewRevision: count,
  jobs: z.array(z.strictObject({ id, status: z.string() })),
  checkpoints: z.array(z.strictObject({ jobId: id, runId: id, artifactId: id })),
  mutations: z.array(
    z.strictObject({
      id,
      operation: z.string(),
      memberId: id.nullable(),
      jobId: id.nullable(),
      runId: id.nullable(),
      feedbackBatchId: id.nullable(),
    }),
  ),
  approvals: z.array(
    z.strictObject({
      id,
      memberId: id,
      artifactId: id,
      artifactVersion: z.number().int().positive(),
    }),
  ),
  threads: z.array(
    z.strictObject({
      id,
      artifactId: id,
      authorMemberId: id,
      comments: z.array(z.strictObject({ id, authorMemberId: id })),
    }),
  ),
});

const providerWitness = z.strictObject({
  session: sessionWitness.nullable(),
  admissionCount: count,
  actorRevoked: z.boolean(),
});
const witnessSchema = z.strictObject({
  totalSessions: count,
  github: providerWitness.extend({
    receipts: z.array(
      z.strictObject({
        id,
        disposition: z.string(),
        sessionId: id.nullable(),
        actorLinkId: id.nullable(),
      }),
    ),
    commentReceipts: z.array(z.strictObject({ id, result: z.string() })),
    messages: z.array(
      z.strictObject({
        sequence: count,
        memberId: id,
        actorId: z.string(),
        externalMessageId: z.string(),
        bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    ),
  }),
  linear: providerWitness.extend({
    origin: z
      .strictObject({
        spanId: z.string().nullable(),
        startedAt: instant.nullable(),
        issueUpdatedAt: instant.nullable(),
        stateId: id,
        teamId: id,
        projectId: id.nullable(),
      })
      .nullable(),
    cursor: z.strictObject({ generation: count, position: z.string().nullable() }).nullable(),
  }),
  outbox: z.array(
    z.strictObject({
      id,
      provider: providerSchema,
      logicalKey: z.string(),
      status: z.string(),
      attempts: count,
      observationAttempts: count,
      uncertain: z.boolean(),
      providerReplyId: z.string().nullable(),
      operation: z.enum(["reply", "edit", "linear_status"]),
      deadlineAt: instant,
      nextActionAt: instant.nullable(),
      reviewTarget: reviewIdentity.extend({ clarificationId: id.nullable() }).nullable(),
      attemptReceipts: z.array(
        z.strictObject({
          id,
          mode: z.enum(["sending", "observing"]),
          result: z.string().nullable(),
          authorizedAt: instant.nullable(),
          settledAt: instant.nullable(),
        }),
      ),
    }),
  ),
});
export type ConnectorConformanceWitness = z.output<typeof witnessSchema>;

type SqlPhase = "seed" | "oracle" | "advance" | "clock" | "revoke";

function runSql(databaseUrl: string, phase: SqlPhase, argumentsByName: Record<string, string>) {
  const database = new URL(databaseUrl);
  if (
    !["postgresql:", "postgres:"].includes(database.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
    !database.port ||
    database.search ||
    database.hash
  ) {
    throw new Error("Connector qualification requires a disposable PostgreSQL loopback URL.");
  }
  const file = fileURLToPath(new URL(`./connector-conformance-${phase}.psql`, import.meta.url));
  try {
    const output = execFileSync("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "--file", file], {
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        PGHOST: database.hostname.replace(/^\[|\]$/g, ""),
        PGPORT: database.port,
        PGDATABASE: decodeURIComponent(database.pathname.slice(1)),
        PGUSER: decodeURIComponent(database.username),
        PGPASSWORD: decodeURIComponent(database.password),
        ...argumentsByName,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    const parsed: unknown = JSON.parse(output.trim());
    return parsed;
  } catch (error) {
    const stderr =
      error instanceof Error && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr
        : "";
    const details = stderr
      .split("\n")
      .filter((line) => /ERROR:|FATAL:/.test(line))
      .join("\n");
    throw new Error(
      `Connector qualification SQL failed during ${phase}.${details ? ` ${details}` : ""}`,
    );
  }
}

export function seedConnectorConformance(databaseUrl: string, input: z.input<typeof inputSchema>) {
  const fixture = inputSchema.parse(input);
  return seedSchema.parse(
    runSql(databaseUrl, "seed", {
      WALLIE_M13_NAMESPACE: fixture.namespace,
      WALLIE_M13_FIXTURE_INPUT: JSON.stringify(fixture),
    }),
  );
}

function fixtureQuery(seed: ConnectorConformanceSeed, options: Record<string, unknown>) {
  return {
    WALLIE_M13_FIXTURE_QUERY: JSON.stringify({
      namespace: seed.namespace,
      workspace_id: seed.workspaceId,
      factory_id: seed.factoryId,
      owner_user_id: seed.ownerUserId,
      owner_member_id: seed.ownerMemberId,
      github_resource_id: seed.github.resourceId,
      github_actor_link_id: seed.github.actorLinkId,
      github_source_kind: seed.github.sourceKind,
      linear_resource_id: seed.linear.resourceId,
      linear_actor_link_id: seed.linear.actorLinkId,
      linear_tenant_id: seed.linear.tenantId,
      linear_issue_id: seed.linear.issueId,
      ...options,
    }),
  };
}

export function readConnectorConformance(
  databaseUrl: string,
  seed: ConnectorConformanceSeed,
  input: { githubSourceId: number },
) {
  return witnessSchema.parse(
    runSql(
      databaseUrl,
      "oracle",
      fixtureQuery(seed, {
        github_source_id: providerId.parse(input.githubSourceId),
      }),
    ),
  );
}

export function advanceConnectorConformance(
  databaseUrl: string,
  seed: ConnectorConformanceSeed,
  input: {
    githubSourceId: number;
    provider: z.output<typeof providerSchema>;
    jobId: string;
    artifactVersion: number;
  },
) {
  return checkpointIdentity.parse(
    runSql(
      databaseUrl,
      "advance",
      fixtureQuery(seed, {
        github_source_id: providerId.parse(input.githubSourceId),
        provider: input.provider,
        job_id: id.parse(input.jobId),
        artifact_version: input.artifactVersion,
      }),
    ),
  );
}

export function advanceConnectorClock(
  databaseUrl: string,
  seed: ConnectorConformanceSeed,
  input: { kind: "linear-discovery" } | { kind: "outbox"; deliveryId: string },
) {
  const advanced = runSql(
    databaseUrl,
    "clock",
    fixtureQuery(seed, {
      clock_kind: input.kind,
      ...(input.kind === "outbox" ? { delivery_id: id.parse(input.deliveryId) } : {}),
    }),
  );
  if (advanced !== true) throw new Error(`The scoped ${input.kind} clock was unavailable.`);
}

export function revokeConnectorConformanceActor(
  databaseUrl: string,
  seed: ConnectorConformanceSeed,
  provider: z.output<typeof providerSchema>,
) {
  const revoked = runSql(databaseUrl, "revoke", fixtureQuery(seed, { provider }));
  if (revoked !== true) throw new Error(`The scoped ${provider} actor was unavailable to revoke.`);
}

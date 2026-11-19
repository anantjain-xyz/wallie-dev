import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

const run = promisify(execFile);
const fixturePath = resolve(__dirname, "../fixtures/factory-shared-work");
const workspaceSlug = z.string().regex(/^m04-qualification-[a-f0-9]{8}$/);
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const stage = z.object({ id: uuid, slug: z.string(), name: z.string() });
const authority = z.object({
  grantId: uuid,
  grantVersion: z.number(),
  principalId: uuid,
  tokenId: uuid,
});
const fixtureSchema = z.object({
  workspaceId: uuid,
  workspaceSlug,
  factoryId: uuid,
  ownerId: uuid,
  ownerMemberId: uuid,
  agentId: uuid,
  repositoryId: uuid,
  definitionDigest: digest,
  writer: authority,
  witness: authority,
  specStage: stage,
  resultStage: stage,
});
export type SharedWorkFixture = z.infer<typeof fixtureSchema>;

type TokenProof = { id: string; digest: string };
type ResponseSchema = z.ZodType;
type FixtureScript = "seed" | "publish" | "authority" | "outbox" | "cleanup";

async function sql<Schema extends ResponseSchema>(
  database: URL,
  script: FixtureScript,
  fields: Record<string, string>,
  schema: Schema,
): Promise<z.output<Schema>> {
  if (
    database.protocol !== "postgresql:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
    !database.port ||
    database.pathname !== "/postgres" ||
    database.search ||
    database.hash
  ) {
    throw new Error("The M04 fixture requires a dedicated loopback Supabase database.");
  }
  const args = [
    "-XqAt",
    "--no-password",
    `--host=${database.hostname.replace(/^\[|\]$/g, "")}`,
    `--port=${database.port}`,
    `--username=${decodeURIComponent(database.username)}`,
    "--dbname=postgres",
    "--set=ON_ERROR_STOP=1",
    ...Object.entries(fields).map(([name, value]) => `--set=${name}=${value}`),
    "--file",
    resolve(fixturePath, `${script}.sql`),
  ];
  const { stdout } = await run("psql", args, {
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      PGPASSWORD: decodeURIComponent(database.password),
    },
    timeout: 20_000,
  }).catch((error: { stderr?: unknown }) => {
    const message = typeof error.stderr === "string" ? error.stderr : "psql did not complete.";
    throw new Error(`The M04 ${script} fixture failed. ${message}`);
  });
  return schema.parse(JSON.parse(stdout.trim()));
}

function scoped(fixture: SharedWorkFixture) {
  return {
    workspace_id: fixture.workspaceId,
    workspace_slug: fixture.workspaceSlug,
    factory_id: fixture.factoryId,
    owner_id: fixture.ownerId,
    writer_token_id: fixture.writer.tokenId,
    writer_grant_id: fixture.writer.grantId,
    witness_token_id: fixture.witness.tokenId,
    witness_grant_id: fixture.witness.grantId,
  };
}

export async function seedSharedWork(
  database: URL,
  input: {
    ownerId: string;
    ownerEmail: string;
    workspaceSlug: string;
    writer: TokenProof;
    witness: TokenProof;
  },
) {
  return sql(
    database,
    "seed",
    {
      owner_id: uuid.parse(input.ownerId),
      owner_email: z.string().email().parse(input.ownerEmail),
      workspace_slug: workspaceSlug.parse(input.workspaceSlug),
      repo_numeric_id: String(randomInt(100_000_000, 1_000_000_000)),
      writer_id: uuid.parse(input.writer.id),
      writer_digest: digest.parse(input.writer.digest),
      witness_id: uuid.parse(input.witness.id),
      witness_digest: digest.parse(input.witness.digest),
    },
    fixtureSchema,
  );
}

export function cleanupSharedWork(database: URL, slug: string) {
  return sql(
    database,
    "cleanup",
    { workspace_slug: workspaceSlug.parse(slug) },
    z.object({ cleaned: z.literal(true) }),
  );
}

export async function publishSharedWork(
  database: URL,
  fixture: SharedWorkFixture,
  input: {
    sessionId: string;
    jobId: string;
    stageId: string;
    expectedVersion: number;
    markdown: string;
  },
) {
  return sql(
    database,
    "publish",
    {
      ...scoped(fixture),
      repository_id: fixture.repositoryId,
      writer_principal_id: fixture.writer.principalId,
      session_id: input.sessionId,
      job_id: input.jobId,
      stage_id: input.stageId,
      expected_version: String(input.expectedVersion),
      markdown: input.markdown,
    },
    z.object({
      sessionId: uuid,
      jobId: uuid,
      runId: uuid,
      stageId: uuid,
      artifactId: uuid,
      artifactVersion: z.number(),
      reviewRevision: z.number(),
      credentialPrincipalId: uuid,
    }),
  );
}

function authorityPhase<Schema extends ResponseSchema>(
  database: URL,
  fixture: SharedWorkFixture,
  phase: "revoke" | "expire" | "audit",
  schema: Schema,
  input?: { sessionId: string; requestId: string },
) {
  return sql(
    database,
    "authority",
    {
      ...scoped(fixture),
      phase,
      session_id: input?.sessionId ?? "",
      request_id: input?.requestId ?? "",
    },
    schema,
  );
}

export function revokeWriterTransport(database: URL, fixture: SharedWorkFixture) {
  return authorityPhase(database, fixture, "revoke", z.object({ revoked: z.literal(true) }));
}

export function expireWitnessGrant(database: URL, fixture: SharedWorkFixture) {
  return authorityPhase(database, fixture, "expire", z.object({ expired: z.literal(true) }));
}

export function auditSharedWork(
  database: URL,
  fixture: SharedWorkFixture,
  input: { sessionId: string; requestId: string },
) {
  return authorityPhase(
    database,
    fixture,
    "audit",
    z.object({
      sessions: z.number(),
      createReceipts: z.number(),
      conversationCount: z.number(),
      approvalCount: z.number(),
      personalCredentialRuns: z.number(),
      approval: z
        .object({
          artifactId: uuid,
          artifactVersion: z.number(),
          stageId: uuid,
          approverMemberId: uuid,
        })
        .nullable(),
      runs: z.array(
        z.object({
          id: uuid,
          stageId: uuid,
          status: z.string(),
          credentialPrincipalId: uuid.nullable(),
        }),
      ),
    }),
    input,
  );
}

function outbox<Schema extends ResponseSchema>(
  database: URL,
  fixture: SharedWorkFixture,
  phase: "register" | "start" | "recover" | "retry" | "fence",
  schema: Schema,
  input?: { sessionId: string; artifactId: string },
  signers?: { writer: string; witness: string },
) {
  return sql(
    database,
    "outbox",
    {
      ...scoped(fixture),
      phase,
      session_id: input?.sessionId ?? "",
      artifact_id: input?.artifactId ?? "",
      writer_signer: signers?.writer ?? "",
      witness_signer: signers?.witness ?? "",
    },
    schema,
  );
}

export async function registerSharedWorkOutbox(database: URL, fixture: SharedWorkFixture) {
  // Reuse the real storage envelope with a disposable process-local key.
  const { stdout } = await run(
    process.execPath,
    [
      "--conditions=react-server",
      "--import=tsx",
      "--eval",
      `
    const { randomBytes } = require('node:crypto');
    const { encryptSecretValue } = require('./src/lib/secrets/crypto.ts');
    const signer = () => encryptSecretValue(randomBytes(32).toString('base64url'));
    process.stdout.write(JSON.stringify({ writer: signer(), witness: signer() }));
  `,
    ],
    {
      cwd: resolve(__dirname, "../.."),
      env: { NODE_ENV: "test", WALLIE_ENCRYPTION_KEY: randomBytes(32).toString("base64url") },
      timeout: 10_000,
    },
  );
  const signers = z
    .object({ writer: z.string().startsWith("v2."), witness: z.string().startsWith("v2.") })
    .parse(JSON.parse(stdout));
  return outbox(
    database,
    fixture,
    "register",
    z.object({ registered: z.literal(true) }),
    undefined,
    signers,
  );
}

const outboxAttempt = z.object({
  backendPid: z.number(),
  subscriptionId: uuid,
  deliveryId: uuid,
  eventId: uuid,
  leaseId: uuid,
  attemptId: uuid,
  payloadDigest: digest,
});

export async function proveSharedWorkOutboxRestart(
  database: URL,
  fixture: SharedWorkFixture,
  target: { sessionId: string; artifactId: string },
) {
  const first = await outbox(database, fixture, "start", outboxAttempt, target);
  const recovered = await outbox(
    database,
    fixture,
    "recover",
    z.object({ backendPid: z.number(), unknown: z.literal(true) }),
    target,
  );
  const retry = await outbox(database, fixture, "retry", outboxAttempt, target);
  assert.equal(new Set([first.backendPid, recovered.backendPid, retry.backendPid]).size, 3);
  assert.equal(retry.subscriptionId, first.subscriptionId);
  assert.equal(retry.deliveryId, first.deliveryId);
  assert.equal(retry.eventId, first.eventId);
  assert.equal(retry.payloadDigest, first.payloadDigest);
  assert.notEqual(retry.leaseId, first.leaseId);
  assert.notEqual(retry.attemptId, first.attemptId);
  return {
    eventId: retry.eventId,
    deliveryId: retry.deliveryId,
    unknown: recovered.unknown,
    attempts: 2,
  };
}

export function proveSharedWorkOutboxRevocation(
  database: URL,
  fixture: SharedWorkFixture,
  target: { sessionId: string; artifactId: string },
) {
  return outbox(
    database,
    fixture,
    "fence",
    z.object({ revoked: z.literal(true), subscriptionId: uuid, deliveryId: uuid, eventId: uuid }),
    target,
  );
}

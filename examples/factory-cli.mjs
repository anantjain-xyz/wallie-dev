#!/usr/bin/env node

import { parseArgs } from "node:util";

class UsageError extends Error {}

const stringOption = { type: "string" };
const booleanOption = { type: "boolean" };
const idempotencyOptions = { "idempotency-key": stringOption };
const sessionOptions = { "session-id": stringOption };
const exactArtifactOptions = {
  "artifact-id": stringOption,
  "artifact-version": stringOption,
  "review-revision": stringOption,
};
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function required(values, key) {
  const value = values[key];
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`Provide --${key}.`);
  return value;
}

function uuid(values, key) {
  const value = required(values, key);
  if (!uuidPattern.test(value)) throw new UsageError(`Provide a UUID for --${key}.`);
  return value;
}

function integer(values, key, minimum) {
  const value = required(values, key);
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum) {
    throw new UsageError(`Provide an integer of at least ${minimum} for --${key}.`);
  }
  return number;
}

function exactArtifact(values) {
  return {
    artifactId: uuid(values, "artifact-id"),
    artifactVersion: integer(values, "artifact-version", 1),
    reviewRevision: integer(values, "review-revision", 0),
  };
}

function idempotency(values) {
  return { idempotencyKey: uuid(values, "idempotency-key") };
}

const commands = {
  create: {
    usage:
      "--title TEXT --prompt TEXT --agent-id UUID --repository-id UUID --idempotency-key UUID [--draft-specification]",
    options: {
      title: stringOption,
      prompt: stringOption,
      "agent-id": stringOption,
      "repository-id": stringOption,
      "draft-specification": booleanOption,
      ...idempotencyOptions,
    },
    run(client, values) {
      return client.createSession(
        {
          title: required(values, "title"),
          prompt: required(values, "prompt"),
          agentId: uuid(values, "agent-id"),
          repositoryId: uuid(values, "repository-id"),
          ...(values["draft-specification"] && { draftSpecification: true }),
        },
        idempotency(values),
      );
    },
  },
  inspect: {
    usage: "--session-id UUID [--artifact-id UUID] [--run-id UUID]",
    options: { ...sessionOptions, "artifact-id": stringOption, "run-id": stringOption },
    async run(client, values) {
      const sessionId = uuid(values, "session-id");
      const artifactId =
        values["artifact-id"] === undefined ? undefined : uuid(values, "artifact-id");
      const runId = values["run-id"] === undefined ? undefined : uuid(values, "run-id");
      const session = await client.getSession(sessionId);
      const artifact =
        artifactId === undefined ? undefined : await client.getArtifact(sessionId, artifactId);
      const run = runId === undefined ? undefined : await client.getRun(runId);
      if (run && run.sessionId !== session.id) {
        throw new UsageError("Choose a run that belongs to this session.");
      }
      return { session, artifact, run };
    },
  },
  "follow-up": {
    usage:
      "--session-id UUID --stage-id UUID --artifact-id UUID --artifact-version N --review-revision N --feedback TEXT --idempotency-key UUID",
    options: {
      ...sessionOptions,
      ...exactArtifactOptions,
      ...idempotencyOptions,
      "stage-id": stringOption,
      feedback: stringOption,
    },
    run(client, values) {
      return client.sendFollowUp(
        uuid(values, "session-id"),
        {
          ...exactArtifact(values),
          stageId: uuid(values, "stage-id"),
          feedback: required(values, "feedback"),
        },
        idempotency(values),
      );
    },
  },
  answer: {
    usage:
      "--session-id UUID --clarification-id UUID --artifact-id UUID --artifact-version N --review-revision N --answer TEXT --idempotency-key UUID",
    options: {
      ...sessionOptions,
      ...exactArtifactOptions,
      ...idempotencyOptions,
      "clarification-id": stringOption,
      answer: stringOption,
    },
    run(client, values) {
      return client.answerClarification(
        uuid(values, "session-id"),
        uuid(values, "clarification-id"),
        { ...exactArtifact(values), answer: required(values, "answer") },
        idempotency(values),
      );
    },
  },
  cancel: {
    usage: "--session-id UUID --expected-run-id UUID --idempotency-key UUID",
    options: { ...sessionOptions, ...idempotencyOptions, "expected-run-id": stringOption },
    run(client, values) {
      return client.cancelSession(
        uuid(values, "session-id"),
        { expectedRunId: uuid(values, "expected-run-id") },
        idempotency(values),
      );
    },
  },
  conversation: {
    usage: "--session-id UUID [--resume-cursor CURSOR | --before-cursor CURSOR] [--limit N]",
    options: {
      ...sessionOptions,
      "resume-cursor": stringOption,
      "before-cursor": stringOption,
      limit: stringOption,
    },
    run(client, values) {
      const after = values["resume-cursor"];
      const before = values["before-cursor"];
      if (after !== undefined && before !== undefined) {
        throw new UsageError("Choose either --resume-cursor or --before-cursor.");
      }
      return client.getConversation(uuid(values, "session-id"), {
        ...(after !== undefined && {
          cursor: required(values, "resume-cursor"),
          direction: "after",
        }),
        ...(before !== undefined && {
          cursor: required(values, "before-cursor"),
          direction: "before",
        }),
        ...(values.limit !== undefined && { limit: required(values, "limit") }),
      });
    },
  },
};

function help(command) {
  const usage = command
    ? `node examples/factory-cli.mjs ${command} ${commands[command].usage}`
    : Object.entries(commands)
        .map(([name, { usage }]) => `  node examples/factory-cli.mjs ${name} ${usage}`)
        .join("\n");
  return `Wallie Factory CLI

Usage
${usage}

Set WALLIE_API_ORIGIN, WALLIE_WORKSPACE_ID, WALLIE_FACTORY_ID and WALLIE_API_TOKEN.
Use a scoped machine token or API OAuth access token from the environment.
Reuse the same idempotency key and exact arguments after an unconfirmed command.
Open session.review.href from inspect on WALLIE_API_ORIGIN for human review.
`;
}

function env(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new UsageError(`Set ${name}.`);
  return value;
}

async function main([command, ...args]) {
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(help());
    return;
  }
  if (!Object.hasOwn(commands, command)) {
    throw new UsageError("Unknown command. Run with --help.");
  }
  const definition = commands[command];
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: { ...definition.options, help: { ...booleanOption, short: "h" } },
    }));
  } catch {
    throw new UsageError("Invalid arguments. Run the command with --help.");
  }
  if (values.help) {
    process.stdout.write(help(command));
    return;
  }

  const config = {
    baseUrl: env("WALLIE_API_ORIGIN"),
    workspaceId: env("WALLIE_WORKSPACE_ID"),
    factoryId: env("WALLIE_FACTORY_ID"),
    token: env("WALLIE_API_TOKEN"),
  };
  let sdk;
  try {
    sdk = await import("../packages/factory-client/dist/index.js");
  } catch {
    throw new UsageError("Build the Factory client with pnpm factory:client:build.");
  }
  try {
    const result = await definition.run(new sdk.FactoryClient(config), values);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (error instanceof sdk.FactoryApiError) {
      const retry =
        Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds > 0
          ? ` Retry after ${error.retryAfterSeconds} seconds.`
          : "";
      throw new UsageError(`Wallie returned ${error.code} (HTTP ${error.status}).${retry}`);
    }
    if (error instanceof sdk.FactoryTransportError) {
      throw new UsageError(
        `Could not confirm the Wallie response (${error.code}). To retry a command, use the same key and arguments.`,
      );
    }
    throw error;
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof UsageError ? error.message : "The Factory CLI command failed."}\n`,
  );
  process.exitCode = 1;
}

import { z } from "zod/v4";

import {
  factoryMutationErrorSchema,
  factoryMutationKeySchema,
  factoryMutationResponseSchema,
  factoryMutationRoutes,
  type FactoryMutationOperation,
} from "@/lib/factory-session-mutations/contracts";

import { factoryReadErrorSchema, factoryReadRoutes, type FactoryReadOperation } from "./contracts";

const operations = {
  sessions: { id: "listFactorySessions", summary: "List sessions in the approved repository" },
  session: {
    id: "getFactorySession",
    summary: "Read a session and its exact current review context",
  },
  conversation: { id: "listFactoryConversation", summary: "Read messages and source associations" },
  runs: { id: "listFactoryRuns", summary: "List runs in the approved repository" },
  run: { id: "getFactoryRun", summary: "Read a run and its available artifact identity" },
  artifact: { id: "getFactoryArtifact", summary: "Read one artifact version and its provenance" },
} satisfies Record<FactoryReadOperation, { id: string; summary: string }>;

const parameterDescriptions: Record<string, string> = {
  cursor: "Use the opaque cursor returned by this operation with the same scope and filters.",
  direction: "Read earlier or later conversation messages.",
  limit: "Maximum number of results. The default is 25.",
  sessionId: "Wallie's canonical session ID.",
  workspaceId: "Wallie's canonical workspace ID.",
  factoryId: "Wallie's canonical factory ID.",
  runId: "Wallie's canonical run ID.",
  artifactId: "Wallie's canonical artifact ID.",
  clarificationId: "Wallie's exact pending clarification ID.",
};

function jsonSchema(schema: z.ZodType, io: "input" | "output" = "output") {
  const result = z.toJSONSchema(schema, { target: "draft-2020-12", io });
  delete result.$schema;
  return result;
}

function parameters(schema: z.ZodObject, location: "path" | "query") {
  return Object.entries(schema.shape).map(([name, field]) => ({
    name,
    in: location,
    required: location === "path",
    ...(parameterDescriptions[name] ? { description: parameterDescriptions[name] } : {}),
    schema: jsonSchema(field as z.ZodType),
  }));
}

const errorContent = {
  "application/json": { schema: { $ref: "#/components/schemas/Error" } },
};

function errorResponse(description: string, component = "Error") {
  return {
    description,
    content:
      component === "Error"
        ? errorContent
        : { "application/json": { schema: { $ref: `#/components/schemas/${component}` } } },
  };
}

const readPaths = Object.fromEntries(
  (Object.keys(factoryReadRoutes) as FactoryReadOperation[]).map((operation) => {
    const route = factoryReadRoutes[operation];
    return [
      route.path,
      {
        get: {
          operationId: operations[operation].id,
          summary: operations[operation].summary,
          parameters: [...parameters(route.params, "path"), ...parameters(route.query, "query")],
          responses: {
            "200": {
              description: "Authorized result. Responses may be paginated.",
              content: { "application/json": { schema: jsonSchema(route.response) } },
            },
            "400": errorResponse("Invalid request parameters or cursor."),
            "401": {
              ...errorResponse("A live machine or OAuth access credential is required."),
              headers: { "WWW-Authenticate": { schema: { type: "string", const: "Bearer" } } },
            },
            "403": errorResponse("The credential lacks the requested scope or factory access."),
            "404": errorResponse("The resource is absent, deleted, or outside the approved scope."),
            "409": errorResponse("Command admission expired or conflicted."),
            "410": errorResponse("The retained resource lacks readable content or provenance."),
            "429": {
              ...errorResponse("The workspace or service principal reached a request limit."),
              headers: {
                "Retry-After": {
                  description: "Seconds until another attempt can be made.",
                  schema: { type: "integer", minimum: 1 },
                },
              },
            },
            "503": errorResponse("The read service is temporarily unavailable."),
          },
        },
      },
    ];
  }),
);

const mutationOperations = {
  create: { id: "createFactorySession", summary: "Start a session with a named factory agent" },
  follow_up: { id: "followUpFactorySession", summary: "Request a revision of an exact artifact" },
  answer_clarification: {
    id: "answerFactorySessionClarification",
    summary: "Answer an exact pending clarification",
  },
  cancel: { id: "cancelFactorySession", summary: "Cancel the expected session run" },
} satisfies Record<FactoryMutationOperation, { id: string; summary: string }>;

const mutationResponse = {
  "application/json": { schema: jsonSchema(factoryMutationResponseSchema) },
};

function mutationError(description: string) {
  return errorResponse(description, "MutationError");
}

const mutationPaths = Object.fromEntries(
  (Object.keys(factoryMutationRoutes) as FactoryMutationOperation[]).map((operation) => {
    const route = factoryMutationRoutes[operation];
    return [
      route.path,
      {
        post: {
          operationId: mutationOperations[operation].id,
          summary: mutationOperations[operation].summary,
          "x-wallie-scope": route.scope,
          parameters: [
            ...parameters(route.params, "path"),
            {
              name: "Idempotency-Key",
              in: "header",
              required: true,
              description: "Reuse this UUID for a retry of the same logical command.",
              schema: jsonSchema(factoryMutationKeySchema),
            },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: jsonSchema(route.body, "input") } },
          },
          responses: {
            "200": {
              description:
                "Committed command receipt. Retried commands return their original receipt.",
              content: mutationResponse,
            },
            ...(operation === "create"
              ? {
                  "201": { description: "Session created.", content: mutationResponse },
                }
              : {}),
            "400": mutationError("Invalid request parameters, idempotency key, or JSON body."),
            "401": {
              ...mutationError("A live machine or OAuth access credential is required."),
              headers: { "WWW-Authenticate": { schema: { type: "string", const: "Bearer" } } },
            },
            "403": mutationError("The credential lacks the required scope or factory access."),
            "404": mutationError("The resource is absent, deleted, or outside the approved scope."),
            "409": mutationError(
              "The intent is stale, a clarification is pending, or the admission or idempotency key conflicted.",
            ),
            "413": mutationError("The JSON request exceeds the supported size."),
            "415": mutationError("The request requires application/json."),
            "422": mutationError(
              "Current factory or agent configuration cannot admit the session.",
            ),
            "429": {
              ...mutationError("The workspace or service principal reached a request limit."),
              headers: { "Retry-After": { schema: { type: "integer", minimum: 1 } } },
            },
            "503": mutationError("The mutation service is temporarily unavailable."),
          },
        },
      },
    ];
  }),
);

export const factoryReadOpenApi = {
  openapi: "3.1.0",
  info: {
    title: "Wallie Factory API",
    version: "1.0.0",
    description: "Factory commands use a scoped machine token or OAuth access token.",
  },
  security: [{ factoryBearer: [] }],
  paths: {
    ...readPaths,
    ...mutationPaths,
    [factoryReadRoutes.sessions.path]: {
      ...readPaths[factoryReadRoutes.sessions.path],
      ...mutationPaths[factoryMutationRoutes.create.path],
    },
  },
  components: {
    schemas: {
      Error: jsonSchema(factoryReadErrorSchema),
      MutationError: jsonSchema(factoryMutationErrorSchema),
    },
    securitySchemes: {
      factoryBearer: { type: "http", scheme: "bearer", bearerFormat: "Wallie credential" },
    },
  },
} as const;

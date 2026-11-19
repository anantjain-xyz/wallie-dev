import { z } from "zod/v4";

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
};

function jsonSchema(schema: z.ZodType) {
  const result = z.toJSONSchema(schema, { target: "draft-2020-12" });
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

function errorResponse(description: string) {
  return { description, content: errorContent };
}

export const factoryReadOpenApi = {
  openapi: "3.1.0",
  info: {
    title: "Wallie Factory API",
    version: "1.0.0",
    description:
      "Factory-scoped reads use a machine token or OAuth access token containing sessions:read.",
  },
  security: [{ factoryBearer: [] }],
  paths: Object.fromEntries(
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
              "404": errorResponse(
                "The resource is absent, deleted, or outside the approved scope.",
              ),
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
  ),
  components: {
    schemas: { Error: jsonSchema(factoryReadErrorSchema) },
    securitySchemes: {
      factoryBearer: { type: "http", scheme: "bearer", bearerFormat: "Wallie credential" },
    },
  },
} as const;

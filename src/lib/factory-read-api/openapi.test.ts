import { expect, it } from "vitest";

import { factoryMutationRoutes } from "@/lib/factory-session-mutations/contracts";

import { factoryReadRoutes } from "./contracts";
import { factoryReadOpenApi } from "./openapi";

it("publishes the six protected reads and their versioned response contracts", () => {
  const spec = factoryReadOpenApi;
  expect(spec.openapi).toBe("3.1.0");
  expect(spec.security).toEqual([{ factoryBearer: [] }]);
  expect(Object.keys(spec.paths)).toEqual([
    ...new Set([
      ...Object.values(factoryReadRoutes).map(({ path }) => path),
      ...Object.values(factoryMutationRoutes).map(({ path }) => path),
    ]),
  ]);

  const conversationPath = spec.paths[factoryReadRoutes.conversation.path];
  if (!conversationPath || !("get" in conversationPath) || !conversationPath.get) {
    throw new Error("The conversation read is missing from OpenAPI.");
  }
  const conversation = conversationPath.get;
  expect(conversation.parameters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "sessionId", in: "path", required: true }),
      expect.objectContaining({ name: "direction", in: "query", required: false }),
    ]),
  );
  expect(conversation.responses["429"].headers["Retry-After"].schema).toMatchObject({
    type: "integer",
    minimum: 1,
  });
  expect(conversation.responses["200"].content["application/json"].schema).toMatchObject({
    properties: {
      items: {
        items: {
          properties: expect.objectContaining({ bodyHtml: { type: "string" } }),
        },
      },
    },
  });
  expect(JSON.stringify(spec)).not.toContain("bodyMarkdown");
});

it("publishes protected mutation scopes, exact intent, and the required idempotency key", () => {
  const spec = factoryReadOpenApi;
  const sessions = spec.paths[factoryMutationRoutes.create.path]!;
  expect(sessions).toHaveProperty("get");
  expect(sessions).toHaveProperty("post");

  for (const { path, scope } of Object.values(factoryMutationRoutes)) {
    expect(spec.paths[path]).toMatchObject({
      post: {
        "x-wallie-scope": scope,
        parameters: expect.arrayContaining([
          expect.objectContaining({
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: expect.objectContaining({ format: "uuid" }),
          }),
        ]),
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { required: expect.arrayContaining(["receiptId", "conversationUrl"]) },
              },
            },
          },
          "409": {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/MutationError" } },
            },
          },
        },
      },
    });
  }

  expect(sessions).toMatchObject({
    post: {
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              additionalProperties: false,
              required: ["title", "prompt", "agentId", "repositoryId"],
              properties: {
                title: { maxLength: 200 },
                prompt: { maxLength: 20_000 },
                draftSpecification: { default: false },
              },
            },
          },
        },
      },
    },
  });
});

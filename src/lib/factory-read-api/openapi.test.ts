import { expect, it } from "vitest";

import { factoryReadRoutes } from "./contracts";
import { factoryReadOpenApi } from "./openapi";

it("publishes the six protected reads and their versioned response contracts", () => {
  const spec = factoryReadOpenApi;
  expect(spec.openapi).toBe("3.1.0");
  expect(spec.security).toEqual([{ factoryBearer: [] }]);
  expect(Object.keys(spec.paths)).toEqual(Object.values(factoryReadRoutes).map(({ path }) => path));

  const conversation = spec.paths[factoryReadRoutes.conversation.path]!.get;
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

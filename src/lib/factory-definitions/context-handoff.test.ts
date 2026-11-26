import { expect, it } from "vitest";

import { factoryContextPinHref, parseFactoryContextHandoff } from "./context-handoff";

const factoryId = "54600000-0000-4000-8000-000000000001";
const sourceId = "54600000-0000-4000-8000-000000000002";
const revisionId = "54600000-0000-4000-8000-000000000003";

it("encodes a distinct factory and exact source/revision pair without a write", () => {
  const url = new URL(
    factoryContextPinHref("demo", factoryId, { sourceId, revisionId }),
    "https://example.test",
  );
  expect(url.pathname).toBe("/w/demo/settings/factory-definition");
  expect(url.searchParams.get("factory")).toBe(factoryId);
  expect(url.hash).toBe("#definition-context-documents");
  expect(parseFactoryContextHandoff(Object.fromEntries(url.searchParams))).toMatchObject({
    success: true,
    data: { sourceId, revisionId },
  });
});

it("rejects incomplete and repeated Context parameters", () => {
  expect(parseFactoryContextHandoff({ contextSource: sourceId }).success).toBe(false);
  expect(
    parseFactoryContextHandoff({ contextSource: [sourceId, sourceId], contextRevision: revisionId })
      .success,
  ).toBe(false);
});

import { expect, it } from "vitest";

import { resolveAgentFactory } from "./agent-navigation";

const second = { id: "two", isDefault: false, name: "Second", status: "active" } as const;
const third = { ...second, id: "three", name: "Third" };
const first = { ...second, id: "one", isDefault: true, name: "Default" };

it("opens the only visible factory when unscoped, without overriding an explicit inaccessible ID", () => {
  expect(resolveAgentFactory([second])).toEqual({ kind: "factory", factory: second });
  expect(resolveAgentFactory([second], "all")).toEqual({ kind: "factory", factory: second });
  expect(resolveAgentFactory([second], first.id)).toEqual({ kind: "unavailable" });
  expect(resolveAgentFactory([], undefined)).toEqual({ kind: "unavailable" });
});

it("asks a viewer with multiple non-default factories to choose instead of guessing", () => {
  expect(resolveAgentFactory([second, third])).toEqual({ kind: "choose" });
  expect(resolveAgentFactory([second, first])).toEqual({ kind: "factory", factory: first });
  expect(resolveAgentFactory([second, first], "TWO")).toEqual({ kind: "factory", factory: second });
  expect(resolveAgentFactory([second, first], ["two", "one"])).toEqual({ kind: "unavailable" });
});

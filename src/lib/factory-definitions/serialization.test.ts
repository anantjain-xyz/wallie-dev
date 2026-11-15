import { describe, expect, it } from "vitest";

import {
  parseFactoryDefinitionJson,
  serializeFactoryDefinition,
} from "@/lib/factory-definitions/serialization";

describe("factory definition JSON file", () => {
  it("decodes JSON without mistaking quoted punctuation for keys or object boundaries", () => {
    expect(
      parseFactoryDefinitionJson(String.raw`{
        "stage": {"name": "First"},
        "steps": [{"name": "Second"}],
        "prompt": "  \"name\": { keep \\ and }\n🧪"
      }`),
    ).toEqual({
      ok: true,
      value: {
        stage: { name: "First" },
        steps: [{ name: "Second" }],
        prompt: '  "name": { keep \\ and }\n🧪',
      },
    });
  });

  it.each([
    String.raw`{"name":"first","name":"second"}`,
    String.raw`{"stages":[{"id":"first","\u0069d":"second"}]}`,
    String.raw`{"value":{"🧪":1,"\ud83e\uddea":2}}`,
  ])("rejects repeated decoded object keys in %s", (source) => {
    expect(parseFactoryDefinitionJson(source)).toEqual({
      ok: false,
      message: expect.stringMatching(/duplicate object key at character \d+/),
    });
  });

  it.each([
    '{"kind":"serial",}',
    '// comment\n{"kind":"serial"}',
    "kind: serial",
    '{"first":1}{"second":2}',
  ])("requires valid JSON in %s", (source) => {
    expect(parseFactoryDefinitionJson(source)).toEqual({
      ok: false,
      message: expect.stringContaining("valid JSON"),
    });
  });

  it.each([String.raw`{"name":"\u0000"}`, String.raw`{"\ud800":true}`])(
    "rejects strings the definition cannot represent in %s",
    (source) => {
      expect(parseFactoryDefinitionJson(source)).toEqual({
        ok: false,
        message: expect.stringContaining("valid Unicode"),
      });
    },
  );
});

describe("factory definition serialization", () => {
  it("sorts keys recursively by code unit and keeps array order and string contents", () => {
    const first = {
      stages: [{ name: "  Second\r\n" }, { name: "First" }],
      nested: { "2": true, "10": false, é: 1, z: 2 },
    };
    const second = { nested: { z: 2, é: 1, "10": false, "2": true }, stages: first.stages };
    const serialized = serializeFactoryDefinition(first);

    expect(serialized.definitionJson).toBe(
      '{"nested":{"10":false,"2":true,"z":2,"é":1},"stages":[{"name":"  Second\\r\\n"},{"name":"First"}]}',
    );
    expect(serializeFactoryDefinition(second)).toEqual(serialized);
    expect(
      serializeFactoryDefinition({ ...first, stages: [...first.stages].reverse() }).canonicalDigest,
    ).not.toBe(serialized.canonicalDigest);
  });

  it("hashes the exact canonical UTF-8 bytes persisted by the database", () => {
    expect(
      serializeFactoryDefinition({ title: "Café – 承認", schemaVersion: 1, kind: "serial" }),
    ).toEqual({
      definitionJson: '{"kind":"serial","schemaVersion":1,"title":"Café – 承認"}',
      canonicalDigest: "10c51d120b795102460382555a911289135d25d3d416f44961bd331ed584bfb4",
    });
  });
});

import { createHash } from "node:crypto";

export { parseFactoryDefinitionJson } from "./parse-json";

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (isJsonArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const properties = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${properties.join(",")}}`;
}

/** Serialize validated JSON, preserving array order and the contents of strings. */
export function serializeFactoryDefinition(bundle: JsonObject) {
  const definitionJson = canonicalJson(bundle);
  const canonicalDigest = createHash("sha256").update(definitionJson, "utf8").digest("hex");
  return { definitionJson, canonicalDigest };
}

import { createHash } from "node:crypto";

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

type JsonParseResult = { ok: true; value: unknown } | { ok: false; message: string };

export function isFactoryDefinitionText(value: string): boolean {
  // Unicode mode combines valid surrogate pairs before testing the category.
  return !/\p{Surrogate}/u.test(value) && !value.includes("\0");
}

export function parseFactoryDefinitionJson(source: string): JsonParseResult {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { ok: false, message: "Factory definition files must contain valid JSON." };
  }

  // JSON.parse keeps only the last occurrence of a key. Scan the syntactically
  // valid source for duplicate decoded keys before using its parsed value.
  const objectKeys: Set<string>[] = [];
  for (const match of source.matchAll(/("(?:[^"\\]|\\.)*")(\s*:)?|[{}]/g)) {
    const [token, quotedText, colon] = match;
    if (token === "{") {
      objectKeys.push(new Set());
    } else if (token === "}") {
      objectKeys.pop();
    } else {
      const text: string = JSON.parse(quotedText);
      if (!isFactoryDefinitionText(text)) {
        return {
          ok: false,
          message: "Factory definition text must use valid Unicode and contain no NUL characters.",
        };
      }
      if (!colon) continue;
      const keys = objectKeys[objectKeys.length - 1];
      if (keys.has(text)) {
        return {
          ok: false,
          message: `Factory definition JSON contains a duplicate object key at character ${match.index + 1}.`,
        };
      }
      keys.add(text);
    }
  }

  return { ok: true, value };
}

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

import { isFactoryDefinitionText } from "./text";

type JsonParseResult = { ok: true; value: unknown } | { ok: false; message: string };

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

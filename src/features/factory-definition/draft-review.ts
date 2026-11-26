import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/parse-json";
import {
  serialFactoryDefinitionSchema,
  type SerialFactoryDefinition,
} from "@/lib/factory-definitions/schema";

export type DraftInput =
  | { kind: "structured"; value: SerialFactoryDefinition }
  | { kind: "json"; text: string };

type Agent = SerialFactoryDefinition["agent"];
type DefinitionKey = Exclude<keyof SerialFactoryDefinition, "agent"> | "scorerRevisionIds";
type Path = readonly [DefinitionKey] | readonly ["agent", keyof Agent];
type Field = readonly [label: string, path: Path];
type Group = { label: string; fields: readonly Field[] };

const groups = [
  { label: "Operating rules", fields: [["Operating rules", ["operatingRulesMd"]]] },
  {
    label: "Agent model and provider",
    fields: [
      ["Agent provider", ["agent", "provider"]],
      ["Model", ["agent", "model"]],
      ["Reasoning effort", ["agent", "effort"]],
    ],
  },
  { label: "Concurrency limit", fields: [["Concurrency limit", ["agent", "concurrencyLimit"]]] },
  { label: "Stall timeout", fields: [["Stall timeout (ms)", ["agent", "stallTimeoutMs"]]] },
  { label: "Maximum retries", fields: [["Maximum retries", ["agent", "maxRetries"]]] },
  { label: "Maximum turns", fields: [["Maximum turns", ["agent", "maxTurns"]]] },
  { label: "Sandbox provider", fields: [["Sandbox provider", ["sandboxProvider"]]] },
  {
    label: "Pipeline and workflow",
    fields: [
      ["Pipeline", ["pipeline"]],
      ["Stages and order", ["stages"]],
    ],
  },
  {
    label: "Repository bindings",
    fields: [
      ["Primary repository", ["repository"]],
      ["Additional writable repositories", ["writableRepositories"]],
      ["Read-only repositories", ["readContextRepositories"]],
    ],
  },
  {
    label: "Execution authority and tool bindings",
    fields: [
      ["Implementation agent prompt revision", ["implementationAgent"]],
      ["Execution policy revision", ["executionPolicy"]],
      ["Execution grant", ["executionGrant"]],
      ["Credential binding", ["credentialBindingId"]],
      ["Context documents", ["contextDocuments"]],
      ["Tools", ["tools"]],
      ["MCP bindings", ["mcpBindings"]],
    ],
  },
  { label: "Delivery policy", fields: [["Delivery policy", ["deliveryPolicy"]]] },
  { label: "Skills", fields: [["Skills", ["skills"]]] },
  {
    label: "Scorer bindings",
    fields: [
      ["Schema version", ["schemaVersion"]],
      ["Scorer revisions", ["scorerRevisionIds"]],
    ],
  },
  { label: "Model routing", fields: [["Model routing", ["modelRouting"]]] },
] satisfies readonly Group[];

export function sameDefinitionValue(left: unknown, right: unknown) {
  const orderedJson = (value: unknown) =>
    JSON.stringify(value, (_, entry: unknown) =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : entry,
    );
  return orderedJson(left) === orderedJson(right);
}

function readField(source: SerialFactoryDefinition, [key, subkey]: Path) {
  if (key === "agent") return source.agent[subkey];
  if (key === "scorerRevisionIds") {
    return "scorerRevisionIds" in source ? source.scorerRevisionIds : undefined;
  }
  return source[key];
}

export function planDraftReview(
  original: SerialFactoryDefinition,
  input: DraftInput,
  latest: SerialFactoryDefinition,
) {
  const decoded =
    input.kind === "json"
      ? parseFactoryDefinitionJson(input.text)
      : { ok: true as const, value: input.value };
  if (!decoded.ok) return { ok: false as const, message: decoded.message };
  const parsed = serialFactoryDefinitionSchema.safeParse(decoded.value);
  if (!parsed.success) {
    return {
      ok: false as const,
      message: parsed.error.issues[0]?.message ?? "Correct the definition to compare your edits.",
    };
  }
  const mine = parsed.data;
  const changes = groups.flatMap(({ label, fields }) => {
    let mineChanged = false;
    let latestChanged = false;
    const comparisons = fields.map(([label, path]) => {
      const before = readField(original, path);
      const mineValue = readField(mine, path);
      const latestValue = readField(latest, path);
      const localChange = !sameDefinitionValue(before, mineValue);
      const remoteChange = !sameDefinitionValue(before, latestValue);
      mineChanged ||= localChange;
      latestChanged ||= remoteChange;
      return { label, path, mine: mineValue, latest: latestValue, localChange, remoteChange };
    });
    if (!mineChanged && !latestChanged) return [];
    const agree = comparisons.every(({ mine, latest }) => sameDefinitionValue(mine, latest));
    const kind = agree
      ? "same"
      : mineChanged && latestChanged
        ? "conflict"
        : mineChanged
          ? "mine"
          : "latest";
    return [
      {
        kind,
        label,
        fields: comparisons.filter(({ localChange, remoteChange }) => localChange || remoteChange),
      } as const,
    ];
  });

  return { ok: true as const, changes };
}

export function resolveDraftReview(
  latest: SerialFactoryDefinition,
  plan: Extract<ReturnType<typeof planDraftReview>, { ok: true }>,
  choices: Readonly<Record<string, "mine" | "latest">>,
) {
  const source = { ...latest, agent: { ...latest.agent } };
  for (const { kind, label, fields } of plan.changes) {
    if (kind === "conflict" && !choices[label]) return null;
    if (kind !== "mine" && !(kind === "conflict" && choices[label] === "mine")) continue;

    for (const {
      path: [key, subkey],
      mine,
    } of fields) {
      if (key === "agent") Object.assign(source.agent, { [subkey]: mine });
      else if (mine === undefined) Reflect.deleteProperty(source, key);
      else Object.assign(source, { [key]: mine });
    }
  }
  const result = serialFactoryDefinitionSchema.safeParse(source);
  return result.success ? result.data : null;
}

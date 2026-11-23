import {
  factoryAutomationDefinitionSchema,
  type FactoryAutomationDefinition,
} from "@/lib/factory-automations/contracts";

function draftGroups(definition: FactoryAutomationDefinition) {
  const { name, trigger, filters, ...assignment } =
    factoryAutomationDefinitionSchema.parse(definition);
  return { name, event: { trigger, filters }, assignment };
}

export function rebaseAutomationDraft(
  base: FactoryAutomationDefinition,
  mine: FactoryAutomationDefinition,
  latest: FactoryAutomationDefinition,
): {
  conflicts: string[];
  keepEdits: FactoryAutomationDefinition;
  keepSaved: FactoryAutomationDefinition;
} {
  const original = draftGroups(base);
  const edited = draftGroups(mine);
  const saved = draftGroups(latest);
  const conflicts: string[] = [];

  function choose<T>(label: string, original: T, edited: T, saved: T) {
    const originalValue = JSON.stringify(original);
    const editedValue = JSON.stringify(edited);
    const savedValue = JSON.stringify(saved);
    if (editedValue === originalValue) return { keepEdits: saved, keepSaved: saved };
    if (savedValue === originalValue || savedValue === editedValue) {
      return { keepEdits: edited, keepSaved: edited };
    }
    conflicts.push(label);
    return { keepEdits: edited, keepSaved: saved };
  }

  const name = choose("Rule name", original.name, edited.name, saved.name);
  const event = choose("Trigger and filters", original.event, edited.event, saved.event);
  const assignment = choose(
    "Assigned target",
    original.assignment,
    edited.assignment,
    saved.assignment,
  );
  return {
    conflicts,
    keepEdits: factoryAutomationDefinitionSchema.parse({
      name: name.keepEdits,
      ...event.keepEdits,
      ...assignment.keepEdits,
    }),
    keepSaved: factoryAutomationDefinitionSchema.parse({
      name: name.keepSaved,
      ...event.keepSaved,
      ...assignment.keepSaved,
    }),
  };
}

import { isBrowserEvidenceRequirement } from "@/lib/validation-evidence/browser-contract";
import { validationPlanSchema, type ValidationPlan } from "@/lib/validation-evidence/contracts";

function mergeOrderedChecks<Check extends { key: string }>(sequences: Check[][]): Check[] {
  const definitions = new Map<string, Check>();
  const prerequisites = new Map<string, Set<string>>();
  for (const sequence of sequences) {
    let previous: string | undefined;
    for (const check of sequence) {
      const existing = definitions.get(check.key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(check))
        throw new Error("The frozen join inputs disagree on a validation check.");
      definitions.set(check.key, check);

      const dependencies = prerequisites.get(check.key) ?? new Set<string>();
      if (previous !== undefined) dependencies.add(previous);
      prerequisites.set(check.key, dependencies);
      previous = check.key;
    }
  }

  const ordered: Check[] = [];
  while (prerequisites.size) {
    // Map order breaks ties by first appearance in the frozen branch order.
    const next = [...prerequisites].find(([, dependencies]) => dependencies.size === 0);
    if (!next) throw new Error("The frozen join inputs disagree on validation order.");
    const [key] = next;
    ordered.push(definitions.get(key)!);
    prerequisites.delete(key);
    for (const dependencies of prerequisites.values()) dependencies.delete(key);
  }
  return ordered;
}

/** Preserve the frozen plan order, including any setup checks outside the required evidence set. */
export function selectJoinValidationPlan(
  plans: ValidationPlan[],
  required: string[],
): ValidationPlan {
  const commands = mergeOrderedChecks(plans.map((plan) => plan.commands));
  const browser = mergeOrderedChecks(plans.map((plan) => (plan.version === 2 ? plan.browser : [])));

  for (const requirement of required) {
    const [, kind, key] = requirement.split(":");
    const covered = isBrowserEvidenceRequirement(requirement)
      ? browser.some(
          (check) => check.key === key && check.evidence.some((item) => item.kind === kind),
        )
      : commands.some((check) => check.key === requirement);
    if (!covered)
      throw new Error("The frozen join inputs do not cover the parent's required validation.");
  }

  return validationPlanSchema.parse(
    browser.length ? { version: 2, commands, browser } : { version: 1, commands },
  );
}

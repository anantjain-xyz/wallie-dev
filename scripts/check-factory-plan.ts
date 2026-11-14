import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const capabilityId = z.string().regex(/^F\d{3}$/u);
const milestoneId = z.string().regex(/^M\d{2}$/u);
const issueKey = z.string().regex(/^FCT-M\d{2}-\d{2}$/u);
const registerSchema = z.object({
  capabilities: z.array(
    z.object({
      id: capabilityId,
      delivery_milestone: milestoneId,
      depends_on: z.array(capabilityId),
      reuse: z.array(z.string().regex(/^R\d{2}$/u)).min(1),
    }),
  ),
  milestones: z.array(
    z.object({
      id: milestoneId,
      depends_on: z.array(milestoneId),
      capability_ids: z.array(capabilityId),
    }),
  ),
});
const deliverySchema = z.object({
  counts: z.object({
    capabilities: z.number().int().nonnegative(),
    milestones: z.number().int().nonnegative(),
    issues: z.number().int().nonnegative(),
    blocking_relationships: z.number().int().nonnegative(),
  }),
  milestones: z.array(
    z.object({
      key: milestoneId,
      capabilities: z.array(capabilityId),
      issues: z.array(issueKey),
      qualification: issueKey,
    }),
  ),
  issues: z.array(
    z.object({
      key: issueKey,
      identifier: z.string().min(1),
      milestone: milestoneId,
      capabilities: z.array(capabilityId),
      blocked_by: z.array(issueKey),
    }),
  ),
});

function indexBy<T>(
  items: readonly T[],
  key: (item: T) => string,
  label: string,
  errors: string[],
) {
  const index = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (index.has(id)) errors.push(`${label}: duplicate ${id}`);
    index.set(id, item);
  }
  return index;
}

function checkMembers(
  actual: Iterable<string>,
  expected: Iterable<string>,
  label: string,
  errors: string[],
) {
  const entries = [...actual];
  const actualSet = new Set(entries);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((id) => !actualSet.has(id));
  const unexpected = [...actualSet].filter((id) => !expectedSet.has(id));
  if (missing.length) errors.push(`${label}: missing ${missing.join(", ")}`);
  if (unexpected.length) errors.push(`${label}: unexpected ${unexpected.join(", ")}`);
  if (actualSet.size !== entries.length) errors.push(`${label}: duplicate entries`);
}

function checkGraph(
  graph: ReadonlyMap<string, readonly string[]>,
  label: string,
  errors: string[],
) {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string) {
    if (visiting.has(id)) {
      const path = [...visiting];
      errors.push(
        `${label}: dependency cycle ${[...path.slice(path.indexOf(id)), id].join(" → ")}`,
      );
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const dependencies = graph.get(id) ?? [];
    if (new Set(dependencies).size !== dependencies.length)
      errors.push(`${label}: ${id} has duplicate dependencies`);
    for (const dependency of dependencies) {
      if (graph.has(dependency)) visit(dependency);
      else errors.push(`${label}: ${id} depends on unknown ${dependency}`);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of graph.keys()) visit(id);
}

export function checkFactoryPlan(projectDirectory = process.cwd()): string[] {
  const errors: string[] = [];
  function read(name: string) {
    return readFileSync(resolve(projectDirectory, "docs/plans", name), "utf8");
  }
  function readJson(name: string): unknown {
    try {
      return JSON.parse(read(name));
    } catch (error) {
      throw new Error(`${name}: ${String(error)}`);
    }
  }

  try {
    const register = registerSchema.safeParse(readJson("factory-capabilities.json"));
    if (!register.success) return [`factory-capabilities.json: ${register.error.message}`];
    const delivery = deliverySchema.safeParse(readJson("linear-delivery-map.json"));
    if (!delivery.success) return [`linear-delivery-map.json: ${delivery.error.message}`];

    const capabilities = indexBy(
      register.data.capabilities,
      (row) => row.id,
      "Capability register",
      errors,
    );
    const milestones = indexBy(
      register.data.milestones,
      (row) => row.id,
      "Milestone register",
      errors,
    );
    const expectedCapabilities = Array.from(
      { length: 100 },
      (_, i) => `F${String(i + 1).padStart(3, "0")}`,
    );
    checkMembers(capabilities.keys(), expectedCapabilities, "Capability register", errors);

    const reuseRows = [
      ...read("factory-implementation-plan.md").matchAll(/^\|\s*(R\d{2})\s*\|/gmu),
    ];
    const reuse = indexBy(reuseRows, (row) => row[1], "Plan reuse register", errors);
    const matrixRows = read("factory-capability-matrix.md")
      .split("\n")
      .filter((line) => /^\|\s*\*\*F\d{3}\s+—/u.test(line))
      .map((line) => {
        const [, title, milestone, , references] = line.split(/(?<!\\)\|/u);
        return {
          id: title.match(/F\d{3}/u)?.[0] ?? "",
          milestone: milestone?.match(/\*\*(M\d{2})\*\*/u)?.[1],
          reuse: references?.match(/\bR\d{2}\b/gu) ?? [],
          dependencies: references?.match(/\bF\d{3}\b/gu) ?? [],
        };
      });
    const matrix = indexBy(matrixRows, (row) => row.id, "Capability matrix", errors);
    checkMembers(matrix.keys(), capabilities.keys(), "Capability matrix", errors);

    for (const capability of capabilities.values()) {
      const owner = capability.delivery_milestone;
      if (!milestones.has(owner)) errors.push(`${capability.id}: unknown milestone ${owner}`);
      const row = matrix.get(capability.id);
      if (row) {
        if (row.milestone !== owner) {
          errors.push(
            `Capability matrix: ${capability.id} is in ${row.milestone ?? "no milestone"}, expected ${owner}`,
          );
        }
        checkMembers(
          row.reuse,
          capability.reuse,
          `Capability matrix ${capability.id} reuse`,
          errors,
        );
        checkMembers(
          row.dependencies,
          capability.depends_on,
          `Capability matrix ${capability.id} prerequisites`,
          errors,
        );
      }
      for (const id of capability.reuse) {
        if (!reuse.has(id)) errors.push(`${capability.id}: unknown reuse reference ${id}`);
      }
    }
    for (const milestone of milestones.values()) {
      const owned = register.data.capabilities.filter(
        (capability) => capability.delivery_milestone === milestone.id,
      );
      checkMembers(
        milestone.capability_ids,
        owned.map((capability) => capability.id),
        `${milestone.id} capabilities`,
        errors,
      );
    }
    checkGraph(
      new Map([...capabilities].map(([id, row]) => [id, row.depends_on])),
      "Capability register",
      errors,
    );
    checkGraph(
      new Map([...milestones].map(([id, row]) => [id, row.depends_on])),
      "Milestone register",
      errors,
    );

    const issues = indexBy(delivery.data.issues, (row) => row.key, "Linear issue map", errors);
    indexBy(delivery.data.issues, (row) => row.identifier, "Linear issue identifiers", errors);
    const deliveryMilestones = indexBy(
      delivery.data.milestones,
      (row) => row.key,
      "Linear milestones",
      errors,
    );
    checkMembers(deliveryMilestones.keys(), milestones.keys(), "Linear milestones", errors);
    for (const issue of issues.values()) {
      if (!deliveryMilestones.has(issue.milestone))
        errors.push(`${issue.key}: unknown milestone ${issue.milestone}`);
      for (const id of issue.capabilities) {
        if (!capabilities.has(id)) errors.push(`${issue.key}: unknown capability ${id}`);
      }
    }
    for (const milestone of deliveryMilestones.values()) {
      const owned = milestones.get(milestone.key)?.capability_ids ?? [];
      checkMembers(milestone.capabilities, owned, `Linear ${milestone.key} capabilities`, errors);
      const assigned = [...issues.values()].filter((issue) => issue.milestone === milestone.key);
      checkMembers(
        milestone.issues,
        assigned.map((issue) => issue.key),
        `Linear ${milestone.key} issues`,
        errors,
      );
      const covered = new Set(assigned.flatMap((issue) => issue.capabilities));
      for (const id of owned) {
        if (!covered.has(id)) errors.push(`Linear ${milestone.key}: no issue covers ${id}`);
      }
      if (issues.get(milestone.qualification)?.milestone !== milestone.key) {
        errors.push(
          `Linear ${milestone.key}: invalid qualification issue ${milestone.qualification}`,
        );
      }
    }
    checkGraph(
      new Map([...issues].map(([id, row]) => [id, row.blocked_by])),
      "Linear issue map",
      errors,
    );
    const counts = {
      capabilities: capabilities.size,
      milestones: deliveryMilestones.size,
      issues: issues.size,
      blocking_relationships: [...issues.values()].reduce(
        (count, issue) => count + issue.blocked_by.length,
        0,
      ),
    };
    for (const key of ["capabilities", "milestones", "issues", "blocking_relationships"] as const) {
      if (delivery.data.counts[key] !== counts[key])
        errors.push(`Linear counts.${key}: expected ${counts[key]}`);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkFactoryPlan();
  if (errors.length) {
    console.error(`Factory plan check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(
      "Factory plan verified: F001–F100, milestone and reuse references, and dependency graphs.",
    );
  }
}

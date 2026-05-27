import { z } from "zod";

export const LINEAR_ROUTE_KEYS = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "rework",
  "merging",
  "done",
  "canceled",
] as const;

export type LinearRouteKey = (typeof LINEAR_ROUTE_KEYS)[number];

export const LINEAR_ROUTE_LABELS: Record<LinearRouteKey, string> = {
  backlog: "Backlog",
  canceled: "Canceled",
  done: "Done",
  in_progress: "In Progress",
  in_review: "In Review",
  merging: "Merging",
  rework: "Rework",
  todo: "Todo",
};

export const DEFAULT_LINEAR_STATUS_MAPPINGS: Record<LinearRouteKey, string[]> = {
  backlog: ["Backlog"],
  canceled: ["Canceled", "Cancelled", "Duplicate"],
  done: ["Done"],
  in_progress: ["In Progress"],
  in_review: ["In Review"],
  merging: ["Merging"],
  rework: ["Rework"],
  todo: ["Todo"],
};

export const DEFAULT_LINEAR_ROUTING_CONFIG = {
  landStageSlug: "land",
  reworkStageSlug: "build",
  statusMappings: DEFAULT_LINEAR_STATUS_MAPPINGS,
};

const statusNameSchema = z
  .string()
  .trim()
  .min(1, "Status names cannot be blank.")
  .max(80, "Status names must be 80 characters or fewer.");

const stageSlugSchema = z
  .string()
  .trim()
  .min(1, "Stage slug is required.")
  .max(64, "Stage slug must be 64 characters or fewer.")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Stage slug must be lowercase kebab-case.");

export const linearStatusMappingsSchema = z.object({
  backlog: z.array(statusNameSchema).min(1),
  canceled: z.array(statusNameSchema).min(1),
  done: z.array(statusNameSchema).min(1),
  in_progress: z.array(statusNameSchema).min(1),
  in_review: z.array(statusNameSchema).min(1),
  merging: z.array(statusNameSchema).min(1),
  rework: z.array(statusNameSchema).min(1),
  todo: z.array(statusNameSchema).min(1),
});

export const linearRoutingUpdateSchema = z.object({
  landStageSlug: stageSlugSchema,
  reworkStageSlug: stageSlugSchema,
  statusMappings: linearStatusMappingsSchema,
});

export type LinearStatusMappings = z.infer<typeof linearStatusMappingsSchema>;
export type LinearRoutingUpdateInput = z.infer<typeof linearRoutingUpdateSchema>;

export type LinearRoutingConfig = {
  landStageSlug: string;
  reworkStageSlug: string;
  statusMappings: LinearStatusMappings;
};

export type LinearRouteClassification =
  | { action: "ignore"; route: "backlog"; statusName: string }
  | { action: "start_or_continue"; route: "todo" | "in_progress"; statusName: string }
  | { action: "pause"; route: "in_review"; statusName: string }
  | { action: "rework"; route: "rework"; stageSlug: string; statusName: string }
  | { action: "land"; route: "merging" | "done"; stageSlug: string; statusName: string }
  | { action: "archive"; route: "canceled"; statusName: string }
  | { action: "unmapped"; route: null; statusName: string };

export function normalizeLinearStatusName(statusName: string): string {
  return statusName.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeStatusMappings(
  mappings: LinearStatusMappings,
): Record<LinearRouteKey, string[]> {
  const normalized = {} as Record<LinearRouteKey, string[]>;
  for (const key of LINEAR_ROUTE_KEYS) {
    const seen = new Set<string>();
    normalized[key] = mappings[key]
      .map((name) => name.trim())
      .filter((name) => {
        const normalizedName = normalizeLinearStatusName(name);
        if (!normalizedName || seen.has(normalizedName)) return false;
        seen.add(normalizedName);
        return true;
      });
  }
  return normalized;
}

export function coerceLinearRoutingConfig(value: unknown): LinearRoutingConfig {
  const parsed = linearRoutingUpdateSchema.safeParse(value);
  if (parsed.success) {
    return {
      landStageSlug: parsed.data.landStageSlug,
      reworkStageSlug: parsed.data.reworkStageSlug,
      statusMappings: normalizeStatusMappings(parsed.data.statusMappings) as LinearStatusMappings,
    };
  }
  return DEFAULT_LINEAR_ROUTING_CONFIG;
}

export function classifyLinearStatus(
  statusName: string,
  config: LinearRoutingConfig = DEFAULT_LINEAR_ROUTING_CONFIG,
): LinearRouteClassification {
  const normalizedStatus = normalizeLinearStatusName(statusName);

  for (const route of LINEAR_ROUTE_KEYS) {
    const names = config.statusMappings[route] ?? [];
    if (!names.some((name) => normalizeLinearStatusName(name) === normalizedStatus)) {
      continue;
    }

    switch (route) {
      case "backlog":
        return { action: "ignore", route, statusName };
      case "todo":
      case "in_progress":
        return { action: "start_or_continue", route, statusName };
      case "in_review":
        return { action: "pause", route, statusName };
      case "rework":
        return { action: "rework", route, stageSlug: config.reworkStageSlug, statusName };
      case "merging":
        return { action: "land", route, stageSlug: config.landStageSlug, statusName };
      case "done":
        return { action: "land", route, stageSlug: config.landStageSlug, statusName };
      case "canceled":
        return { action: "archive", route, statusName };
    }
  }

  return { action: "unmapped", route: null, statusName };
}

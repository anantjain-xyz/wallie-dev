import { describe, expect, it } from "vitest";

import {
  DEFAULT_LINEAR_ROUTING_CONFIG,
  classifyLinearStatus,
  normalizeLinearStatusName,
} from "@/lib/linear-routing/contracts";

describe("linear routing contracts", () => {
  it("normalizes status names case-insensitively", () => {
    expect(normalizeLinearStatusName("  In   Progress  ")).toBe("in progress");
  });

  it("classifies the default Symphony-style statuses", () => {
    expect(classifyLinearStatus("Backlog").action).toBe("ignore");
    expect(classifyLinearStatus("Todo").action).toBe("start_or_continue");
    expect(classifyLinearStatus("In Progress").action).toBe("start_or_continue");
    expect(classifyLinearStatus("In Review").action).toBe("pause");
    expect(classifyLinearStatus("Rework")).toMatchObject({
      action: "rework",
      stageSlug: "engineering",
    });
    expect(classifyLinearStatus("Merging")).toMatchObject({
      action: "land",
      stageSlug: "land",
    });
    expect(classifyLinearStatus("Done").action).toBe("archive");
    expect(classifyLinearStatus("Canceled").action).toBe("archive");
    expect(classifyLinearStatus("Duplicate").action).toBe("archive");
  });

  it("supports custom status names and stage targets", () => {
    const config = {
      ...DEFAULT_LINEAR_ROUTING_CONFIG,
      landStageSlug: "ship",
      reworkStageSlug: "build",
      statusMappings: {
        ...DEFAULT_LINEAR_ROUTING_CONFIG.statusMappings,
        merging: ["Ready to Ship"],
        rework: ["Needs Work"],
      },
    };

    expect(classifyLinearStatus("ready to ship", config)).toMatchObject({
      action: "land",
      stageSlug: "ship",
    });
    expect(classifyLinearStatus("Needs   Work", config)).toMatchObject({
      action: "rework",
      stageSlug: "build",
    });
  });

  it("returns unmapped for unknown statuses", () => {
    expect(classifyLinearStatus("Triage")).toEqual({
      action: "unmapped",
      route: null,
      statusName: "Triage",
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  workflowDirectoryAvailability,
  workflowDirectoryEmptyMessage,
  workflowTemplateBlocker,
  workflowTemplateLabel,
} from "./workflow-directory-state";

describe("workflow directory availability", () => {
  it.each([
    [undefined, true, false, false, "Publish a draft"],
    ["definition_changed", true, false, false, "Rebase and publish"],
    ["unavailable", true, false, false, "current factory intake"],
    ["eligible", false, false, false, "workspace’s default factory"],
    ["eligible", true, true, false, "Finish workspace setup"],
    ["eligible", true, false, true, "Available in New session"],
  ] as const)(
    "reports %s (default=%s, setup required=%s)",
    (intake, isDefault, setupRequired, canLaunch, copy) => {
      const result = workflowDirectoryAvailability(intake, { isDefault, setupRequired });
      expect(result.canLaunch).toBe(canLaunch);
      expect(result.message).toContain(copy);
    },
  );

  it("uses the template’s human label and revision", () => {
    expect(workflowTemplateLabel({ id: "scoped-fix", version: 1 })).toBe("Scoped fix · v1");
    expect(workflowTemplateLabel(null)).toBe("Blank workflow");
  });
});

describe("empty workflow directory pages", () => {
  it.each([
    [{}, "No workflows in this factory yet."],
    [{ q: "release" }, "No workflows match that name in this factory."],
    [{ after: "cursor" }, "No more workflows."],
    [{ q: "release", after: "cursor" }, "No more workflows."],
  ] as const)("describes empty results for %j", (query, message) => {
    expect(workflowDirectoryEmptyMessage(query)).toBe(message);
  });
});

describe("workflow creation prerequisites", () => {
  it("explains what is missing without applying code-policy requirements to incident analysis", () => {
    const unconfigured = { state: "missing-references" } as const;
    const configured = {
      state: "configured",
      canDraftProductScope: false,
      hasRequiredEvidence: false,
    } as const;

    expect(workflowTemplateBlocker({ state: "no-definition" })).toContain("before editing");
    expect(workflowTemplateBlocker(unconfigured)).toBeNull();
    expect(workflowTemplateBlocker(unconfigured, "incident-analysis")).toContain("execution grant");
    expect(workflowTemplateBlocker(configured, "product-delivery")).toContain(
      "specification stage",
    );
    expect(workflowTemplateBlocker(configured, "scoped-fix")).toContain("validation evidence");
    expect(workflowTemplateBlocker(configured, "incident-analysis")).toBeNull();
  });
});

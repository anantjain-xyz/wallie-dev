import { describe, expect, it } from "vitest";

import {
  normalizeWorkspaceSlug,
  slugifyWorkspaceName,
  updateWorkspaceNamePayloadSchema,
} from "@/lib/workspaces";

describe("workspace helpers", () => {
  it("slugifies workspace names for client previews", () => {
    expect(slugifyWorkspaceName("Northwind Labs")).toBe("northwind-labs");
    expect(slugifyWorkspaceName("  !!!  ")).toBe("workspace");
  });

  it("normalizes optional slug overrides", () => {
    expect(normalizeWorkspaceSlug(" Northwind-Labs ")).toBe("northwind-labs");
    expect(normalizeWorkspaceSlug("   ")).toBeUndefined();
    expect(normalizeWorkspaceSlug(null)).toBeUndefined();
  });
});

describe("updateWorkspaceNamePayloadSchema", () => {
  it("trims a valid workspace name", () => {
    const parsed = updateWorkspaceNamePayloadSchema.parse({ name: "  Northwind Labs  " });
    expect(parsed.name).toBe("Northwind Labs");
  });

  it("rejects empty or whitespace-only names", () => {
    const result = updateWorkspaceNamePayloadSchema.safeParse({ name: "   " });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("Workspace name is required.");
    }
  });

  it("rejects names longer than 80 characters", () => {
    const result = updateWorkspaceNamePayloadSchema.safeParse({ name: "a".repeat(81) });
    expect(result.success).toBe(false);
  });
});

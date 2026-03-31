import { describe, expect, it } from "vitest";

import {
  normalizeWorkspaceSlug,
  slugifyWorkspaceName,
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

import { describe, expect, it } from "vitest";

import * as sandboxSettingsRoute from "./route";

describe("/api/workspaces/[workspaceId]/sandbox-settings method surface", () => {
  it("exposes only the PATCH mutation handler", () => {
    expect(Object.keys(sandboxSettingsRoute).sort()).toEqual(["PATCH"]);
  });
});

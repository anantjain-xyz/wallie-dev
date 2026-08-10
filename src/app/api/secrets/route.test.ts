import { describe, expect, it } from "vitest";

import * as secretsRoute from "./route";

describe("/api/secrets method surface", () => {
  it("exposes only the POST mutation handler", () => {
    expect(Object.keys(secretsRoute).sort()).toEqual(["POST"]);
  });
});

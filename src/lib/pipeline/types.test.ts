import { describe, expect, it } from "vitest";

import { PIPELINE_JOB_TYPE } from "./types";

describe("pipeline types", () => {
  describe("constants", () => {
    it("has the expected job type", () => {
      expect(PIPELINE_JOB_TYPE).toBe("session");
    });
  });
});

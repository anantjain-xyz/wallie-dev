import { describe, expect, it } from "vitest";

import { buildPipelineDedupeKey, PIPELINE_JOB_TYPE } from "./types";

describe("pipeline types", () => {
  describe("buildPipelineDedupeKey", () => {
    it("produces a deterministic key for a Linear issue ID", () => {
      expect(buildPipelineDedupeKey("TEAM-123")).toBe("pipeline:TEAM-123:active");
      expect(buildPipelineDedupeKey("ENG-456")).toBe("pipeline:ENG-456:active");
    });

    it("produces different keys for different issues", () => {
      expect(buildPipelineDedupeKey("A-1")).not.toBe(buildPipelineDedupeKey("A-2"));
    });
  });

  describe("constants", () => {
    it("has the expected job type", () => {
      expect(PIPELINE_JOB_TYPE).toBe("session");
    });
  });
});

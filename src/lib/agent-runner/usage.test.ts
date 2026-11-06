import { describe, expect, it } from "vitest";

import { isCostUsd, isTokenCount, normalizeMeasuredUsage } from "./usage";

describe("agent run usage normalization", () => {
  it("accepts explicitly measured zero tokens and cost", () => {
    expect(normalizeMeasuredUsage(0, 0, 0)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      provenance: "measured",
      costUsd: 0,
      costProvenance: "measured",
    });
  });

  it.each([undefined, null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1"])(
    "rejects invalid token count %s",
    (value) => {
      expect(isTokenCount(value)).toBe(false);
      expect(normalizeMeasuredUsage(value, 1)).toBeUndefined();
      expect(normalizeMeasuredUsage(1, value)).toBeUndefined();
    },
  );

  it("rejects unsafe integer token counts", () => {
    expect(isTokenCount(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(normalizeMeasuredUsage(Number.MAX_SAFE_INTEGER + 1, 1)).toBeUndefined();
  });

  it.each([undefined, null, -0.01, Number.NaN, Number.POSITIVE_INFINITY, "0.1"])(
    "omits invalid cost %s without discarding valid token telemetry",
    (value) => {
      expect(isCostUsd(value)).toBe(false);
      expect(normalizeMeasuredUsage(2, 3, value)).toEqual({
        inputTokens: 2,
        outputTokens: 3,
        provenance: "measured",
      });
    },
  );
});

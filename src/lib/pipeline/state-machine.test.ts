import { describe, expect, it } from "vitest";

import { canApprove, canReject, isTerminal, shouldEscalate } from "@/lib/pipeline/state-machine";

describe("pipeline state machine", () => {
  describe("shouldEscalate", () => {
    it("escalates at the threshold (3 rejections)", () => {
      expect(shouldEscalate(0)).toBe(false);
      expect(shouldEscalate(1)).toBe(false);
      expect(shouldEscalate(2)).toBe(false);
      expect(shouldEscalate(3)).toBe(true);
      expect(shouldEscalate(5)).toBe(true);
    });
  });

  describe("canApprove", () => {
    it("only allows approval when awaiting review", () => {
      expect(canApprove("awaiting_review")).toBe(true);
      expect(canApprove("agent_generating")).toBe(false);
      expect(canApprove("approved")).toBe(false);
      expect(canApprove("rejected")).toBe(false);
      expect(canApprove("escalated")).toBe(false);
    });
  });

  describe("canReject", () => {
    it("only allows rejection when awaiting review", () => {
      expect(canReject("awaiting_review")).toBe(true);
      expect(canReject("agent_generating")).toBe(false);
      expect(canReject("approved")).toBe(false);
      expect(canReject("escalated")).toBe(false);
    });
  });

  describe("isTerminal", () => {
    it("identifies terminal phase-status values", () => {
      expect(isTerminal("approved")).toBe(true);
      expect(isTerminal("escalated")).toBe(true);
      expect(isTerminal("awaiting_review")).toBe(false);
      expect(isTerminal("agent_generating")).toBe(false);
      expect(isTerminal("rejected")).toBe(false);
    });
  });
});

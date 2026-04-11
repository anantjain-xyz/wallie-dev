import { describe, expect, it } from "vitest";

import {
  approvalTimestampField,
  canApprove,
  canReject,
  isTerminal,
  nextPhase,
  shouldEscalate,
} from "@/lib/pipeline/state-machine";

describe("pipeline state machine", () => {
  describe("nextPhase", () => {
    it("advances through the phase sequence", () => {
      expect(nextPhase("product")).toBe("design");
      expect(nextPhase("design")).toBe("engineering");
      expect(nextPhase("engineering")).toBe("shipped");
    });

    it("returns null for the final phase", () => {
      expect(nextPhase("shipped")).toBeNull();
    });
  });

  describe("approvalTimestampField", () => {
    it("maps each phase to its timestamp column", () => {
      expect(approvalTimestampField("product")).toBe("product_approved_at");
      expect(approvalTimestampField("design")).toBe("design_approved_at");
      expect(approvalTimestampField("engineering")).toBe("engineering_approved_at");
      expect(approvalTimestampField("shipped")).toBe("shipped_at");
    });
  });

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
    it("identifies terminal states", () => {
      expect(isTerminal("approved")).toBe(true);
      expect(isTerminal("escalated")).toBe(true);
      expect(isTerminal("awaiting_review")).toBe(false);
      expect(isTerminal("agent_generating")).toBe(false);
      expect(isTerminal("rejected")).toBe(false);
    });
  });
});

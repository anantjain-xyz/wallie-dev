import { describe, expect, it } from "vitest";

import {
  PHASE_ORDER,
  canApprove,
  canReject,
  isSessionPhase,
  isTerminal,
  isTerminalPhase,
  nextPhase,
  shouldEscalate,
} from "@/lib/pipeline/state-machine";

describe("pipeline state machine", () => {
  describe("PHASE_ORDER", () => {
    it("contains the six pipeline phases in order", () => {
      expect(PHASE_ORDER).toEqual([
        "product",
        "design",
        "engineering",
        "review",
        "land",
        "monitor",
      ]);
    });
  });

  describe("nextPhase", () => {
    it("advances through the full sequence", () => {
      expect(nextPhase("product")).toBe("design");
      expect(nextPhase("design")).toBe("engineering");
      expect(nextPhase("engineering")).toBe("review");
      expect(nextPhase("review")).toBe("land");
      expect(nextPhase("land")).toBe("monitor");
    });

    it("returns null for the terminal monitor phase", () => {
      expect(nextPhase("monitor")).toBeNull();
    });
  });

  describe("isTerminalPhase", () => {
    it("treats monitor as terminal and other phases as non-terminal", () => {
      expect(isTerminalPhase("monitor")).toBe(true);
      expect(isTerminalPhase("product")).toBe(false);
      expect(isTerminalPhase("land")).toBe(false);
    });
  });

  describe("isSessionPhase", () => {
    it("accepts the six valid phase names and rejects others", () => {
      for (const phase of PHASE_ORDER) {
        expect(isSessionPhase(phase)).toBe(true);
      }
      expect(isSessionPhase("shipped")).toBe(false);
      expect(isSessionPhase("")).toBe(false);
      expect(isSessionPhase("Product")).toBe(false);
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
    it("identifies terminal phase-status values", () => {
      expect(isTerminal("approved")).toBe(true);
      expect(isTerminal("escalated")).toBe(true);
      expect(isTerminal("awaiting_review")).toBe(false);
      expect(isTerminal("agent_generating")).toBe(false);
      expect(isTerminal("rejected")).toBe(false);
    });
  });
});

import { describe, expect, it } from "vitest";

import { canApprove, canReject, isTerminal } from "@/lib/pipeline/state-machine";

describe("pipeline state machine", () => {
  describe("canApprove", () => {
    it("only allows approval when awaiting review", () => {
      expect(canApprove("awaiting_review")).toBe(true);
      expect(canApprove("agent_generating")).toBe(false);
      expect(canApprove("approved")).toBe(false);
      expect(canApprove("rejected")).toBe(false);
    });
  });

  describe("canReject", () => {
    it("only allows rejection when awaiting review", () => {
      expect(canReject("awaiting_review")).toBe(true);
      expect(canReject("agent_generating")).toBe(false);
      expect(canReject("approved")).toBe(false);
    });
  });

  describe("isTerminal", () => {
    it("identifies terminal phase-status values", () => {
      expect(isTerminal("approved")).toBe(true);
      expect(isTerminal("awaiting_review")).toBe(false);
      expect(isTerminal("agent_generating")).toBe(false);
      expect(isTerminal("rejected")).toBe(false);
    });
  });
});

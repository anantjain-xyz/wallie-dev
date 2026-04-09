import type { PipelinePhase, PipelinePhaseStatus } from "./types";
import { PIPELINE_ESCALATION_THRESHOLD } from "./types";

const PHASE_ORDER: PipelinePhase[] = ["product", "design", "engineering", "shipped"];

export function nextPhase(current: PipelinePhase): PipelinePhase | null {
  const idx = PHASE_ORDER.indexOf(current);
  if (idx === -1 || idx >= PHASE_ORDER.length - 1) return null;
  return PHASE_ORDER[idx + 1]!;
}

export function approvalTimestampField(
  phase: PipelinePhase,
): "product_approved_at" | "design_approved_at" | "engineering_approved_at" | "shipped_at" | null {
  switch (phase) {
    case "product":
      return "product_approved_at";
    case "design":
      return "design_approved_at";
    case "engineering":
      return "engineering_approved_at";
    case "shipped":
      return "shipped_at";
    default:
      return null;
  }
}

export function shouldEscalate(rejectionCount: number): boolean {
  return rejectionCount >= PIPELINE_ESCALATION_THRESHOLD;
}

export function canApprove(phaseStatus: PipelinePhaseStatus): boolean {
  return phaseStatus === "awaiting_review";
}

export function canReject(phaseStatus: PipelinePhaseStatus): boolean {
  return phaseStatus === "awaiting_review";
}

export function isTerminal(phaseStatus: PipelinePhaseStatus): boolean {
  return phaseStatus === "approved" || phaseStatus === "escalated";
}

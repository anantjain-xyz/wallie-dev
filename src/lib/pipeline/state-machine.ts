import type { SessionPhaseStatus } from "@/features/sessions/types";

import { PIPELINE_ESCALATION_THRESHOLD } from "./types";

// Stage ordering used to live here as a hardcoded array. It now lives on
// pipeline_stages.position and is enumerated by the approve_session_stage
// RPC, so this module only owns status-side state checks.

export function shouldEscalate(rejectionCount: number): boolean {
  return rejectionCount >= PIPELINE_ESCALATION_THRESHOLD;
}

export function canApprove(phaseStatus: SessionPhaseStatus): boolean {
  return phaseStatus === "awaiting_review";
}

export function canReject(phaseStatus: SessionPhaseStatus): boolean {
  return phaseStatus === "awaiting_review";
}

export function isTerminal(phaseStatus: SessionPhaseStatus): boolean {
  return phaseStatus === "approved" || phaseStatus === "escalated";
}

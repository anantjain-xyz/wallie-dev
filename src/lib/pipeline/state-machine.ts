import {
  SESSION_PHASE_ORDER,
  type SessionPhase,
  type SessionPhaseStatus,
} from "@/features/sessions/types";

import { PIPELINE_ESCALATION_THRESHOLD } from "./types";

export const PHASE_ORDER = SESSION_PHASE_ORDER;
export type { SessionPhase };

export function isSessionPhase(value: string): value is SessionPhase {
  return (PHASE_ORDER as readonly string[]).includes(value);
}

export function nextPhase(current: SessionPhase): SessionPhase | null {
  const idx = PHASE_ORDER.indexOf(current);
  if (idx === -1 || idx >= PHASE_ORDER.length - 1) return null;
  return PHASE_ORDER[idx + 1]!;
}

export function isTerminalPhase(phase: SessionPhase): boolean {
  return nextPhase(phase) === null;
}

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

import { WORKSPACE_PATH } from "./auth";

/**
 * Deterministic fixture map for OP-361 regression gates.
 * Prefer seeded workspace routes; fall back to /dev and /fixtures when a
 * product route cannot express the state (empty board, forced-colors, etc.).
 */
export const REGRESSION_ROUTES = [
  { auth: false, name: "landing", path: "/" },
  { auth: false, name: "login", path: "/login" },
  { auth: true, name: "pipeline", path: WORKSPACE_PATH },
  { auth: true, name: "sessions", path: `${WORKSPACE_PATH}/sessions` },
  { auth: true, name: "session-detail", path: `${WORKSPACE_PATH}/sessions/1` },
  { auth: true, name: "onboarding", path: `${WORKSPACE_PATH}/onboarding` },
  {
    auth: true,
    name: "settings-integrations",
    path: `${WORKSPACE_PATH}/settings?category=integrations`,
  },
  {
    auth: true,
    name: "settings-pipeline",
    path: `${WORKSPACE_PATH}/settings?category=pipeline`,
  },
  {
    auth: true,
    name: "settings-advanced",
    path: `${WORKSPACE_PATH}/settings?category=advanced`,
  },
  {
    auth: true,
    name: "settings-workspace",
    path: `${WORKSPACE_PATH}/settings?category=workspace`,
  },
] as const;

export type RegressionRouteName = (typeof REGRESSION_ROUTES)[number]["name"];

export const REGRESSION_STATE_FIXTURES = [
  {
    description: "Sessions ledger empty zero-state section",
    name: "empty",
    path: "/dev/sessions-ledger",
    requiresAuth: false,
    setup: "empty-section" as const,
  },
  {
    description: "Seeded sessions list (normal density)",
    name: "normal",
    path: `${WORKSPACE_PATH}/sessions`,
    requiresAuth: true,
  },
  {
    description: "High-density sessions ledger fixture (50 rows)",
    name: "high-density",
    path: "/dev/sessions-ledger",
    requiresAuth: false,
  },
  {
    description: "New-session dialog validation error (invalid Linear URL)",
    name: "validation-error",
    path: `${WORKSPACE_PATH}/sessions/1`,
    requiresAuth: true,
    setup: "validation-error" as const,
  },
  {
    description: "Network error when sessions list API fails",
    name: "network-error",
    path: `${WORKSPACE_PATH}/sessions`,
    requiresAuth: true,
    setup: "network-error" as const,
  },
  {
    description: "Running session (agent_generating)",
    name: "running",
    path: `${WORKSPACE_PATH}/sessions/2`,
    requiresAuth: true,
  },
  {
    description: "Awaiting review session",
    name: "awaiting-review",
    path: `${WORKSPACE_PATH}/sessions/1`,
    requiresAuth: true,
  },
  {
    description: "Changes requested (rejected) session",
    name: "changes-requested",
    path: `${WORKSPACE_PATH}/sessions/10`,
    requiresAuth: true,
  },
  {
    description: "Failed artifact reader fixture",
    name: "failed",
    path: "/fixtures/artifact-reader?view=failed",
    requiresAuth: false,
  },
  {
    description: "Archived + complete session",
    name: "archived",
    path: `${WORKSPACE_PATH}/sessions/6`,
    requiresAuth: true,
  },
  {
    description: "Complete/approved archived session detail",
    name: "complete",
    path: `${WORKSPACE_PATH}/sessions/6`,
    requiresAuth: true,
  },
] as const;

export type RegressionStateName = (typeof REGRESSION_STATE_FIXTURES)[number]["name"];

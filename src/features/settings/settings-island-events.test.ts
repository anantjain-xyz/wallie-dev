// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import {
  dispatchSettingsEvent,
  peekSettingsSecrets,
  peekSettingsVercelConnection,
  resetSettingsIslandSnapshotsForTests,
  SETTINGS_SECRETS_CHANGED,
  SETTINGS_VERCEL_CHANGED,
} from "@/features/settings/settings-island-events";
import type { WorkspaceSecretPreview } from "@/lib/secrets/contracts";
import type { VercelSandboxConnectionPreview } from "@/lib/vercel-sandbox/contracts";

afterEach(() => {
  resetSettingsIslandSnapshotsForTests();
});

const connection: VercelSandboxConnectionPreview = {
  lastValidatedAt: "2026-07-19T00:00:00.000Z",
  lastValidationError: null,
  projectId: "prj_new",
  projectName: "sandboxes",
  status: "connected",
  teamId: "team_new",
  tokenPreview: "vcl_…abcd",
  updatedAt: "2026-07-19T00:00:00.000Z",
  workspaceId: "ws-1",
};

const secrets: WorkspaceSecretPreview[] = [
  {
    createdAt: "2026-07-19T00:00:00.000Z",
    createdByMemberId: null,
    id: "secret-1",
    key: "LINEAR_API_KEY",
    updatedAt: "2026-07-19T00:00:00.000Z",
    valuePreview: "lin_…abcd",
    workspaceId: "ws-1",
  },
];

describe("settings island snapshots", () => {
  it("survives category unmount so remounted islands see the latest Vercel connection", () => {
    dispatchSettingsEvent(SETTINGS_VERCEL_CHANGED, connection);

    expect(
      peekSettingsVercelConnection({
        ...connection,
        projectId: "prj_old",
        status: "error",
      }),
    ).toEqual(connection);
  });

  it("survives category unmount so remounted islands see the latest secrets list", () => {
    dispatchSettingsEvent(SETTINGS_SECRETS_CHANGED, secrets);

    expect(peekSettingsSecrets([])).toEqual(secrets);
  });
});

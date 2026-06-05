import { describe, expect, it } from "vitest";

import { buildWorkspaceInvitationAcceptUrl } from "@/lib/workspace-invitations/server";

describe("workspace invitation server helpers", () => {
  it("routes email links through auth confirmation before invitation acceptance", () => {
    expect(buildWorkspaceInvitationAcceptUrl("http://localhost/api/invitations", "raw-token")).toBe(
      "http://localhost/auth/confirm?next=%2Finvite%2Fraw-token",
    );
  });
});

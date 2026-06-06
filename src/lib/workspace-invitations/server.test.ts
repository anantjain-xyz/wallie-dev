import { describe, expect, it } from "vitest";

import { buildWorkspaceInvitationAcceptUrl } from "@/lib/workspace-invitations/server";

describe("workspace invitation server helpers", () => {
  it("routes email links through auth confirmation before invitation acceptance", () => {
    expect(
      buildWorkspaceInvitationAcceptUrl("raw-token", {
        NEXT_PUBLIC_APP_URL: "https://www.wallie.dev",
      }),
    ).toBe("https://www.wallie.dev/auth/confirm?next=%2Finvite%2Fraw-token");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const initMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260422000000_init.sql"),
  "utf8",
);
const invitationsMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260605000000_add_workspace_invitations.sql"),
  "utf8",
);

describe("workspace invitations schema", () => {
  it("keeps invitation schema out of the already-applied init migration", () => {
    expect(initMigration).not.toContain("workspace_invitation_status");
    expect(initMigration).not.toContain("workspace_invitations");
    expect(initMigration).not.toContain("accept_workspace_invitation");
  });

  it("creates invitations through a forward migration", () => {
    expect(invitationsMigration).toContain("create type public.workspace_invitation_status");
    expect(invitationsMigration).toContain(
      "create table if not exists public.workspace_invitations",
    );
    expect(invitationsMigration).toContain("workspace_invitations_one_pending_per_workspace_email");
    expect(invitationsMigration).toContain("internal.enforce_workspace_invitation_refs");
    expect(invitationsMigration).toContain("public.accept_workspace_invitation");
    expect(invitationsMigration).toContain(
      "grant execute on function public.accept_workspace_invitation",
    );
  });
});

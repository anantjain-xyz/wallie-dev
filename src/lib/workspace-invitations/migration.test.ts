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
const displayNameMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260816203506_add_member_display_names.sql"),
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

  it("adds backward-compatible invitation names and preserves identity precedence", () => {
    expect(displayNameMigration).toContain("add column full_name text");
    expect(displayNameMigration).toContain("workspace_invitations_full_name_check");

    const acceptFunction = displayNameMigration.slice(
      displayNameMigration.indexOf("create or replace function public.accept_workspace_invitation"),
    );
    const profileName = acceptFunction.indexOf("actor_profile.full_name");
    const memberName = acceptFunction.indexOf("existing_member.full_name");
    const invitationName = acceptFunction.indexOf("target_invitation.full_name");
    const authName = acceptFunction.indexOf("btrim(actor_full_name)");

    expect(profileName).toBeGreaterThan(-1);
    expect(memberName).toBeGreaterThan(profileName);
    expect(invitationName).toBeGreaterThan(memberName);
    expect(authName).toBeGreaterThan(invitationName);
  });

  it("keeps account-wide display-name writes service-role only", () => {
    expect(displayNameMigration).toContain("public.update_user_display_name");
    expect(displayNameMigration).toContain(
      "revoke all on function public.update_user_display_name(uuid, text)",
    );
    expect(displayNameMigration).toContain(
      "grant execute on function public.update_user_display_name(uuid, text)",
    );
    expect(displayNameMigration).toContain("to service_role");
    expect(displayNameMigration).toContain("public.ensure_own_profile");
    expect(displayNameMigration).toContain("to authenticated");
  });
});

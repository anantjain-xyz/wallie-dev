import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260823133717_add_user_profile_avatars.sql"),
  "utf8",
);

describe("profile avatar migration", () => {
  it("creates a constrained public image bucket", () => {
    expect(migration).toContain("'profile-avatars'");
    expect(migration).toContain("2097152");
    expect(migration).toContain("array['image/jpeg', 'image/png', 'image/webp']");
  });

  it("persists explicit upload and removal choices across auth refreshes", () => {
    expect(migration).toContain("add column avatar_path text");
    expect(migration).toContain("add column avatar_overridden boolean not null default false");
    expect(migration).toContain("when profile.avatar_overridden then profile.avatar_url");
    expect(migration).toContain("workspace_members_preserve_profile_avatar_override");
    expect(migration).toContain("and avatar_url is distinct from saved_profile.avatar_url");
    expect(migration).toContain("create or replace function public.accept_workspace_invitation");
    expect(migration).toContain(
      "when actor_profile.avatar_overridden then actor_profile.avatar_url",
    );
  });

  it("publishes names and avatars to every human membership transactionally", () => {
    const profileFunction = migration.slice(
      migration.indexOf("create or replace function public.update_user_profile"),
      migration.indexOf("-- Retain the existing service-role API"),
    );

    expect(profileFunction).toContain("pg_advisory_xact_lock");
    expect(profileFunction).toContain("previous_avatar_path");
    expect(profileFunction).toContain("superseded_avatar_path");
    expect(profileFunction).toContain("legacy_avatar_url");
    expect(profileFunction).toContain("if not profile_exists and not actor_avatar_changed");
    expect(profileFunction).toContain("update public.workspace_members");
    expect(profileFunction).toContain("avatar_url = saved_profile.avatar_url");
    expect(profileFunction).toContain("and kind = 'human'");
  });

  it("keeps both profile mutation functions service-role only", () => {
    expect(migration).toContain(
      "revoke all on function public.update_user_profile(uuid, text, boolean, text, text)",
    );
    expect(migration).toContain(
      "grant execute on function public.update_user_profile(uuid, text, boolean, text, text)",
    );
    expect(migration).toContain("to service_role");
    expect(migration).toContain("public.update_user_display_name");
  });
});

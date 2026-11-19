import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { pruneFactoryOAuthCredentials } from "./maintenance";

it("submits one bounded cleanup batch and reports only the deleted row counts", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ authorizations_deleted: 3, token_pairs_deleted: 7 }));
  const admin = createClient<Database>("https://supabase.example.test", "fixture", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch },
  });

  await expect(pruneFactoryOAuthCredentials(admin)).resolves.toEqual({
    authorizationsDeleted: 3,
    tokenPairsDeleted: 7,
  });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://supabase.example.test/rest/v1/rpc/prune_factory_oauth_credentials",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ p_batch_size: 200 }) }),
  );
});

it("leaves a failed cleanup batch for the next tick without exposing database diagnostics", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ message: "Private database diagnostic" }, { status: 500 }));
  const admin = createClient<Database>("https://supabase.example.test", "fixture", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch },
  });

  await expect(pruneFactoryOAuthCredentials(admin)).rejects.toThrow(
    "Could not prune expired OAuth credentials.",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

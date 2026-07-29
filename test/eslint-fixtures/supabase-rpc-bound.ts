import type { SupabaseClient } from "@supabase/supabase-js";

type Rpc = (name: string) => Promise<unknown>;

declare const client: SupabaseClient;

void client.rpc("direct_rpc");

const alias = client as SupabaseClient;
void (alias.rpc as unknown as Rpc)("cast_direct_rpc");

const boundRpc = (alias.rpc as unknown as Rpc).bind(alias);
void boundRpc;

import type { SupabaseClient } from "@supabase/supabase-js";

type Rpc = (name: string) => Promise<unknown>;
type RpcOwner = { rpc: SupabaseClient["rpc"] };

declare const client: SupabaseClient;

void client.rpc("direct_rpc");
void client[`rpc`]("template_literal_direct_rpc");
void (client.rpc satisfies SupabaseClient["rpc"])("satisfies_direct_rpc");
void (client as unknown as RpcOwner).rpc("cast_receiver_direct_rpc");

const alias = client as SupabaseClient;
void (alias.rpc as unknown as Rpc)("cast_direct_rpc");

const boundRpc = (alias.rpc as unknown as Rpc).bind(alias);
void boundRpc;

import type { SupabaseClient } from "@supabase/supabase-js";

type Rpc = (name: string) => Promise<unknown>;

declare const client: SupabaseClient;

function acceptRpc(callback: typeof client.rpc) {
  void callback;
}

const alias = client as SupabaseClient;
const rawRpc = alias.rpc;
const castRpc = alias.rpc as unknown as Rpc;
const { rpc: destructuredRpc } = alias;
acceptRpc(alias.rpc);

void rawRpc;
void castRpc;
void destructuredRpc;

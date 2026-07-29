import type { SupabaseClient } from "@supabase/supabase-js";

type Rpc = (name: string) => Promise<unknown>;
type RpcOwner = { rpc: SupabaseClient["rpc"] };

declare const client: SupabaseClient;
declare const clients: SupabaseClient[];

function acceptRpc(callback: typeof client.rpc) {
  void callback;
}

const alias = client as SupabaseClient;
const rawRpc = alias.rpc;
const castRpc = alias.rpc as unknown as Rpc;
const { rpc: destructuredRpc } = alias;
acceptRpc(alias.rpc);
const castReceiverRpc = (alias as unknown as RpcOwner).rpc;
const effectfulBoundRpc = clients.shift()!.rpc.bind(clients.shift()!);
const templateLiteralRpc = alias[`rpc`];

void rawRpc;
void castRpc;
void destructuredRpc;
void castReceiverRpc;
void effectfulBoundRpc;
void templateLiteralRpc;

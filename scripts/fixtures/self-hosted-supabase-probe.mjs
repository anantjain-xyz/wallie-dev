import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const checked = async (request, label) => {
  const { data, error } = await request;
  if (error) throw new Error(`${label} failed (${error.code ?? error.status ?? "API error"})`);
  return data;
};

async function expectStorageDenied(request, label) {
  const { data, error } = await request;
  assert.ok(error && !data, label);
  assert.ok([400, 401, 403, 404].includes(Number(error.statusCode ?? error.status)), label);
}

async function checkRealtime(client, workspaceId, mutate, signal) {
  signal.throwIfAborted();
  const channel = client.channel(`qualification-${randomUUID()}`);
  const expectedName = `Realtime proof ${randomUUID()}`;
  let timer;
  let triggered = false;
  let onAbort;
  try {
    await new Promise((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => reject(new Error("Realtime update timed out")), 30_000);
      channel
        // SUBSCRIBED can precede the database listener; wait for backend readiness.
        // https://supabase.com/docs/guides/troubleshooting/realtime-postgres-changes-troubleshooting
        .on("system", "*", (payload) => {
          if (signal.aborted) return;
          if (payload.extension !== "postgres_changes") return;
          if (payload.status === "ok" && !triggered) {
            triggered = true;
            mutate(expectedName).catch(reject);
          } else if (payload.status !== "ok") {
            reject(new Error(`Realtime database listener failed (${payload.status})`));
          }
        })
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "workspaces",
            filter: `id=eq.${workspaceId}`,
          },
          (payload) => {
            if (payload.new.id === workspaceId && payload.new.name === expectedName) resolve();
          },
        )
        .subscribe((status) => {
          if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
            reject(new Error(`Realtime subscription failed (${status})`));
          }
        });
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    // This probe owns the socket; stop it without waiting for a remote leave acknowledgement.
    channel.teardown();
    void client.realtime.disconnect();
  }
}

/** Exercise disposable, local self-hosted services; this does not qualify AWS or recovery. */
export async function checkSelfHostedSupabase({
  url,
  anonKey,
  serviceRoleKey,
  signal = new AbortController().signal,
}) {
  signal.throwIfAborted();
  const endpoint = new URL(url);
  assert.ok(
    endpoint.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) &&
      !endpoint.username &&
      !endpoint.password &&
      endpoint.pathname === "/" &&
      !endpoint.search &&
      !endpoint.hash,
    "The destructive fixture probe requires a loopback HTTP origin",
  );
  const boundedFetch = (input, init = {}) => {
    signal.throwIfAborted();
    return fetch(input, {
      ...init,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(15_000),
        ...[init.signal].filter(Boolean),
      ]),
    });
  };
  const options = {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: boundedFetch },
  };
  const admin = createClient(url, serviceRoleKey, options);
  const users = [];
  const workspaceIds = [];
  const storagePaths = [];
  const bucket = "session-attachments";
  let failure;
  try {
    for (const name of ["Owner", "Other tenant"]) {
      const email = `qualification-${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const { user } = await checked(
        admin.auth.admin.createUser({ email, password, email_confirm: true }),
        "Create synthetic Auth user",
      );
      assert.ok(user?.id, "Auth must return a user ID");
      const client = createClient(url, anonKey, options);
      users.push({ id: user.id, client });
      const session = await checked(client.auth.signInWithPassword({ email, password }), "Sign in");
      assert.equal(session.user?.id, user.id, "Auth session must identify the synthetic user");
      assert.ok(session.session?.access_token, "Auth must issue an access token");
      const profile = await checked(
        client.rpc("ensure_own_profile", { actor_email: email, actor_full_name: name }),
        "Authenticated profile RPC",
      );
      assert.equal(profile.id, user.id, "RPC must derive ownership from the user's JWT");
      assert.equal(profile.full_name, name);
      const workspace = await checked(
        admin.rpc("create_workspace", {
          actor_user_id: user.id,
          workspace_name: `Qualification ${name}`,
          requested_slug: `qualification-${randomUUID()}`,
          actor_email: email,
        }),
        "Create synthetic workspace",
      );
      assert.ok(workspace?.id, "Workspace RPC must return its created row");
      workspaceIds.push(workspace.id);
    }
    const [owner, other] = users;
    for (const [index, user] of users.entries()) {
      const visible = await checked(
        user.client.from("workspaces").select("id").in("id", workspaceIds),
        "Read workspace with user JWT",
      );
      assert.deepEqual(
        visible.map((row) => row.id),
        [workspaceIds[index]],
        "RLS must isolate tenants",
      );
    }
    const privateProfile = await checked(
      other.client.from("profiles").select("id").eq("id", owner.id),
      "Read another user's profile",
    );
    assert.deepEqual(privateProfile, [], "Profile RLS must hide the other user");

    await checkRealtime(
      owner.client,
      workspaceIds[0],
      (name) =>
        checked(
          admin.from("workspaces").update({ name }).eq("id", workspaceIds[0]).select("id").single(),
          "Publish owned workspace update",
        ),
      signal,
    );

    // Wallie mediates private attachments through privileged routes and signed URLs.
    // Browser clients intentionally have no direct storage.objects policies.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6o0AAAAASUVORK5CYII=",
      "base64",
    );
    const path = `${workspaceIds[0]}/qualification-${randomUUID()}.png`;
    storagePaths.push(path);
    await checked(
      admin.storage.from(bucket).upload(path, png, { contentType: "image/png" }),
      "Upload",
    );
    const download = await checked(
      admin.storage.from(bucket).download(path),
      "Privileged download",
    );
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), png, "Storage must preserve bytes");
    for (const user of users) {
      await expectStorageDenied(
        user.client.storage.from(bucket).download(path),
        "Private attachment download must require privileged mediation",
      );
      const forbiddenPath = `${workspaceIds[0]}/qualification-denied-${randomUUID()}.png`;
      storagePaths.push(forbiddenPath);
      await expectStorageDenied(
        user.client.storage.from(bucket).upload(forbiddenPath, png, { contentType: "image/png" }),
        "Private attachment upload must require privileged mediation",
      );
    }
    const signed = await checked(
      admin.storage.from(bucket).createSignedUrl(path, 60),
      "Sign download",
    );
    const response = await boundedFetch(signed.signedUrl);
    assert.equal(response.status, 200, "Signed attachment URL must authorize download");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  } catch (error) {
    failure = error;
  }

  // Cancellation hands cleanup to the runner, which destroys the owned Compose project.
  signal.throwIfAborted();
  // Attempt every cleanup even if a check failed. Never touch the shared seed fixtures.
  const cleanupFailures = [];
  const cleanup = async (operation, label) => {
    signal.throwIfAborted();
    try {
      await checked(operation(), label);
    } catch (error) {
      cleanupFailures.push(error);
    }
  };
  if (storagePaths.length) {
    await cleanup(() => admin.storage.from(bucket).remove(storagePaths), "Remove probe objects");
  }
  if (workspaceIds.length) {
    await cleanup(
      () => admin.from("workspaces").delete().in("id", workspaceIds),
      "Remove probe workspaces",
    );
  }
  for (const user of users) {
    await cleanup(() => user.client.auth.signOut({ scope: "local" }), "Sign out probe user");
    await cleanup(() => admin.auth.admin.deleteUser(user.id), "Remove probe Auth user");
  }
  signal.throwIfAborted();
  if (failure || cleanupFailures.length) {
    const errors = [...(failure ? [failure] : []), ...cleanupFailures];
    throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
  }
  return {
    auth: "password sign-in with two synthetic users",
    rest: "workspace and profile isolation through user JWTs",
    rpc: "authenticated profile creation and service workspace creation",
    realtime: "published workspace update delivered to its authenticated member",
    storage: "private upload, byte-exact download, signed URL, and direct-user denial",
  };
}

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => mock }));

import {
  advanceGitHubInstallFlow,
  consumeGitHubInstallFlow,
  createGitHubInstallFlow,
  githubCodeChallenge,
  githubInstallCookieOptions,
  hashGitHubState,
  loadGitHubInstallFlow,
  matchesGitHubStateCookie,
  type GitHubInstallFlow,
} from "./state";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import { verifyGitHubWebhookRequest } from "./webhooks";

type Row = Record<string, unknown>;
let rows: Row[];

// Execute filters against an in-memory table so missing user, expiry, or CAS guards fail tests.
function query() {
  let operation = "select";
  let values: Row = {};
  const filters: ((row: Row) => boolean)[] = [];
  function execute() {
    const matches = rows.filter((row) => filters.every((test) => test(row)));
    if (operation === "insert") rows.push({ phase: "install", installation_id: null, ...values });
    if (operation === "update") matches.forEach((row) => Object.assign(row, values));
    if (operation === "delete") rows = rows.filter((row) => !matches.includes(row));
    return { data: matches[0] ? { ...matches[0] } : null, error: null };
  }
  const builder = {
    select: () => builder,
    insert: (input: Row) => {
      operation = "insert";
      values = input;
      return builder;
    },
    update: (input: Row) => {
      operation = "update";
      values = input;
      return builder;
    },
    delete: () => {
      operation = "delete";
      return builder;
    },
    eq: (key: string, value: unknown) => {
      filters.push((row) => row[key] === value);
      return builder;
    },
    gt: (key: string, value: string) => {
      filters.push((row) => String(row[key]) > value);
      return builder;
    },
    lt: (key: string, value: string) => {
      filters.push((row) => String(row[key]) < value);
      return builder;
    },
    maybeSingle: async () => execute(),
    then: (resolve: (value: ReturnType<typeof execute>) => unknown) =>
      Promise.resolve(execute()).then(resolve),
  };
  return builder;
}

const input = { source: "settings" as const, userId: "user-a", workspaceId: "workspace-a" };

beforeEach(() => {
  rows = [];
  mock.from.mockReset().mockImplementation((table: string) => {
    expect(table).toBe("github_install_flows");
    return query();
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T00:00:00Z"));
  vi.stubEnv("WALLIE_ENCRYPTION_KEY", "a".repeat(64));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function start() {
  const state = await createGitHubInstallFlow(input);
  const flow = await loadGitHubInstallFlow(state, input.userId);
  expect(flow).not.toBeNull();
  return { state, flow: flow as GitHubInstallFlow };
}

describe("GitHub install flows", () => {
  it("stores only a state hash and encrypted independent PKCE verifier, expiring in ten minutes", async () => {
    const { state, flow } = await start();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.state_hash).toBe(hashGitHubState(state));
    expect(JSON.stringify(rows)).not.toContain(state);
    const verifier = decryptSecretValue(flow.encrypted_code_verifier);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifier).not.toBe(state);
    expect(JSON.stringify(rows)).not.toContain(verifier);
    expect(flow.expires_at).toBe("2026-09-08T00:10:00.000Z");
    expect(await createGitHubInstallFlow(input)).not.toBe(state);
  });

  it("denies other users, unknown states, and expired flows", async () => {
    const { state } = await start();
    expect(await loadGitHubInstallFlow(state, "user-b")).toBeNull();
    expect(await loadGitHubInstallFlow("x".repeat(43), input.userId)).toBeNull();
    vi.advanceTimersByTime(600_000);
    expect(await loadGitHubInstallFlow(state, input.userId)).toBeNull();
  });

  it("advances once and consumes once, retaining the candidate from the winning callback", async () => {
    const { state, flow } = await start();
    expect(
      await Promise.all([advanceGitHubInstallFlow(flow, 42), advanceGitHubInstallFlow(flow, 99)]),
    ).toEqual([true, false]);
    const authorized = (await loadGitHubInstallFlow(state, input.userId)) as GitHubInstallFlow;
    expect(authorized.installation_id).toBe(42);
    expect(
      await Promise.all([
        consumeGitHubInstallFlow(authorized),
        consumeGitHubInstallFlow(authorized),
      ]),
    ).toEqual([true, false]);
    expect(await loadGitHubInstallFlow(state, input.userId)).toBeNull();
  });

  it("refuses to consume the install phase or a changed identity, workspace, or candidate", async () => {
    const { state, flow } = await start();
    expect(await consumeGitHubInstallFlow(flow)).toBe(false);
    expect(await advanceGitHubInstallFlow({ ...flow, user_id: "user-b" }, 42)).toBe(false);
    expect(await advanceGitHubInstallFlow({ ...flow, workspace_id: "workspace-b" }, 42)).toBe(
      false,
    );
    await advanceGitHubInstallFlow(flow, 42);
    const authorized = (await loadGitHubInstallFlow(state, input.userId)) as GitHubInstallFlow;
    for (const altered of [
      { user_id: "user-b" },
      { workspace_id: "workspace-b" },
      { installation_id: 99 },
    ]) {
      expect(await consumeGitHubInstallFlow({ ...authorized, ...altered })).toBe(false);
    }
    expect(await consumeGitHubInstallFlow(authorized)).toBe(true);
  });

  it("rechecks expiry at both mutations after a flow was loaded", async () => {
    const { flow } = await start();
    vi.advanceTimersByTime(600_000);
    expect(await advanceGitHubInstallFlow(flow, 42)).toBe(false);
    vi.setSystemTime(new Date("2026-09-08T00:00:00Z"));
    await advanceGitHubInstallFlow(flow, 42);
    const authorized = { ...flow, installation_id: 42, phase: "authorize" };
    vi.advanceTimersByTime(600_000);
    expect(await consumeGitHubInstallFlow(authorized)).toBe(false);
  });

  it("only cleans up expired flows for the current user", async () => {
    await start();
    await createGitHubInstallFlow({ ...input, userId: "user-b" });
    vi.advanceTimersByTime(600_001);
    await start();
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.user_id === "user-b")).toBe(true);
  });
});

describe("browser binding and PKCE", () => {
  it.each([null, undefined, "", "signed.payload", "x".repeat(42), "x".repeat(44), "!".repeat(43)])(
    "rejects malformed state %s",
    (state) => {
      expect(matchesGitHubStateCookie(state, state)).toBe(false);
    },
  );
  it("requires the exact flow cookie and limits its scope", () => {
    const state = "a".repeat(43);
    expect(matchesGitHubStateCookie(state, state)).toBe(true);
    expect(matchesGitHubStateCookie(state, "b".repeat(43))).toBe(false);
    expect(matchesGitHubStateCookie(state, undefined)).toBe(false);
    expect(githubInstallCookieOptions("https://wallie.dev")).toEqual({
      httpOnly: true,
      maxAge: 600,
      path: "/api/github",
      sameSite: "lax",
      secure: true,
    });
    expect(githubInstallCookieOptions("http://localhost:3000").secure).toBe(false);
  });
  it("matches the RFC 7636 S256 example", () => {
    expect(githubCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

it("preserves valid webhook signature verification", async () => {
  const env = {
    NEXT_PUBLIC_APP_URL: "https://wallie.dev",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public-key",
    SUPABASE_SECRET_KEY: "secret-key",
    WALLIE_ENCRYPTION_KEY: "a".repeat(64),
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
  };
  const payload = JSON.stringify({ installation: { id: 42 } });
  const signature = `sha256=${createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(payload).digest("hex")}`;
  expect(await verifyGitHubWebhookRequest(payload, signature, env)).toBe(true);
  expect(await verifyGitHubWebhookRequest(payload, "sha256=deadbeef", env)).toBe(false);
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("deploys native orchestration with dispatch disabled until live qualification", () => {
  const path = resolve("wrangler.jsonc");
  const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  expect(error).toBeUndefined();
  expect(config.main).toBe("cloudflare/index.ts");
  expect(config.vars.WALLIE_WORKER_DISPATCH_ENABLED).toBe("false");
  expect(config.vars.WALLIE_ENABLED_SANDBOX_PROVIDERS).toBe("vercel,e2b,daytona");
  expect(config.triggers.crons).toEqual(["* * * * *"]);
  expect(config.workflows.map((workflow: { class_name: string }) => workflow.class_name)).toEqual([
    "SessionAttemptWorkflow",
    "CursorAuthWorkflow",
    "MaintenanceWorkflow",
  ]);
  expect(config.alias["server-only"]).toBe("./cloudflare/server-only.ts");
  expect(config.alias["isomorphic-ws"]).toBe("./cloudflare/websocket.ts");
  expect(config.alias.undici).toBe("./cloudflare/undici.ts");
  for (const secret of [
    "SUPABASE_SECRET_KEY",
    "WALLIE_ENCRYPTION_KEY",
    "GITHUB_APP_PRIVATE_KEY",
    "WALLIE_WORKER_WAKE_SECRET",
  ]) {
    expect(config.vars).not.toHaveProperty(secret);
  }
});

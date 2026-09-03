import type { PrivilegedImportBoundaryConfig } from "./verify-privileged-imports";

export const privilegedImportBoundaryConfig = {
  browserEntryPoints: ["src/lib/supabase/browser.ts"],
  exceptions: [],
  // `privileged-route` approves ALL route handlers (`src/app` files named
  // route.ts), not a curated subset. Combined with `worker` and
  // `server-service`, this enforces the browser/server wall (browser and
  // non-server modules cannot reach admin/env/crypto) but not the
  // RLS-versus-admin choice inside server code. Narrowing
  // `privileged-route` to a specific allowlist of routes that truly need
  // service-role would be a future improvement.
  ownerRules: [
    {
      boundary: "worker-runtime",
      description: "worker runtime (src/worker/**)",
      id: "worker",
      pathPrefix: "src/worker/",
    },
    {
      boundary: "next-route",
      description: "privileged Next.js route (src/app/**/route.ts)",
      id: "privileged-route",
      pathPrefix: "src/app/",
      pathSuffix: "/route.ts",
    },
    {
      boundary: "server-only-import",
      description: 'server service (direct import of "server-only")',
      id: "server-service",
    },
  ],
  privilegedModules: [
    {
      approvedOwnerIds: ["worker", "privileged-route", "server-service"],
      description: "service-role Supabase client",
      path: "src/lib/supabase/admin.ts",
      requiresServerOnlyImport: true,
    },
    {
      approvedOwnerIds: ["worker", "privileged-route", "server-service"],
      description: "server environment",
      path: "src/env/server.ts",
      requiresServerOnlyImport: true,
    },
    {
      approvedOwnerIds: ["worker", "privileged-route", "server-service"],
      description: "workspace secret crypto",
      path: "src/lib/secrets/crypto.ts",
      requiresServerOnlyImport: true,
    },
  ],
  sourceRoots: ["src"],
} satisfies PrivilegedImportBoundaryConfig;

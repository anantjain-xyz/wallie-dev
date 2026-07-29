import type { PrivilegedImportBoundaryConfig } from "./verify-privileged-imports";

export const privilegedImportBoundaryConfig = {
  browserEntryPoints: ["src/lib/supabase/browser.ts"],
  exceptions: [],
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

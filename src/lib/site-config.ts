export const siteConfig = {
  name: "Wallie",
  description: "Cloud-native rebuild scaffold for wallie.cc on Next.js App Router and Supabase.",
  sampleWorkspaceSlug: "northwind-labs",
  references: [
    "docs/reference/cloud-rebuild-handoff.md",
    "docs/reference/cloud-rebuild-execution-graph.md",
  ],
  principles: [
    "Keep the old wallie repo read-only and treat this repo as the only write target.",
    "Build directly for Supabase Auth, Postgres, Realtime, and Storage on Vercel.",
    "Avoid reviving ElectricSQL, PGlite, proxy servers, or offline-first sync layers.",
  ],
} as const;

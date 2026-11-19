import type { NextConfig } from "next";

import { buildImageOptimizerConfig } from "./src/lib/storage/image-optimizer-config";
import { SESSION_PAGE_DATA_SERVER_TIMING } from "./src/lib/performance/session-prefetch";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/oauth/authorize",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          // Native consent POSTs need the browser to include its origin.
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
      {
        source: "/w/:workspaceSlug/sessions/:sessionNumber([1-9]\\d*)",
        has: [
          { type: "header", key: "rsc", value: "1" },
          { type: "header", key: "next-router-state-tree" },
        ],
        missing: [
          { type: "header", key: "next-router-prefetch" },
          { type: "header", key: "next-router-segment-prefetch" },
        ],
        headers: [{ key: "Server-Timing", value: SESSION_PAGE_DATA_SERVER_TIMING }],
      },
    ];
  },
  images: buildImageOptimizerConfig(process.env.NEXT_PUBLIC_SUPABASE_URL),
  reactStrictMode: true,
  serverExternalPackages: ["@cursor/sdk"],
};

export default nextConfig;

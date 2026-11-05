import type { NextConfig } from "next";

import { buildImageOptimizerConfig } from "./src/lib/storage/image-optimizer-config";
import { SESSION_PAGE_DATA_SERVER_TIMING } from "./src/lib/performance/session-prefetch";

const nextConfig: NextConfig = {
  async headers() {
    return [
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

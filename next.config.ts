import type { NextConfig } from "next";

import { buildImageOptimizerConfig } from "./src/lib/storage/image-optimizer-config";

const nextConfig: NextConfig = {
  images: buildImageOptimizerConfig(process.env.NEXT_PUBLIC_SUPABASE_URL),
  reactStrictMode: true,
  serverExternalPackages: ["@cursor/sdk"],
};

export default nextConfig;

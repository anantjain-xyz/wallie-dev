import type { NextConfig } from "next";

type ImageConfig = NonNullable<NextConfig["images"]>;

export function buildImageOptimizerConfig(supabaseUrl: string | undefined): ImageConfig {
  const config: ImageConfig = {
    // Redirect destinations are not checked against remotePatterns by Next.js.
    maximumRedirects: 0,
    remotePatterns: [],
    dangerouslyAllowLocalIP: false,
  };

  if (!supabaseUrl) return config;

  let url: URL;
  try {
    url = new URL(supabaseUrl);
  } catch {
    return config;
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    !/^[a-z0-9.-]+$/i.test(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return config;
  }

  // Only explicitly configured loopback development storage needs this opt-in.
  config.dangerouslyAllowLocalIP = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  config.remotePatterns = ["workspace-avatars", "profile-avatars"].map((bucket) => ({
    protocol: url.protocol === "https:" ? "https" : "http",
    hostname: url.hostname,
    port: url.port,
    pathname: `/storage/v1/object/public/${bucket}/**`,
    search: "",
  }));

  return config;
}

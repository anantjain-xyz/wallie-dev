import { hasRemoteMatch } from "next/dist/shared/lib/match-remote-pattern";
import { describe, expect, it, vi } from "vitest";

import { buildImageOptimizerConfig } from "./image-optimizer-config";

const configuredOrigin = "https://wallie-project.supabase.co";
const avatarPath = "/storage/v1/object/public/workspace-avatars/workspace/avatar.png";

function canOptimize(supabaseUrl: string | undefined, imageUrl: string) {
  const config = buildImageOptimizerConfig(supabaseUrl);
  return hasRemoteMatch([], config.remotePatterns ?? [], new URL(imageUrl));
}

describe("image optimizer storage boundary", () => {
  it.each(["workspace-avatars", "profile-avatars"])(
    "allows the configured project's public %s bucket",
    (bucket) => {
      expect(
        canOptimize(
          configuredOrigin,
          `${configuredOrigin}/storage/v1/object/public/${bucket}/owner/avatar.png`,
        ),
      ).toBe(true);
    },
  );

  it.each([
    `https://attacker-project.supabase.co${avatarPath}`,
    `https://sub.wallie-project.supabase.co${avatarPath}`,
    `https://wallie-project.supabase.co.attacker.example${avatarPath}`,
    `http://wallie-project.supabase.co${avatarPath}`,
    `https://wallie-project.supabase.co:8443${avatarPath}`,
    `http://127.0.0.1:54321${avatarPath}`,
    `${configuredOrigin}/storage/v1/object/public/session-attachments/owner/image.png`,
    `${configuredOrigin}/storage/v1/object/public/arbitrary-bucket/image.avif`,
    `${configuredOrigin}/storage/v1/object/sign/workspace-avatars/owner/avatar.png`,
    `${configuredOrigin}/storage/v1/object/public/workspace-avatars-other/avatar.png`,
    `${configuredOrigin}/storage/v1/object/public/workspace-avatars/../other/image.png`,
    `${configuredOrigin}${avatarPath}?download=1`,
  ])("rejects image sources outside the configured avatar boundary: %s", (imageUrl) => {
    expect(canOptimize(configuredOrigin, imageUrl)).toBe(false);
  });

  it.each(["http://localhost:54321", "http://127.0.0.1:54321"])(
    "supports exactly the explicitly configured local origin %s",
    (origin) => {
      expect(canOptimize(origin, `${origin}${avatarPath}`)).toBe(true);
      expect(canOptimize(origin, `${configuredOrigin}${avatarPath}`)).toBe(false);
      expect(canOptimize(origin, `${origin.replace("54321", "54322")}${avatarPath}`)).toBe(false);
      expect(buildImageOptimizerConfig(origin).dangerouslyAllowLocalIP).toBe(true);
    },
  );

  it("supports a configured custom Supabase domain without permitting other ports", () => {
    const origin = "https://storage.example.com:8443";
    expect(canOptimize(origin, `${origin}${avatarPath}`)).toBe(true);
    expect(canOptimize(origin, `https://storage.example.com${avatarPath}`)).toBe(false);
    expect(buildImageOptimizerConfig(origin).dangerouslyAllowLocalIP).toBe(false);
  });

  it.each([
    undefined,
    "",
    "not a URL",
    "ftp://wallie-project.supabase.co",
    "https://*.supabase.co",
    "https://(wallie-project|attacker).supabase.co",
    "https://user:password@wallie-project.supabase.co",
    "https://wallie-project.supabase.co/unexpected-base-path",
    "https://wallie-project.supabase.co?redirect=1",
    "https://wallie-project.supabase.co#fragment",
  ])("fails closed for missing or invalid storage configuration: %s", (origin) => {
    expect(canOptimize(origin, `${configuredOrigin}${avatarPath}`)).toBe(false);
    expect(buildImageOptimizerConfig(origin).dangerouslyAllowLocalIP).toBe(false);
  });

  it("disables redirects so an allowed storage response cannot escape the origin boundary", () => {
    expect(buildImageOptimizerConfig(configuredOrigin).maximumRedirects).toBe(0);
    expect(buildImageOptimizerConfig("http://localhost:54321").maximumRedirects).toBe(0);
  });

  it("wires the configured storage origin into Next.js", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", configuredOrigin);
    vi.resetModules();
    try {
      const { default: nextConfig } = await import("../../../next.config");
      expect(
        hasRemoteMatch(
          [],
          nextConfig.images?.remotePatterns ?? [],
          new URL(`${configuredOrigin}${avatarPath}`),
        ),
      ).toBe(true);
      expect(
        hasRemoteMatch(
          [],
          nextConfig.images?.remotePatterns ?? [],
          new URL(`https://attacker-project.supabase.co${avatarPath}`),
        ),
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

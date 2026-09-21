import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  IBM_Plex_Mono: () => ({ variable: "font-mono" }),
  Inter: () => ({ variable: "font-sans" }),
}));
vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));

import RootLayout, { generateMetadata } from "./layout";
import { useSupabasePublicConfig } from "@/lib/supabase/public-config-provider";

function PublicConfigReader() {
  return <pre>{JSON.stringify(useSupabasePublicConfig())}</pre>;
}

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", undefined);
  vi.stubEnv("WALLIE_DEPLOY_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://install-a.example");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase-a.example");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "public-key-a");
});

afterEach(() => vi.unstubAllEnvs());

describe("runtime deployment configuration", () => {
  it("resolves metadata for the current installation without reloading the module", async () => {
    expect((await generateMetadata()).metadataBase).toEqual(new URL("https://install-a.example"));

    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://install-b.example");
    expect((await generateMetadata()).metadataBase).toEqual(new URL("https://install-b.example"));
  });

  it("supplies only the current public Supabase fields during server rendering", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase-b.example");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "public-key-b");
    vi.stubEnv("SUPABASE_SECRET_KEY", "private-key-canary");
    vi.stubEnv("WALLIE_ENCRYPTION_KEY", "encryption-key-canary");

    const html = renderToStaticMarkup(await RootLayout({ children: <PublicConfigReader /> }));

    expect(html).toContain("https://supabase-b.example");
    expect(html).toContain("public-key-b");
    expect(html).not.toContain("supabase-a.example");
    expect(html).not.toContain("public-key-a");
    expect(html).not.toContain("private-key-canary");
    expect(html).not.toContain("encryption-key-canary");
  });

  it("allows the public landing page and injected fixtures without Supabase configuration", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", undefined);

    const html = renderToStaticMarkup(await RootLayout({ children: <PublicConfigReader /> }));
    expect(html).toContain("<pre>null</pre>");
  });

  it("rejects partial Supabase configuration rather than supplying baked defaults", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", undefined);

    await expect(RootLayout({ children: null })).rejects.toThrow(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    );
  });
});

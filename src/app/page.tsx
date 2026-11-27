import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import { factoryTourHeading, LandingPage } from "@/components/landing/landing-page";
import { ensureProfileForUser, resolveAuthenticatedHomePath } from "@/lib/auth";
import { siteConfig } from "@/lib/site-config";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const title = `${siteConfig.name} — ${factoryTourHeading}`;
const description =
  "Tour Wallie’s software factory: guide coding agents through human review, then use what you learn to improve the next job.";
const socialImage = { url: "/icon-512.png", width: 512, height: 512, alt: "Wallie" };

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  openGraph: {
    title,
    description,
    type: "website",
    siteName: siteConfig.name,
    locale: "en_US",
    url: "/",
    images: [socialImage],
  },
  twitter: { card: "summary", title, description, images: [socialImage] },
};

function hasSupabaseSessionCookie(cookieStore: { getAll: () => { name: string }[] }) {
  return cookieStore
    .getAll()
    .some(({ name }) => name.startsWith("sb-") && name.includes("-auth-token"));
}

function hasSupabasePublicEnv(input: Record<string, string | undefined>) {
  return Boolean(input.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY && input.NEXT_PUBLIC_SUPABASE_URL);
}

export default async function HomePage() {
  const cookieStore = await cookies();

  if (!hasSupabaseSessionCookie(cookieStore) || !hasSupabasePublicEnv(process.env)) {
    return <LandingPage />;
  }

  const supabase = await createSupabaseServerClient(process.env, cookieStore);
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    return <LandingPage />;
  }

  const [, homePath] = await Promise.all([
    ensureProfileForUser(supabase, user),
    resolveAuthenticatedHomePath(supabase),
  ]);

  redirect(homePath);
}

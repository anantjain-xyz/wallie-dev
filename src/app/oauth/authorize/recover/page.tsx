import type { Metadata } from "next";

import { ConsentRecovery } from "../consent-recovery";

export const metadata: Metadata = {
  title: { absolute: "Start authorization again · Wallie" },
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function OAuthRecoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string | string[] }>;
}) {
  return <ConsentRecovery signedOut={(await searchParams).reason === "signed_out"} />;
}

import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { resolveAppUrl } from "@/lib/app-url";
import { siteConfig } from "@/lib/site-config";
import "./globals.css";

const inter = Inter({
  adjustFontFallback: true,
  axes: ["opsz"],
  display: "swap",
  fallback: ["Arial"],
  subsets: ["latin"],
  variable: "--font-inter",
  weight: "variable",
});

const ibmPlexMono = IBM_Plex_Mono({
  adjustFontFallback: true,
  display: "swap",
  fallback: ["Courier New"],
  subsets: ["latin"],
  variable: "--font-ibm-plex-mono",
  weight: ["400", "500", "600", "700"],
});

const themeBootstrapScript = `
(() => {
  const systemTheme = () => {
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {
      return "light";
    }
  };

  let storedTheme;

  try {
    storedTheme = window.localStorage.getItem("wallie-theme");
  } catch {
    storedTheme = null;
  }

  document.documentElement.dataset.theme =
    storedTheme === "light" || storedTheme === "dark" ? storedTheme : systemTheme();
})();
`;

const defaultTitle = `${siteConfig.name} — ${siteConfig.tagline}`;
const ogImageAlt = `${siteConfig.name} — ${siteConfig.tagline}`;

export const metadata: Metadata = {
  metadataBase: resolveAppUrl(),
  title: {
    default: defaultTitle,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
  applicationName: siteConfig.name,
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    type: "website",
    siteName: siteConfig.name,
    url: "/",
    title: defaultTitle,
    description: siteConfig.description,
    locale: "en_US",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: ogImageAlt,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: defaultTitle,
    description: siteConfig.description,
    images: ["/og-image.png"],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#13161b" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${ibmPlexMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full font-sans">
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
        <OverlayProvider>
          <a href="#main-content" className="ui-skip-link">
            Skip to main content
          </a>
          {children}
        </OverlayProvider>
      </body>
    </html>
  );
}

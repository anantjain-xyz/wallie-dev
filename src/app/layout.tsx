import type { Metadata } from "next";
import { Newsreader } from "next/font/google";

import { siteConfig } from "@/lib/site-config";
import "./globals.css";

const newsreader = Newsreader({
  subsets: ["latin"],
  display: "swap",
  weight: ["400"],
  variable: "--font-newsreader",
});

const themeBootstrapScript = `
(() => {
  try {
    const storedTheme = window.localStorage.getItem("wallie-theme");
    const theme =
      storedTheme === "light" || storedTheme === "dark"
        ? storedTheme
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";

    document.documentElement.dataset.theme = theme;
  } catch {
    document.documentElement.dataset.theme = "light";
  }
})();
`;

export const metadata: Metadata = {
  metadataBase: new URL("https://wallie.cc"),
  title: {
    default: siteConfig.name,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`h-full antialiased ${newsreader.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-full font-sans">
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
        <a href="#main-content" className="ui-skip-link">
          Skip to Main Content
        </a>
        {children}
      </body>
    </html>
  );
}

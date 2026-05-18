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

// Generates the static social/icon assets committed to public/.
//
// Run with: node scripts/generate-og-assets.mjs
//
// We render once at author time (rather than via a runtime route) so the
// social card and icons are plain static files — the most reliable shape for
// link-unfurlers and validators (opengraph.xyz, Slack, X, Discord), which just
// fetch the URL with no function execution. Re-run this script whenever the
// brand mark, tagline, or palette changes.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
// next/og's Node entry bundles a default font (Geist), so no font fetch is needed.
import { ImageResponse } from "next/dist/compiled/@vercel/og/index.node.js";

import { siteConfig } from "../src/lib/site-config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

// Palette mirrors src/app/globals.css.
const COLORS = {
  background: "#f5f5f5",
  surface: "#ffffff",
  foreground: "#1d1f22",
  muted: "#5b606b",
  border: "#e4e4e7",
  accent: "#5e6ad2",
  accentBright: "#8b95ff",
};

const h = React.createElement;

const logoBytes = await readFile(join(publicDir, "wallie-logo-minimal.png"));
const logoSrc = `data:image/png;base64,${logoBytes.toString("base64")}`;

async function render(element, { width, height }) {
  const response = new ImageResponse(element, { width, height });
  return Buffer.from(await response.arrayBuffer());
}

// A white rounded tile holding the robot mark — reused across card + icons.
function logoTile({ size, radius, padding, shadow }) {
  return h(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        background: COLORS.surface,
        borderRadius: radius,
        border: `1px solid ${COLORS.border}`,
        ...(shadow ? { boxShadow: "0 24px 60px rgba(29,31,34,0.12)" } : {}),
      },
    },
    h("img", {
      src: logoSrc,
      width: size - padding * 2,
      height: size - padding * 2,
    }),
  );
}

function stagePill(label) {
  return h(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        padding: "10px 22px",
        borderRadius: 999,
        background: "rgba(94,106,210,0.10)",
        color: COLORS.accent,
        fontSize: 28,
        fontWeight: 600,
      },
    },
    label,
  );
}

// ---- 1200x630 social card ----
const ogCard = h(
  "div",
  {
    style: {
      display: "flex",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      padding: 80,
      background: `linear-gradient(135deg, ${COLORS.surface} 0%, ${COLORS.background} 100%)`,
      position: "relative",
    },
  },
  // top accent bar
  h("div", {
    style: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: 14,
      background: `linear-gradient(90deg, ${COLORS.accent} 0%, ${COLORS.accentBright} 100%)`,
    },
  }),
  // header: mark + wordmark
  h(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 36 } },
    logoTile({ size: 168, radius: 36, padding: 18, shadow: true }),
    h(
      "div",
      {
        style: {
          display: "flex",
          fontSize: 112,
          fontWeight: 700,
          color: COLORS.foreground,
          letterSpacing: "-0.03em",
        },
      },
      siteConfig.name,
    ),
  ),
  // tagline
  h(
    "div",
    {
      style: {
        display: "flex",
        marginTop: 48,
        fontSize: 52,
        lineHeight: 1.2,
        color: COLORS.foreground,
        maxWidth: 900,
      },
    },
    `${siteConfig.tagline}.`,
  ),
  // footer: stages + domain
  h(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: "auto",
      },
    },
    h(
      "div",
      { style: { display: "flex", gap: 16 } },
      stagePill("plan"),
      stagePill("build"),
      stagePill("land"),
    ),
    h(
      "div",
      { style: { display: "flex", fontSize: 32, fontWeight: 600, color: COLORS.muted } },
      "wallie.dev",
    ),
  ),
);

// ---- icon (white tile + robot), used at multiple sizes ----
function iconElement(size) {
  return h(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        background: COLORS.surface,
      },
    },
    h("img", {
      src: logoSrc,
      width: Math.round(size * 0.82),
      height: Math.round(size * 0.82),
    }),
  );
}

const assets = [
  { file: "og-image.png", element: ogCard, width: 1200, height: 630 },
  { file: "apple-touch-icon.png", element: iconElement(180), width: 180, height: 180 },
  { file: "icon-192.png", element: iconElement(192), width: 192, height: 192 },
  { file: "icon-512.png", element: iconElement(512), width: 512, height: 512 },
];

for (const { file, element, width, height } of assets) {
  const png = await render(element, { width, height });
  await writeFile(join(publicDir, file), png);
  console.log(`wrote public/${file} (${width}x${height}, ${png.length} bytes)`);
}

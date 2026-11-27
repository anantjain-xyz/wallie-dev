import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import RecoveryPage from "./page";

it("puts account switching before secondary help for a link", async () => {
  const html = renderToStaticMarkup(await RecoveryPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain("Get help with a Wallie link");
  expect(html).toContain('action="/auth/signout" method="post"');
  expect(html).toContain('name="switchAccount" value="1"');
  expect(html).toContain("Use a different account");
  expect(html.indexOf("Use a different account")).toBeLessThan(
    html.indexOf("Ask the person who shared the link"),
  );
  expect(html).not.toContain('role="alert"');
});

it("keeps failed sign-out distinct and retries sign-out instead of linking to sign-in", async () => {
  const html = renderToStaticMarkup(
    await RecoveryPage({ searchParams: Promise.resolve({ signOut: "failed" }) }),
  );
  expect(html).toContain("Wallie couldn’t sign you out");
  expect(html).toMatch(/role="alert"[^>]*>You may still be signed in/);
  expect(html).toContain('action="/auth/signout" method="post"');
  expect(html).toContain('name="switchAccount" value="1"');
  expect(html).toContain("Try signing out again");
  expect(html).not.toContain('href="/login"');
  expect(html).not.toContain("Ask the person who shared the link");
});

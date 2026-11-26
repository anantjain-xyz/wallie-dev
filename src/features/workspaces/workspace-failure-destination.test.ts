import { expect, it } from "vitest";

import { workspaceFailureDestination } from "./workspace-failure-destination";

it("offers Sessions from Settings and Settings from a nested page", () => {
  expect(workspaceFailureDestination("acme", "/w/acme/settings", "/w/acme/inbox")).toEqual({
    href: "/w/acme/sessions",
    label: "Back to sessions",
  });
  expect(workspaceFailureDestination("acme", "/w/acme/settings/automations", null)).toEqual({
    href: "/w/acme/settings",
    label: "Back to settings",
  });
});

it.each([
  ["/w/acme/sessions?scope=all&q=build&create=1", "/w/acme/sessions?scope=all&q=build", "sessions"],
  ["/w/acme/inbox?kind=review", "/w/acme/inbox?kind=review", "inbox"],
  ["/w/acme/inbox?kind=clarification", "/w/acme/inbox?kind=clarification", "inbox"],
  [
    "/w/acme/inbox?kind=review&kind=clarification&cursor=page-2",
    "/w/acme/inbox?cursor=page-2",
    "inbox",
  ],
  ["/w/acme/inbox?kind=unknown", "/w/acme/inbox", "inbox"],
  ["/w/other/inbox?kind=review", "/w/acme/sessions", "sessions"],
  ["//example.com/w/acme/inbox", "/w/acme/sessions", "sessions"],
])("filters session recovery destination %s", (returnTo, href, label) => {
  expect(workspaceFailureDestination("acme", "/w/acme/sessions/42", returnTo)).toEqual({
    href,
    label: `Back to ${label}`,
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import WorkspaceErrorPage from "@/app/w/[workspaceSlug]/(app)/error";
import { PageFailure } from "./page-failure";
const mocked = vi.hoisted(() => ({ refresh: vi.fn(), pathname: "/w/acme/sessions" }));
vi.mock("next/navigation", () => ({
  useRouter: () => mocked,
  useParams: () => ({ workspaceSlug: "acme" }),
  usePathname: () => mocked.pathname,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("retries errors and keeps the workspace return destination", () => {
  const reset = vi.fn();
  render(
    <PageFailure reset={reset} returnHref="/w/acme/sessions" returnLabel="Back to sessions" />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(reset).toHaveBeenCalledTimes(1);
  expect(mocked.refresh).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("link", { name: "Back to sessions" }).getAttribute("href")).toBe(
    "/w/acme/sessions",
  );
});
it("does not reveal whether unavailable content exists or offer a false retry", () => {
  render(<PageFailure notFound />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("This page isn’t available");
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByRole("link").getAttribute("href")).toBe("/");
});

it("offers a different destination when the session list itself fails", () => {
  const view = render(<WorkspaceErrorPage reset={vi.fn()} />);
  expect(screen.getByRole("link", { name: "Back to pipeline" }).getAttribute("href")).toBe(
    "/w/acme",
  );
  mocked.pathname = "/w/acme/sessions/1";
  view.rerender(<WorkspaceErrorPage reset={vi.fn()} />);
  expect(screen.getByRole("link", { name: "Back to sessions" }).getAttribute("href")).toBe(
    "/w/acme/sessions",
  );
});

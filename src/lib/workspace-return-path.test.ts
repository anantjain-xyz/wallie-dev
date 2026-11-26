import { expect, it } from "vitest";

import {
  sanitizeAuthSessionNext,
  workspaceListReturnPath,
  workspaceReturnPath,
} from "./workspace-return-path";

it("retains the workspace pathname and supported Sessions query state", () => {
  const pathname = "/w/acme/sessions";
  const query = "scope=archived&stage=plan&sort=oldest&cursor=page-2";
  expect(
    workspaceReturnPath(`${pathname}?${query}&q=API+work&create=1&unsupported=1`, "acme"),
  ).toBe(`${pathname}?${query}`);
  expect(workspaceReturnPath("/w/acme/benchmarks/suite/comparisons/exp", "acme")).toBe(
    "/w/acme/benchmarks/suite/comparisons/exp",
  );
});

it("never forwards a path that grows over the serialized return limit", () => {
  const path = "/w/acme/sessions";
  const nearLimit = workspaceReturnPath(`${path}?cursor=${"~".repeat(800)}`);
  expect(nearLimit).toBe(`${path}?cursor=${"%7E".repeat(800)}`);
  expect(workspaceReturnPath(nearLimit)).toBe(nearLimit);
  expect(workspaceReturnPath(`${path}?cursor=${"~".repeat(1_500)}`)).toBe(path);
});

it("strips search text from a direct auth destination or embedded Sessions browse return", () => {
  expect(sanitizeAuthSessionNext("/w/acme/sessions?q=private+query&scope=all")).toBe(
    "/w/acme/sessions?scope=all",
  );
  const params = new URLSearchParams({ returnTo: "/w/acme/sessions?q=private+query&scope=all" });
  const sanitized = sanitizeAuthSessionNext(`/w/acme/sessions/17?${params}`);
  expect(new URL(sanitized, "https://wallie.invalid").searchParams.get("returnTo")).toBe(
    "/w/acme/sessions?scope=all",
  );
});

it("keeps the exact review target and validated list origin separately", () => {
  const path = "/w/acme/sessions/42";
  const params = new URLSearchParams({
    artifactStage: "build",
    artifactId: "f5dd1199-53d4-4e66-88a9-888555333111",
    artifactVersion: "2",
    reviewStageId: "f5dd1199-53d4-4e66-88a9-888555333222",
    reviewRevision: "5",
    returnTo: "/w/acme/inbox?factory=all&cursor=more",
  });
  const next = workspaceReturnPath(`${path}?${params}`, "acme");
  expect(next).toBe(`${path}?${params}`);
});

it("falls back when the destination is not a local path in the requested workspace", () => {
  expect(workspaceReturnPath(null, "acme")).toBeUndefined();
  expect(workspaceReturnPath("/w/acme-other/inbox", "acme")).toBeUndefined();
  expect(workspaceReturnPath("https://example.com/w/acme/sessions", "acme")).toBeUndefined();
  expect(workspaceListReturnPath("/w/acme/sessions/42", "acme")).toBeUndefined();
  expect(workspaceListReturnPath("/w/acme/sessions?create=1&q=hello", "acme")).toBe(
    "/w/acme/sessions?q=hello",
  );
});

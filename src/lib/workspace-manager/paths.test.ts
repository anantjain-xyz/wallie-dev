import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertPathContained, getWorkspaceBaseDir, sessionWorkspacePath } from "./paths";

describe("workspace-manager/paths", () => {
  describe("getWorkspaceBaseDir", () => {
    it("returns the default when env var is not set", () => {
      expect(getWorkspaceBaseDir({})).toBe("/tmp/wallie-workspaces");
    });

    it("returns the env var value when set", () => {
      expect(getWorkspaceBaseDir({ WALLIE_WORKSPACE_BASE_DIR: "/data/ws" })).toBe("/data/ws");
    });

    it("ignores whitespace-only env var", () => {
      expect(getWorkspaceBaseDir({ WALLIE_WORKSPACE_BASE_DIR: "  " })).toBe(
        "/tmp/wallie-workspaces",
      );
    });
  });

  describe("sessionWorkspacePath", () => {
    it("returns a deterministic path from session ID", () => {
      const result = sessionWorkspacePath("abc-123", "/tmp/ws");
      expect(result).toBe("/tmp/ws/abc-123");
    });

    it("produces the same path for the same session ID", () => {
      const a = sessionWorkspacePath("550e8400-e29b-41d4-a716-446655440000", "/tmp/ws");
      const b = sessionWorkspacePath("550e8400-e29b-41d4-a716-446655440000", "/tmp/ws");
      expect(a).toBe(b);
    });

    it("sanitizes non-hex characters from session ID", () => {
      const result = sessionWorkspacePath("../../../etc/passwd", "/tmp/ws");
      expect(result).toBe("/tmp/ws/ecad");
    });

    it("throws for an empty sanitized session ID", () => {
      expect(() => sessionWorkspacePath("!@#$%", "/tmp/ws")).toThrow("Invalid session ID");
    });
  });

  describe("assertPathContained", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wallie-test-"));
    });

    afterEach(async () => {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    it("accepts a path within the base directory", () => {
      const target = path.join(tmpDir, "workspace-1");
      expect(() => assertPathContained(target, tmpDir)).not.toThrow();
    });

    it("rejects a path outside the base directory", () => {
      const target = path.join(tmpDir, "..", "outside");
      expect(() => assertPathContained(target, tmpDir)).toThrow("escapes workspace base");
    });

    it("rejects a path that is a prefix of the base but not a child", () => {
      // e.g. base = /tmp/wallie-workspaces, target = /tmp/wallie-workspaces-evil
      const evilDir = tmpDir + "-evil";
      expect(() => assertPathContained(evilDir, tmpDir)).toThrow("escapes workspace base");
    });

    it("accepts the base directory itself", () => {
      expect(() => assertPathContained(tmpDir, tmpDir)).not.toThrow();
    });

    it("follows symlinks when the path exists", async () => {
      const realTarget = path.join(os.tmpdir(), "wallie-symlink-target-" + Date.now());
      await fs.promises.mkdir(realTarget, { recursive: true });
      const symlinkPath = path.join(tmpDir, "sneaky-link");
      await fs.promises.symlink(realTarget, symlinkPath);

      try {
        expect(() => assertPathContained(symlinkPath, tmpDir)).toThrow("escapes workspace base");
      } finally {
        await fs.promises.rm(realTarget, { recursive: true, force: true });
      }
    });
  });
});

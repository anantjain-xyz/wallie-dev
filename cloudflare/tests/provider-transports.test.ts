import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSandboxProviderDriver } from "@/lib/sandbox/provider-contract";

afterEach(() => vi.unstubAllGlobals());

describe("provider SDK data paths under workerd", () => {
  it("provisions Vercel, transfers files, streams a command, and stops", async () => {
    const sandbox = {
      id: "sbx-synthetic",
      memory: 4096,
      vcpus: 2,
      region: "test",
      runtime: "node22",
      timeout: 120_000,
      status: "running",
      requestedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      cwd: "/vercel/sandbox",
    };
    const command = {
      id: "cmd-synthetic",
      name: "git",
      args: ["status"],
      cwd: "/tmp",
      sandboxId: sandbox.id,
      exitCode: 0,
      startedAt: 1,
    };
    let uploadedBytes = 0;
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        requests.push(url.pathname);
        if (url.pathname.endsWith("/fs/write")) {
          uploadedBytes = (await new Response(options?.body).arrayBuffer()).byteLength;
          return Response.json({});
        }
        if (url.pathname.endsWith("/fs/read")) return new Response("private source");
        if (url.pathname.endsWith("/logs"))
          return new Response('{"stream":"stdout","data":"live output"}\n', {
            headers: { "Content-Type": "application/x-ndjson" },
          });
        if (url.pathname.includes("/cmd")) return Response.json({ command });
        if (url.pathname.endsWith("/stop"))
          return Response.json({ sandbox: { ...sandbox, status: "stopped" } });
        return Response.json({ sandbox, routes: [] });
      }),
    );
    const driver = await loadSandboxProviderDriver("vercel");
    const created = vi.fn();
    const handle = await driver.createUtility(
      {
        workspaceId: "workspace",
        ownerId: "run",
        timeoutMs: 120_000,
        onSandboxCreated: created,
      },
      {
        provider: "vercel",
        revision: "revision",
        credentials: {
          token: "synthetic-token",
          teamId: "team-test",
          projectId: "prj-test",
        },
      } as never,
    );
    await handle.writeFile("/tmp/source.bundle", Buffer.from("private source"), { mode: 0o600 });
    expect(uploadedBytes).toBeGreaterThan(0);
    expect(await handle.readFile("/tmp/source.bundle")).toBe("private source");
    const execution = await handle.exec("git", ["status"], { cwd: "/tmp" });
    const logs = [];
    for await (const entry of execution.logs()) logs.push(entry);
    expect(logs).toEqual([{ stream: "stdout", data: "live output" }]);
    expect(await execution.exitCode).toBe(0);
    expect(await execution.output()).toEqual({ stdout: "live output", stderr: "" });
    await handle.stop();
    expect(created).toHaveBeenCalledExactlyOnceWith({ provider: "vercel", sandboxId: sandbox.id });
    expect(requests).toContain(`/api/v1/sandboxes/${sandbox.id}/stop`);
  });

  it("provisions E2B and uses native multipart upload, file download, and destroy", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, options);
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        if (url.pathname === "/sandboxes")
          return Response.json({
            sandboxID: "synthetic-e2b",
            envdVersion: "0.6.2",
            envdAccessToken: "synthetic-envd-token",
          });
        if (url.pathname === "/files") {
          if (request.method === "POST") {
            expect((await request.formData()).get("file")).toBeInstanceOf(File);
            return Response.json([
              { name: "source.bundle", path: "/tmp/source.bundle", type: "file" },
            ]);
          }
          return new Response("private source");
        }
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        throw new Error(`Unexpected synthetic request: ${request.method} ${url.pathname}`);
      }),
    );
    const driver = await loadSandboxProviderDriver("e2b");
    const handle = await driver.createUtility(
      {
        workspaceId: "workspace",
        ownerId: "run",
        timeoutMs: 120_000,
        onSandboxCreated: vi.fn(),
      },
      {
        provider: "e2b",
        revision: "revision",
        credentials: { apiKey: `e2b_${"0".repeat(40)}` },
      } as never,
    );
    await handle.writeFile("/tmp/source.bundle", Buffer.from("private source"));
    expect(await handle.readFile("/tmp/source.bundle")).toBe("private source");
    await handle.stop();
    expect(requests).toContain("DELETE /sandboxes/synthetic-e2b");
  });

  it("uses Daytona HTTP, multipart files, and the authenticated WebSocket log stream", async () => {
    const dto = {
      id: "synthetic-daytona",
      organizationId: "synthetic-org",
      state: "started",
      toolboxProxyUrl: "https://toolbox.test",
      labels: {},
      env: {},
    };
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, options);
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        if (request.headers.get("Upgrade") === "websocket") {
          expect(url.searchParams.get("DAYTONA_SANDBOX_AUTH_KEY")).toBe("synthetic-preview-token");
          const pair = new WebSocketPair();
          pair[1].accept();
          setTimeout(() => {
            pair[1].send(new Uint8Array([1, 1, 1, ...new TextEncoder().encode("live output")]));
            pair[1].close(1000, "completed");
          }, 10);
          return new Response(null, { status: 101, webSocket: pair[0] });
        }
        if (url.pathname.endsWith("/bulk-upload")) {
          const body = await request.formData();
          expect(body.get("files[0].path")).toBe("/tmp/source.bundle");
          expect(body.get("files[0].file")).toBeInstanceOf(File);
          return Response.json({});
        }
        if (url.pathname.endsWith("/bulk-download")) {
          const body = new FormData();
          body.append("files", new Blob(["private source"]), "/tmp/source.bundle");
          return new Response(body);
        }
        if (url.pathname.endsWith("/preview-url"))
          return Response.json({
            url: "https://preview.test",
            token: "synthetic-preview-token",
          });
        if (url.pathname.endsWith("/exec")) return Response.json({ cmdId: "synthetic-command" });
        if (url.pathname.endsWith("/logs"))
          return Response.json({ stdout: "live output", stderr: "" });
        if (url.pathname.includes("/command/")) return Response.json({ exitCode: 0 });
        if (url.pathname.includes("/process/session")) return Response.json({});
        if (url.pathname.includes("/api/sandbox"))
          return Response.json({
            ...dto,
            state: request.method === "DELETE" ? "destroyed" : "started",
          });
        throw new Error(`Unexpected synthetic request: ${request.method} ${url.pathname}`);
      }),
    );
    const driver = await loadSandboxProviderDriver("daytona");
    const handle = await driver.createUtility(
      {
        workspaceId: "workspace",
        ownerId: "run",
        timeoutMs: 120_000,
        onSandboxCreated: vi.fn(),
      },
      {
        provider: "daytona",
        revision: "revision",
        credentials: { apiKey: "synthetic-daytona-key" },
      } as never,
    );
    try {
      await handle.writeFile("/tmp/source.bundle", Buffer.from("private source"));
      expect(await handle.readFile("/tmp/source.bundle")).toBe("private source");
      const execution = await handle.exec("git", ["status"], { cwd: "/tmp" });
      const logs = [];
      for await (const entry of execution.logs()) logs.push(entry);
      expect(logs.map((entry) => entry.data).join("")).toBe("live output");
      expect(await execution.exitCode).toBe(0);
      expect(await execution.output()).toEqual({ stdout: "live output", stderr: "" });
    } finally {
      await handle.stop();
    }
    expect(requests).toContain("DELETE /api/sandbox/synthetic-daytona");
  });
});

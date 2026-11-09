import { describe, it, expect, afterEach, vi } from "vitest";
import { McpHttpService, generateMcpToken } from "./mcp-http-service";
import { createLuminaMcpServer } from "../../mcp/server-factory";
import type { LuminaBackend } from "../../mcp/backend";
import { INITIALIZE_PARAMS, readRpcResponse, rpcRequest, singleVault } from "../../mcp/test-utils";

const backend = {
  search: vi.fn().mockResolvedValue([]),
  status: vi.fn().mockResolvedValue({}),
} as unknown as LuminaBackend;

const TOKEN = generateMcpToken();
let service: McpHttpService | null = null;

afterEach(async () => {
  await service?.stop();
  service = null;
});

async function startService(): Promise<string> {
  service = new McpHttpService({
    port: 0,
    token: TOKEN,
    createServer: () => createLuminaMcpServer(singleVault(backend), { allowWrite: false, allowLuminaIngest: false }),
  });
  const status = await service.start();
  expect(status.running).toBe(true);
  return status.url!;
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe("McpHttpService", () => {
  it("generates distinct 48-char hex tokens", () => {
    expect(TOKEN).toMatch(/^[0-9a-f]{48}$/);
    expect(generateMcpToken()).not.toBe(TOKEN);
  });

  it("binds to 127.0.0.1 and serves initialize + tools/list with a valid token", async () => {
    const url = await startService();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const init = await readRpcResponse(await fetch(rpcRequest(url, "initialize", INITIALIZE_PARAMS, auth)));
    expect((init.result?.serverInfo as { name: string }).name).toBe("lumina");
    const tools = await readRpcResponse(await fetch(rpcRequest(url, "tools/list", {}, auth)));
    expect((tools.result?.tools as unknown[]).length).toBe(8);
  });

  it("rejects missing and wrong tokens with 401", async () => {
    const url = await startService();
    expect((await fetch(rpcRequest(url, "tools/list"))).status).toBe(401);
    const wrong = await fetch(rpcRequest(url, "tools/list", {}, { authorization: "Bearer nope" }));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("accepts the token as a ?token= query parameter", async () => {
    const url = await startService();
    const ok = await fetch(rpcRequest(`${url}?token=${TOKEN}`, "initialize", INITIALIZE_PARAMS));
    expect(ok.status).toBe(200);
    expect((await fetch(rpcRequest(`${url}?token=wrong`, "tools/list"))).status).toBe(401);
  });

  it("rejects foreign Origin and Host headers (DNS rebinding)", async () => {
    const svc = new McpHttpService({ port: 0, token: TOKEN, createServer: () => createLuminaMcpServer(singleVault(backend), { allowWrite: false, allowLuminaIngest: false }) });
    const origin = svc.authorize(rpcRequest("http://127.0.0.1:1/mcp", "tools/list", {}, { ...auth, origin: "https://evil.example" }));
    expect(origin?.status).toBe(403);
    const host = svc.authorize(rpcRequest("http://evil.example/mcp", "tools/list", {}, { ...auth, host: "evil.example" }));
    expect(host?.status).toBe(403);
  });

  it("returns 404 outside /mcp", async () => {
    const url = await startService();
    const res = await fetch(url.replace("/mcp", "/other"), { headers: auth });
    expect(res.status).toBe(404);
  });

  it("reports a port conflict instead of throwing", async () => {
    const url = await startService();
    const port = Number(new URL(url).port);
    const second = new McpHttpService({ port, token: TOKEN, createServer: () => createLuminaMcpServer(singleVault(backend), { allowWrite: false, allowLuminaIngest: false }) });
    const status = await second.start();
    expect(status.running).toBe(false);
    expect(status.error).toMatch(/already in use/);
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { VaultRuntime } from "../../core/vault-runtime";
import { DEFAULT_MCP_SERVER_CONFIG, DEFAULT_QMD_SEARCH_CONFIG, type McpServerConfig } from "../../shared/types";
import { AppMcpServer } from "./mcp-app-server";
import { INITIALIZE_PARAMS, readRpcResponse, rpcRequest } from "../../mcp/test-utils";

let server: AppMcpServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

function create(initial: Partial<McpServerConfig>, vaults: { active: string | null; others: string[] } = { active: "/vault", others: [] }) {
  let cfg: McpServerConfig = { ...DEFAULT_MCP_SERVER_CONFIG, port: 0, ...initial };
  server = new AppMcpServer({
    getConfig: () => cfg,
    saveConfig: (p) => {
      cfg = { ...cfg, ...p };
    },
    backend: {
      getVaultPath: () => vaults.active,
      listAllArticles: async () => [],
      search: vi.fn().mockResolvedValue([]),
      searchEngine: () => "flexsearch",
      qmdStatus: async () => null,
      loadBundledTemplate: async () => null,
    },
    getVaultEntries: () => [...(vaults.active ? [vaults.active] : []), ...vaults.others].map((p) => ({ path: p })),
    openVaultRuntime: (vaultPath) =>
      VaultRuntime.open({ vaultPath, qmdSearch: DEFAULT_QMD_SEARCH_CONFIG, userDataDir: null }),
    pdfImageIngest: () => false,
    createIngestChat: () => {
      throw new Error("no llm");
    },
    version: "1.2.3",
    cliPath: "/app/dist/main/mcp/cli.js",
    executablePath: "/app/Lumina",
  });
  return {
    server,
    config: () => cfg,
    update: (p: Partial<McpServerConfig>) => {
      cfg = { ...cfg, ...p };
    },
  };
}

async function listTools(url: string, token: string): Promise<string[]> {
  const auth = { authorization: `Bearer ${token}` };
  await fetch(rpcRequest(url, "initialize", INITIALIZE_PARAMS, auth));
  const res = await readRpcResponse(await fetch(rpcRequest(url, "tools/list", {}, auth)));
  return (res.result?.tools as { name: string }[]).map((t) => t.name);
}

describe("AppMcpServer", () => {
  it("stays stopped while disabled", async () => {
    const { server } = create({ enabled: false });
    expect((await server.sync()).running).toBe(false);
  });

  it("generates a token on first enable and applies capability toggles without restart", async () => {
    const { server, config, update } = create({ enabled: true });
    const status = await server.sync();
    expect(status.running).toBe(true);
    expect(config().token).toMatch(/^[0-9a-f]{48}$/);
    expect(status.cliPath).toBe("/app/dist/main/mcp/cli.js");

    expect(await listTools(status.url!, config().token)).not.toContain("write_wiki_page");
    update({ allowWrite: true, allowLuminaIngest: true });
    const tools = await listTools(status.url!, config().token);
    expect(tools).toContain("write_wiki_page");
    expect(tools).toContain("ingest_with_lumina");
  });

  it("invalidates the old token on regenerate", async () => {
    const { server, config } = create({ enabled: true });
    await server.sync();
    const oldToken = config().token;
    const { url } = await server.regenerateToken();
    expect(config().token).not.toBe(oldToken);
    const res = await fetch(rpcRequest(url!, "tools/list", {}, { authorization: `Bearer ${oldToken}` }));
    expect(res.status).toBe(401);
    expect(await listTools(url!, config().token)).toContain("search_wiki");
  });

  it("serves registered non-active vaults from their own runtime", async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lumina-appmcp-")));
    const other = path.join(tmp, "other");
    fs.mkdirSync(path.join(other, "wiki"), { recursive: true });
    fs.writeFileSync(path.join(other, "wiki", "zebra.md"), "---\ntitle: Zebra\n---\nStripes everywhere.\n");
    try {
      const { server } = create({ enabled: false }, { active: null, others: [other] });
      expect((await server.registry.list()).map((v) => v.name)).toEqual(["other"]);
      const { backend } = await server.registry.resolve("other");
      expect((await backend.search("stripes", 5)).map((h) => h.filename)).toEqual(["wiki/zebra.md"]);
      await expect(server.registry.resolve()).rejects.toThrow(/No default vault/);
    } finally {
      await server?.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

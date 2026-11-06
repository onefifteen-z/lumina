import type { McpHttpHandler } from "@modelcontextprotocol/server";
import type { LuminaBackend } from "./backend";
import { resolveVaultRef, type VaultInfo, type VaultRegistry } from "./vault-registry";

export type RpcResponse = {
  result?: Record<string, unknown> & { content?: { type: string; text?: string }[]; isError?: boolean };
  error?: { code: number; message: string };
};

/** Parse a JSON or SSE (`data: {...}`) MCP HTTP response body into the final JSON-RPC message. */
export async function readRpcResponse(res: Response): Promise<RpcResponse> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const messages = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()) as RpcResponse & { id?: unknown });
    return messages.filter((m) => "result" in m || "error" in m).at(-1) ?? {};
  }
  return JSON.parse(text) as RpcResponse;
}

let nextId = 1;

export function rpcRequest(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
}

export const INITIALIZE_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "lumina-test", version: "0.0.0" },
};

export async function callRpc(
  handler: Pick<McpHttpHandler, "fetch">,
  method: string,
  params: Record<string, unknown> = {},
): Promise<RpcResponse> {
  const res = await handler.fetch(rpcRequest("http://127.0.0.1/mcp", method, params));
  return readRpcResponse(res);
}

/** Registry over fixed backends keyed by vault path; the first vault is the default. */
export function staticRegistry(
  vaults: { name: string; path: string; backend: LuminaBackend }[],
): VaultRegistry {
  const infos: VaultInfo[] = vaults.map((v, i) => ({ name: v.name, path: v.path, default: i === 0, initialized: true }));
  return {
    supportsLuminaIngest: vaults.some((v) => Boolean(v.backend.ingestWithLumina)),
    list: async () => infos,
    resolve: async (ref) => {
      const info = resolveVaultRef(infos, ref);
      return { info, backend: vaults.find((v) => v.path === info.path)!.backend };
    },
    close: async () => {},
  };
}

export const singleVault = (backend: LuminaBackend): VaultRegistry =>
  staticRegistry([{ name: "main", path: "/vaults/main", backend }]);

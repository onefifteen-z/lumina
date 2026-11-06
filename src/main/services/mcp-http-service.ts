import http from "http";
import crypto from "crypto";
import type { AddressInfo } from "net";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  type McpHttpHandler,
  type McpServer,
} from "@modelcontextprotocol/server";

export const MCP_HTTP_HOST = "127.0.0.1";
export const MCP_HTTP_PATH = "/mcp";
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export type McpHttpStatus = {
  running: boolean;
  url: string | null;
  error: string | null;
};

export type McpHttpServiceOptions = {
  port: number;
  token: string;
  createServer: () => McpServer;
};

export function generateMcpToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function jsonError(status: number, message: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function toWebRequest(req: http.IncomingMessage, signal: AbortSignal): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await readBody(req));
  return new Request(`http://${req.headers.host ?? MCP_HTTP_HOST}${req.url ?? "/"}`, {
    method,
    headers,
    body,
    signal,
  });
}

async function writeWebResponse(res: http.ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise<void>((resolve) => res.once("drain", resolve));
    }
  } finally {
    res.end();
  }
}

/**
 * Streamable-HTTP MCP endpoint for the running app. Loopback only, bearer
 * token required, Host/Origin checked against localhost (DNS rebinding).
 */
export class McpHttpService {
  private server: http.Server | null = null;
  private handler: McpHttpHandler | null = null;
  private error: string | null = null;

  constructor(private options: McpHttpServiceOptions) {}

  getStatus(): McpHttpStatus {
    const address = this.server?.address() as AddressInfo | null | undefined;
    return {
      running: Boolean(address),
      url: address ? `http://${MCP_HTTP_HOST}:${address.port}${MCP_HTTP_PATH}` : null,
      error: this.error,
    };
  }

  /** Validates one request; returns a rejection or null to proceed. */
  authorize(request: Request): Response | null {
    const hostRejection = hostHeaderValidationResponse(request, localhostAllowedHostnames());
    if (hostRejection) return hostRejection;
    const originRejection = originValidationResponse(request, localhostAllowedOrigins());
    if (originRejection) return originRejection;
    const auth = request.headers.get("authorization") ?? "";
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!this.options.token || !match || !tokensEqual(match[1].trim(), this.options.token)) {
      return jsonError(401, "Unauthorized: missing or invalid bearer token", {
        "www-authenticate": 'Bearer realm="lumina"',
      });
    }
    return null;
  }

  async handle(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== MCP_HTTP_PATH) return jsonError(404, "Not found");
    const rejection = this.authorize(request);
    if (rejection) return rejection;
    this.handler ??= createMcpHandler(() => this.options.createServer());
    return this.handler.fetch(request);
  }

  async start(): Promise<McpHttpStatus> {
    if (this.server) return this.getStatus();
    this.error = null;
    const server = http.createServer((req, res) => {
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      void (async () => {
        let response: Response;
        try {
          response = await this.handle(await toWebRequest(req, abort.signal));
        } catch (err) {
          response = jsonError(400, err instanceof Error ? err.message : String(err));
        }
        await writeWebResponse(res, response);
      })().catch(() => res.destroy());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.options.port, MCP_HTTP_HOST, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.error =
        code === "EADDRINUSE"
          ? `Port ${this.options.port} is already in use`
          : err instanceof Error
            ? err.message
            : String(err);
      return this.getStatus();
    }
    this.server = server;
    return this.getStatus();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    const handler = this.handler;
    this.handler = null;
    await handler?.close().catch(() => {});
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async restart(options: McpHttpServiceOptions): Promise<McpHttpStatus> {
    await this.stop();
    this.options = options;
    return this.start();
  }
}

import type { McpServerStatus } from '../../../shared/types';

/** `mcp.json` entry for the in-app streamable-HTTP endpoint (Cursor, Claude Code, …). */
export function buildHttpMcpSnippet(port: number, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        lumina: {
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: `Bearer ${token || '<enable and save to generate>'}` },
        },
      },
    },
    null,
    2,
  );
}

/** `mcp.json` entry that runs the stdio CLI through the app's bundled Electron runtime. */
export function buildStdioMcpSnippet(
  status: Pick<McpServerStatus, 'cliPath' | 'executablePath'>,
  vaultPath: string,
): string {
  return JSON.stringify(
    {
      mcpServers: {
        lumina: {
          command: status.executablePath,
          args: [status.cliPath, '--vault', vaultPath || '<vault path>'],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
      },
    },
    null,
    2,
  );
}

export function parseMcpPort(value: string, fallback: number): number {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : fallback;
}

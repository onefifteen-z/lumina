#!/usr/bin/env node
/**
 * Lumina MCP server over stdio. Runs without the Electron app:
 *
 *   ELECTRON_RUN_AS_NODE=1 /Applications/Lumina.app/Contents/MacOS/Lumina \
 *     /Applications/Lumina.app/Contents/Resources/app.asar/dist/main/mcp/cli.js [--vault <path>]
 *
 * --vault sets the default; other vaults from the app's history are reachable
 * through each tool's `vault` argument.
 *
 * stdout carries JSON-RPC only; all logging goes to stderr.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { HeadlessConfigError, resolveHeadlessConfig } from "../core/headless-config";
import { VaultRuntime } from "../core/vault-runtime";
import { createVaultBackend } from "./backend";
import { createLuminaMcpServer } from "./server-factory";
import { createRuntimeRegistry } from "./vault-registry";

const log = (message: string) => process.stderr.write(`[lumina-mcp] ${message}\n`);

function readVersion(): string {
  try {
    return (require("../../../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  console.log = console.error;
  console.info = console.error;

  const config = resolveHeadlessConfig(process.argv.slice(2));
  const registry = createRuntimeRegistry({
    getEntries: () => config.vaults,
    getDefaultPath: () => config.vaultPath,
    openBackend: async (vaultPath) => {
      const runtime = await VaultRuntime.open({
        vaultPath,
        qmdSearch: config.qmdSearch,
        userDataDir: config.userDataDir,
        watch: true,
        log: (message) => log(`${vaultPath}: ${message}`),
      });
      return { backend: createVaultBackend(runtime.backendDeps()), close: () => runtime.close() };
    },
  });
  if (config.vaultPath) await registry.resolve();
  const caps = { allowWrite: config.allowWrite, allowLuminaIngest: false };
  const version = readVersion();
  const handle = serveStdio(() => createLuminaMcpServer(registry, caps, version), {
    onerror: (err) => log(`transport error: ${err.message}`),
  });
  log(
    `serving ${config.vaults.length} vault(s), default ${config.vaultPath ?? "none"} (writes ${caps.allowWrite ? "enabled" : "disabled"})`,
  );

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await handle.close().catch(() => {});
    await registry.close().catch(() => {});
    process.exit(0);
  };
  process.stdin.on("end", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  log(err instanceof HeadlessConfigError ? err.message : `fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});

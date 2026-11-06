import path from "path";
import type { McpServerConfig, McpServerStatus } from "../../shared/types";
import { createVaultBackend, type LuminaBackend, type VaultBackendDeps } from "../../mcp/backend";
import { createLuminaMcpServer } from "../../mcp/server-factory";
import { createRuntimeRegistry, type VaultEntryLike, type VaultRegistry } from "../../mcp/vault-registry";
import type { VaultRuntime } from "../../core/vault-runtime";
import type { WikiSearchHit } from "./qmd-search-service";
import { McpHttpService, generateMcpToken } from "./mcp-http-service";
import { LuminaIngestRunner, type IngestChatSession } from "./lumina-ingest-runner";

export type SearchProvider = { search(query: string): Promise<WikiSearchHit[]> };

export type AppMcpServerDeps = {
  getConfig(): McpServerConfig;
  saveConfig(partial: Partial<McpServerConfig>): void;
  /** Live getters over the app's open vault (hot indexes, follows vault switches). */
  backend: Omit<VaultBackendDeps, "ingestWithLumina">;
  /** Registered vaults (Settings vault history). */
  getVaultEntries(): readonly VaultEntryLike[];
  /** Opens services for a registered vault that is not the open one. */
  openVaultRuntime(vaultPath: string): Promise<VaultRuntime>;
  /** `search` is the vault's index when it is not the app's open vault. */
  createIngestChat(vaultPath: string, search: SearchProvider | null): IngestChatSession;
  pdfImageIngest(): boolean;
  version: string;
  cliPath: string;
  executablePath: string;
};

const samePath = (a: string | null, b: string) => a !== null && path.resolve(a) === path.resolve(b);

/** Owns the in-app MCP HTTP endpoint and applies Settings changes to it. */
export class AppMcpServer {
  private http: McpHttpService | null = null;
  private applied: { port: number; token: string } | null = null;
  private readonly liveBackend: LuminaBackend;
  readonly registry: VaultRegistry;

  constructor(private readonly deps: AppMcpServerDeps) {
    const searchByVault = new Map<string, SearchProvider>();
    const runner = new LuminaIngestRunner({
      createChat: (vaultPath) =>
        deps.createIngestChat(
          vaultPath,
          samePath(deps.backend.getVaultPath(), vaultPath) ? null : (searchByVault.get(vaultPath) ?? null),
        ),
    });
    this.liveBackend = createVaultBackend({
      ...deps.backend,
      ingestWithLumina: (sourcePath, note, onProgress) => {
        const vault = deps.backend.getVaultPath();
        if (!vault) return Promise.reject(new Error("No Lumina vault is open."));
        return runner.run(vault, sourcePath, note, onProgress);
      },
    });
    this.registry = createRuntimeRegistry({
      getEntries: deps.getVaultEntries,
      getDefaultPath: deps.backend.getVaultPath,
      getLiveBackend: (vaultPath) => (samePath(deps.backend.getVaultPath(), vaultPath) ? this.liveBackend : null),
      supportsLuminaIngest: true,
      openBackend: async (vaultPath) => {
        const runtime = await deps.openVaultRuntime(vaultPath);
        searchByVault.set(vaultPath, runtime.searchProvider());
        const backend = createVaultBackend({
          ...runtime.backendDeps(),
          pdfImageIngest: deps.pdfImageIngest,
          ingestWithLumina: (sourcePath, note, onProgress) => runner.run(vaultPath, sourcePath, note, onProgress),
        });
        return {
          backend,
          close: async () => {
            searchByVault.delete(vaultPath);
            await runtime.close();
          },
        };
      },
    });
  }

  getStatus(): McpServerStatus {
    const http = this.http?.getStatus() ?? { running: false, url: null, error: null };
    return { ...http, cliPath: this.deps.cliPath, executablePath: this.deps.executablePath };
  }

  /** Start, restart, or stop to match the persisted config. */
  async sync(): Promise<McpServerStatus> {
    let cfg = this.deps.getConfig();
    if (!cfg.enabled) {
      await this.stop();
      return this.getStatus();
    }
    if (!cfg.token) {
      this.deps.saveConfig({ token: generateMcpToken() });
      cfg = this.deps.getConfig();
    }
    if (this.http && this.applied?.port === cfg.port && this.applied.token === cfg.token) {
      if (this.http.getStatus().running) return this.getStatus();
    }
    const options = {
      port: cfg.port,
      token: cfg.token,
      // Capabilities are re-read per request, so toggling writes needs no restart.
      createServer: () => {
        const live = this.deps.getConfig();
        return createLuminaMcpServer(
          this.registry,
          { allowWrite: live.allowWrite, allowLuminaIngest: live.allowLuminaIngest },
          this.deps.version,
        );
      },
    };
    this.applied = { port: cfg.port, token: cfg.token };
    if (this.http) await this.http.restart(options);
    else {
      this.http = new McpHttpService(options);
      await this.http.start();
    }
    return this.getStatus();
  }

  async regenerateToken(): Promise<McpServerStatus> {
    this.deps.saveConfig({ token: generateMcpToken() });
    return this.sync();
  }

  async stop(): Promise<void> {
    const http = this.http;
    this.http = null;
    this.applied = null;
    await http?.stop();
    await this.registry.close();
  }
}

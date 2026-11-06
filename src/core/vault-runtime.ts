import path from "path";
import type { ArticleMeta, QmdSearchConfig } from "../shared/types";
import { FileSystemService } from "../main/services/filesystem-service";
import { SearchIndexService } from "../main/services/search-index-service";
import { QmdSearchService } from "../main/services/qmd-search-service";
import { QmdModelManager } from "../main/services/qmd-model-manager";
import { WikiSearchRouter } from "../main/services/wiki-search-router";
import { readTemplate } from "../main/services/template-service";
import type { VaultBackendDeps } from "../mcp/backend";

const REFRESH_DEBOUNCE_MS = 500;

export type VaultRuntimeOptions = {
  vaultPath: string;
  qmdSearch: QmdSearchConfig;
  /** Where the app keeps qmd/models; null disables vector search. */
  userDataDir: string | null;
  /** Watch the vault and keep indexes fresh (long-running processes). */
  watch?: boolean;
  log?: (message: string) => void;
};

/**
 * Electron-free vault services for the stdio MCP CLI: FlexSearch over the
 * whole vault plus QMD over wiki/ when enabled in the app. Never downloads the
 * embedding model; without it QMD runs keyword-only.
 */
export class VaultRuntime {
  readonly fileSystem: FileSystemService;
  private readonly searchIndex = new SearchIndexService();
  private readonly router: WikiSearchRouter;
  private readonly qmd: QmdSearchService | null;
  private articles: ArticleMeta[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly log: (message: string) => void;

  private constructor(private readonly options: VaultRuntimeOptions) {
    this.log = options.log ?? (() => {});
    this.fileSystem = new FileSystemService(options.vaultPath);
    this.qmd = options.qmdSearch.enabled ? this.createQmd() : null;
    this.router = new WikiSearchRouter(this.searchIndex, this.qmd, () => this.qmd !== null);
  }

  static async open(options: VaultRuntimeOptions): Promise<VaultRuntime> {
    const runtime = new VaultRuntime(options);
    await runtime.refresh({ updateQmd: false });
    if (runtime.qmd) {
      void runtime.qmd.initialize().then(() => {
        const status = runtime.qmd?.getStatus();
        runtime.log(status?.error ? `QMD unavailable: ${status.error}` : "QMD index ready");
      });
    }
    if (options.watch) {
      runtime.fileSystem.watchVault((event) => {
        if (event.filename.toLowerCase().endsWith(".md") && !event.filename.startsWith(".lumina/")) {
          runtime.scheduleRefresh();
        }
      });
    }
    return runtime;
  }

  private createQmd(): QmdSearchService {
    const { qmdSearch, userDataDir, vaultPath } = this.options;
    const models = userDataDir
      ? new QmdModelManager({
          modelsDir: path.join(userDataDir, "qmd", "models"),
          fetch: () => Promise.reject(new Error("model downloads are disabled in the MCP CLI")),
        })
      : null;
    const hasModel = models?.isEmbedModelReady() ?? false;
    if (!hasModel) this.log("Embedding model not downloaded; QMD search is keyword-only.");
    // Embedding is left to the app so two processes don't compete for the model.
    return new QmdSearchService(
      vaultPath,
      { ...qmdSearch, autoEmbed: false, ...(hasModel ? {} : { mode: "lex" as const }) },
      hasModel ? models : null,
    );
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh().catch((err) => this.log(`Index refresh failed: ${String(err)}`));
    }, REFRESH_DEBOUNCE_MS);
  }

  async refresh({ updateQmd = true }: { updateQmd?: boolean } = {}): Promise<void> {
    const articles = await this.fileSystem.scanVault();
    await this.searchIndex.buildIndex(articles);
    this.articles = articles;
    if (updateQmd) this.qmd?.scheduleUpdate();
  }

  /** `search_wiki` provider for a ChatService working in this vault. */
  searchProvider(): WikiSearchRouter {
    return this.router;
  }

  backendDeps(): VaultBackendDeps {
    return {
      getVaultPath: () => this.options.vaultPath,
      listAllArticles: async () => this.articles,
      search: (query) => this.router.search(query),
      searchEngine: () => (this.qmd?.isReady() ? "qmd" : "flexsearch"),
      qmdStatus: async () => (this.qmd ? this.qmd.getDetailedStatus() : null),
      loadBundledTemplate: (name) => readTemplate(name),
    };
  }

  async close(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.fileSystem.stopWatching();
    await this.qmd?.close();
  }
}

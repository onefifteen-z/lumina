import fs from "fs";
import path from "path";
import type {
  QmdSearchConfig,
  QmdSearchProgress,
  QmdSearchStatus,
} from "../../shared/types";
import { DEFAULT_QMD_SEARCH_CONFIG } from "../../shared/types";

type QmdModule = typeof import("@tobilu/qmd");
type QmdStore = Awaited<ReturnType<QmdModule["createStore"]>>;
type QmdHybridResult = Awaited<ReturnType<QmdStore["search"]>>[number];
type QmdLexResult = Awaited<ReturnType<QmdStore["searchLex"]>>[number];

export type WikiSearchHit = {
  title: string;
  filename: string;
  excerpt: string;
};

const COLLECTION_NAME = "vault";
const UPDATE_DEBOUNCE_MS = 500;

function qmdDbPath(vaultPath: string): string {
  return path.join(vaultPath, ".lumina", "qmd", "index.sqlite");
}

function toVaultRelativeFilename(
  vaultPath: string,
  displayPath: string,
  filepath: string,
): string {
  const candidate = displayPath || filepath;
  if (!candidate) return "";
  const normalized = candidate.replace(/\\/g, "/");
  const vaultPrefix = vaultPath.replace(/\\/g, "/");
  if (normalized.startsWith(vaultPrefix + "/")) {
    return normalized.slice(vaultPrefix.length + 1);
  }
  if (normalized.startsWith("qmd://")) {
    const withoutScheme = normalized.slice("qmd://".length);
    const slash = withoutScheme.indexOf("/");
    return slash >= 0 ? withoutScheme.slice(slash + 1) : withoutScheme;
  }
  return normalized.replace(/^\/+/, "");
}

function mapHybridResult(
  vaultPath: string,
  result: QmdHybridResult,
): WikiSearchHit {
  const filename = toVaultRelativeFilename(
    vaultPath,
    result.displayPath,
    result.file,
  );
  const excerpt = (result.bestChunk || result.body || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return {
    title: result.title || path.basename(filename, ".md"),
    filename,
    excerpt,
  };
}

function mapLexResult(vaultPath: string, result: QmdLexResult): WikiSearchHit {
  const filename = toVaultRelativeFilename(
    vaultPath,
    result.displayPath,
    result.filepath,
  );
  const excerpt = (result.body || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return {
    title: result.title || path.basename(filename, ".md"),
    filename,
    excerpt,
  };
}

/**
 * Wraps the @tobilu/qmd SDK for per-vault semantic/keyword search used by
 * Chat `search_wiki`. UI search continues to use FlexSearch.
 */
export class QmdSearchService {
  private readonly vaultPath: string;
  private config: QmdSearchConfig;
  private store: QmdStore | null = null;
  private qmdModule: QmdModule | null = null;
  private ready = false;
  private indexing = false;
  private embedding = false;
  private lastUpdatedAt: string | null = null;
  private error: string | null = null;
  private progress: QmdSearchProgress | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private updateQueued = false;
  private embedQueued = false;
  private onProgress: ((progress: QmdSearchProgress) => void) | null = null;

  constructor(vaultPath: string, config?: Partial<QmdSearchConfig>) {
    this.vaultPath = vaultPath;
    this.config = { ...DEFAULT_QMD_SEARCH_CONFIG, ...config };
  }

  setConfig(config: Partial<QmdSearchConfig>): void {
    this.config = { ...this.config, ...config };
  }

  setProgressHandler(handler: ((progress: QmdSearchProgress) => void) | null): void {
    this.onProgress = handler;
  }

  isReady(): boolean {
    return this.ready && this.store !== null && !this.indexing;
  }

  getStatus(): QmdSearchStatus {
    return {
      enabled: this.config.enabled,
      ready: this.isReady(),
      indexing: this.indexing,
      embedding: this.embedding,
      totalDocuments: 0,
      needsEmbedding: 0,
      hasVectorIndex: false,
      lastUpdatedAt: this.lastUpdatedAt,
      error: this.error,
      progress: this.progress,
    };
  }

  async getDetailedStatus(): Promise<QmdSearchStatus> {
    const base = this.getStatus();
    if (!this.store) return base;
    try {
      const status = await this.store.getStatus();
      return {
        ...base,
        totalDocuments: status.totalDocuments,
        needsEmbedding: status.needsEmbedding,
        hasVectorIndex: status.hasVectorIndex,
      };
    } catch {
      return base;
    }
  }

  private emitProgress(progress: QmdSearchProgress | null): void {
    this.progress = progress;
    if (progress) this.onProgress?.(progress);
  }

  private async loadQmdModule(): Promise<QmdModule> {
    if (this.qmdModule) return this.qmdModule;
    this.qmdModule = await import("@tobilu/qmd");
    return this.qmdModule;
  }

  private async ensureStore(): Promise<QmdStore> {
    if (this.store) return this.store;
    const qmd = await this.loadQmdModule();
    const dbPath = qmdDbPath(this.vaultPath);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.store = await qmd.createStore({
      dbPath,
      config: {
        collections: {
          [COLLECTION_NAME]: {
            path: this.vaultPath,
            pattern: "**/*.md",
            ignore: [".lumina/**", "node_modules/**"],
          },
        },
      },
    });
    return this.store;
  }

  async initialize(): Promise<void> {
    if (!this.config.enabled) return;
    this.error = null;
    try {
      await this.ensureStore();
      await this.runUpdate();
      if (this.config.autoEmbed) {
        await this.runEmbed();
      }
      this.ready = true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.ready = false;
      console.warn("QMD initialization failed:", err);
    } finally {
      this.emitProgress(null);
    }
  }

  async rebuild(): Promise<void> {
    if (!this.config.enabled) return;
    this.error = null;
    this.ready = false;
    try {
      await this.ensureStore();
      await this.runUpdate();
      if (this.config.autoEmbed) {
        await this.runEmbed(true);
      }
      this.ready = true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.ready = false;
      throw err;
    } finally {
      this.emitProgress(null);
    }
  }

  scheduleUpdate(): void {
    if (!this.config.enabled) return;
    this.updateQueued = true;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      void this.flushScheduledUpdate();
    }, UPDATE_DEBOUNCE_MS);
  }

  private async flushScheduledUpdate(): Promise<void> {
    if (!this.updateQueued) return;
    this.updateQueued = false;
    try {
      await this.ensureStore();
      const result = await this.runUpdate();
      if (this.config.autoEmbed && result.needsEmbedding > 0) {
        this.embedQueued = true;
        void this.runEmbed().catch((err) => {
          console.warn("QMD embed after update failed:", err);
        });
      }
      this.ready = true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      console.warn("QMD scheduled update failed:", err);
    }
  }

  private async runUpdate(): Promise<{ needsEmbedding: number }> {
    const store = await this.ensureStore();
    this.indexing = true;
    this.emitProgress({
      phase: "update",
      current: 0,
      total: 0,
      message: "Indexing markdown files…",
    });
    try {
      const result = await store.update({
        collections: [COLLECTION_NAME],
        onProgress: ({ current, total, file }) => {
          this.emitProgress({
            phase: "update",
            current,
            total,
            message: file,
          });
        },
      });
      this.lastUpdatedAt = new Date().toISOString();
      return { needsEmbedding: result.needsEmbedding };
    } finally {
      this.indexing = false;
    }
  }

  private async runEmbed(force = false): Promise<void> {
    const store = await this.ensureStore();
    this.embedding = true;
    this.emitProgress({
      phase: "embed",
      current: 0,
      total: 0,
      message: "Generating embeddings…",
    });
    try {
      await store.embed({
        force,
        collection: COLLECTION_NAME,
        onProgress: ({ chunksEmbedded, totalChunks }) => {
          this.emitProgress({
            phase: "embed",
            current: chunksEmbedded,
            total: totalChunks,
            message: "Embedding documents",
          });
        },
      });
      this.lastUpdatedAt = new Date().toISOString();
    } finally {
      this.embedding = false;
      this.embedQueued = false;
    }
  }

  async search(query: string, limit = 8): Promise<WikiSearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const store = await this.ensureStore();
    if (this.config.mode === "lex") {
      const results = await store.searchLex(q, { limit });
      return results.map((r) => mapLexResult(this.vaultPath, r));
    }
    try {
      const results = await store.search({
        query: q,
        limit,
        rerank: true,
      });
      return results.map((r) => mapHybridResult(this.vaultPath, r));
    } catch (err) {
      console.warn("QMD hybrid search failed, falling back to lex:", err);
      const results = await store.searchLex(q, { limit });
      return results.map((r) => mapLexResult(this.vaultPath, r));
    }
  }

  async close(): Promise<void> {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    this.updateQueued = false;
    this.embedQueued = false;
    this.ready = false;
    this.indexing = false;
    this.embedding = false;
    this.progress = null;
    if (this.store) {
      try {
        await this.store.close();
      } catch (err) {
        console.warn("Failed to close QMD store:", err);
      }
      this.store = null;
    }
  }
}

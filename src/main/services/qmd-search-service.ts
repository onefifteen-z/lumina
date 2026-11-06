import fs from "fs";
import path from "path";
import type {
  QmdSearchConfig,
  QmdSearchProgress,
  QmdSearchStatus,
} from "../../shared/types";
import { DEFAULT_QMD_SEARCH_CONFIG } from "../../shared/types";

import { loadTobiluQmdModule, type TobiluQmdModule } from "./load-tobilu-qmd";
import type { QmdModelManager } from "./qmd-model-manager";

type QmdModule = TobiluQmdModule;
type QmdStore = Awaited<ReturnType<QmdModule["createStore"]>>;
type QmdHybridResult = Awaited<ReturnType<QmdStore["search"]>>[number];
type QmdLexResult = Awaited<ReturnType<QmdStore["searchLex"]>>[number];

export type WikiSearchHit = {
  title: string;
  filename: string;
  excerpt: string;
};

const COLLECTION_NAME = "vault";
/** Only compiled wiki pages are indexed; raw/ sources are excluded. */
const WIKI_DIR = "wiki";
const UPDATE_DEBOUNCE_MS = 500;

function qmdDbPath(vaultPath: string): string {
  return path.join(vaultPath, ".lumina", "qmd", "index.sqlite");
}

/** qmd paths are relative to the wiki/ collection root; callers expect vault-relative. */
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
  let relative = normalized;
  if (normalized.startsWith("qmd://")) {
    const withoutScheme = normalized.slice("qmd://".length);
    const slash = withoutScheme.indexOf("/");
    relative = slash >= 0 ? withoutScheme.slice(slash + 1) : withoutScheme;
  }
  relative = relative.replace(/^\/+/, "");
  if (relative.startsWith(`${COLLECTION_NAME}/`)) {
    relative = relative.slice(COLLECTION_NAME.length + 1);
  }
  return `${WIKI_DIR}/${relative}`;
}

function toExcerpt(text: string): string {
  return text
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
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
  const excerpt = toExcerpt(result.bestChunk || result.body || "");
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
  const excerpt = toExcerpt(result.body || "");
  return {
    title: result.title || path.basename(filename, ".md"),
    filename,
    excerpt,
  };
}

/**
 * Wraps the @tobilu/qmd SDK for per-vault semantic/keyword search used by
 * Chat `search_wiki`. UI search continues to use FlexSearch.
 * Only the embedding model is used: no LLM query expansion and no reranking.
 */
export class QmdSearchService {
  private readonly vaultPath: string;
  private readonly models: QmdModelManager | null;
  private config: QmdSearchConfig;
  private store: QmdStore | null = null;
  private storeEmbedModel: string | null = null;
  private qmdModule: QmdModule | null = null;
  private ready = false;
  private indexing = false;
  private embedding = false;
  private downloading = false;
  private lastUpdatedAt: string | null = null;
  private error: string | null = null;
  private progress: QmdSearchProgress | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private updateQueued = false;
  private embedQueued = false;
  private onProgress: ((progress: QmdSearchProgress) => void) | null = null;

  constructor(
    vaultPath: string,
    config?: Partial<QmdSearchConfig>,
    models: QmdModelManager | null = null,
  ) {
    this.vaultPath = vaultPath;
    this.config = { ...DEFAULT_QMD_SEARCH_CONFIG, ...config };
    this.models = models;
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
      downloading: this.downloading,
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
    this.qmdModule = await loadTobiluQmdModule();
    return this.qmdModule;
  }

  private needsEmbedModel(): boolean {
    return (
      this.models !== null &&
      (this.config.mode !== "lex" || this.config.autoEmbed)
    );
  }

  private async ensureEmbedModelPath(): Promise<string | undefined> {
    if (!this.models || !this.needsEmbedModel()) return undefined;
    if (this.models.isEmbedModelReady()) return this.models.embedModelPath;
    this.downloading = true;
    this.emitProgress({
      phase: "download",
      current: 0,
      total: 0,
      message: "Downloading embedding model…",
    });
    let lastReportedMb = -1;
    try {
      return await this.models.ensureEmbedModel({
        onProgress: ({ receivedBytes, totalBytes }) => {
          const mb = Math.floor(receivedBytes / (1024 * 1024));
          if (mb === lastReportedMb && receivedBytes !== totalBytes) return;
          lastReportedMb = mb;
          this.emitProgress({
            phase: "download",
            current: receivedBytes,
            total: totalBytes,
            message: "Downloading embedding model…",
          });
        },
      });
    } finally {
      this.downloading = false;
    }
  }

  private async ensureStore(): Promise<QmdStore> {
    // A store opened without an embed model would make qmd fall back to its own
    // hf: download, which hangs behind TLS-inspecting proxies.
    if (this.store && (this.storeEmbedModel || !this.needsEmbedModel())) {
      return this.store;
    }
    const embedModel = await this.ensureEmbedModelPath();
    if (this.store) {
      await this.store.close();
      this.store = null;
    }
    const qmd = await this.loadQmdModule();
    const dbPath = qmdDbPath(this.vaultPath);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.store = await qmd.createStore({
      dbPath,
      config: {
        ...(embedModel ? { models: { embed: embedModel } } : {}),
        collections: {
          [COLLECTION_NAME]: {
            path: path.join(this.vaultPath, WIKI_DIR),
            pattern: "**/*.md",
          },
        },
      },
    });
    this.storeEmbedModel = embedModel ?? null;
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
        queries: [
          { type: "lex", query: q },
          { type: "vec", query: q },
        ],
        limit,
        rerank: false,
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

import { ipcMain, BrowserWindow } from "electron";
import type {
  ArticleFile,
  ArticleMeta,
  AppConfig,
  LLMProviderConfig,
  LLMAssistParams,
} from "../shared/types";
import { titleToFilename, parseArticleFile } from "../shared/markdown-parser";
import { FileSystemService } from "./services/filesystem-service";
import { SearchIndexService } from "./services/search-index-service";
import { LLMService } from "./services/llm-service";
import { ConfigService } from "./services/config-service";
import { ChatService } from "./services/chat-service";

// Track whether the renderer has unsaved changes
let rendererHasUnsavedChanges = false;

/** Returns whether the renderer currently reports unsaved changes. */
export function hasUnsavedChanges(): boolean {
  return rendererHasUnsavedChanges;
}

/**
 * Register all IPC handlers, wiring each WikiAPI channel to the
 * appropriate main-process service.
 */
export function registerIpcHandlers(services: {
  fileSystem: FileSystemService | null;
  searchIndex: SearchIndexService | null;
  llm: LLMService | null;
  config: ConfigService;
  mainWindow: BrowserWindow | null;
  chat?: ChatService | null;
}): void {
  let fileSystem = services.fileSystem;
  let searchIndex = services.searchIndex;
  const { config } = services;
  let llm = services.llm;
  const chat = services.chat ?? null;

  // Keep a cached article list for backlink computation
  let cachedArticles: ArticleMeta[] = [];

  /**
   * Initialize vault services for a given path. Creates the marker file,
   * sets up FileSystemService + SearchIndexService, and starts the watcher.
   */
  async function initializeVaultServices(vaultPath: string): Promise<void> {
    await config.createMarkerFile(vaultPath);

    fileSystem = new FileSystemService(vaultPath);

    const newSearchIndex = new SearchIndexService();
    const articles = await fileSystem.scanVault();
    await newSearchIndex.buildIndex(articles);
    searchIndex = newSearchIndex;

    fileSystem.watchVault((event) => {
      services.mainWindow?.webContents.send("wiki:vaultChange", event);
    });
  }

  // ── Article CRUD ─────────────────────────────────────────────────

  ipcMain.handle("wiki:listArticles", async (): Promise<ArticleMeta[]> => {
    if (!fileSystem) return [];
    const articles = await fileSystem.scanVault();
    // Sort descending by modified timestamp (Requirement 4.1)
    articles.sort(
      (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
    );
    cachedArticles = articles;
    return articles;
  });

  ipcMain.handle(
    "wiki:getArticle",
    async (_event, filename: string): Promise<ArticleFile> => {
      if (!fileSystem)
        throw new Error(
          "No vault is open. Please select a vault folder first.",
        );
      try {
        return await fileSystem.readArticle(filename);
      } catch (err) {
        // Handle corrupted Markdown files: return raw content with warning
        console.warn(`Corrupted or unreadable article "${filename}":`, err);
        try {
          const raw = await fileSystem.readRawFile(filename);
          return {
            frontmatter: {
              title: filename,
              tags: [],
              created: "",
              modified: "",
              _corrupted: true,
            },
            content: raw,
            rawContent: raw,
          };
        } catch {
          throw err; // File truly unreadable
        }
      }
    },
  );

  ipcMain.handle(
    "wiki:saveArticle",
    async (_event, article: ArticleFile): Promise<void> => {
      if (!fileSystem)
        throw new Error(
          "No vault is open. Please select a vault folder first.",
        );
      await fileSystem.writeArticle(article);
      // Refresh the search index with updated article metadata
      const articles = await fileSystem.scanVault();
      if (searchIndex) await searchIndex.buildIndex(articles);
      cachedArticles = articles;
    },
  );

  ipcMain.handle(
    "wiki:deleteArticle",
    async (_event, title: string): Promise<void> => {
      if (!fileSystem)
        throw new Error(
          "No vault is open. Please select a vault folder first.",
        );
      const filename = titleToFilename(title) + ".md";
      await fileSystem.deleteArticle(filename);
      searchIndex?.removeDocument(title);
      cachedArticles = cachedArticles.filter((a) => a.title !== title);
    },
  );

  ipcMain.handle(
    "wiki:articleExists",
    async (_event, title: string): Promise<boolean> => {
      if (!fileSystem) return false;
      const filename = titleToFilename(title) + ".md";
      return fileSystem.fileExists(filename);
    },
  );

  // ── Search ───────────────────────────────────────────────────────

  ipcMain.handle("wiki:search", async (_event, query: string) => {
    if (!searchIndex) return [];
    return searchIndex.search(query);
  });

  ipcMain.handle("wiki:searchByTag", async (_event, tag: string) => {
    if (!searchIndex) return [];
    return searchIndex.searchByTag(tag);
  });

  // ── Link resolution ──────────────────────────────────────────────

  ipcMain.handle(
    "wiki:getBacklinks",
    async (
      _event,
      title: string,
    ): Promise<{ title: string; filename: string }[]> => {
      if (!fileSystem) return [];
      // Scan cached articles: if article A has a wikilink to `title`, A is a backlink
      const backlinks: { title: string; filename: string }[] = [];
      for (const article of cachedArticles) {
        if (
          article.wikilinks.some(
            (link) => link.toLowerCase() === title.toLowerCase(),
          )
        ) {
          backlinks.push({ title: article.title, filename: article.filename });
        }
      }
      return backlinks;
    },
  );

  ipcMain.handle(
    "wiki:resolveWikilink",
    async (
      _event,
      target: string,
    ): Promise<{ exists: boolean; title: string }> => {
      if (!fileSystem) return { exists: false, title: target };
      const filename = titleToFilename(target) + ".md";
      const exists = await fileSystem.fileExists(filename);
      return { exists, title: target };
    },
  );

  // ── LLM ──────────────────────────────────────────────────────────

  ipcMain.handle(
    "wiki:generateArticle",
    async (event, requestId: string, prompt: string): Promise<void> => {
      if (!llm) {
        const sender = event.sender;
        sender.send(
          "wiki:llmChunkEnd",
          requestId,
          "LLM service is not configured",
        );
        return;
      }

      const sender = event.sender;
      try {
        for await (const chunk of llm.generateArticle(prompt)) {
          sender.send("wiki:llmChunk", requestId, chunk);
        }
        sender.send("wiki:llmChunkEnd", requestId);
      } catch (err) {
        sender.send(
          "wiki:llmChunkEnd",
          requestId,
          (err as Error).message || "LLM generation failed",
        );
      }
    },
  );

  ipcMain.handle(
    "wiki:assistContent",
    async (_event, params: LLMAssistParams): Promise<string> => {
      if (!llm) {
        throw new Error("LLM service is not configured");
      }

      switch (params.action) {
        case "summarize":
          return llm.summarize(params.text);
        case "expand":
          return llm.expand(params.text);
        case "refine":
          return llm.refine(params.text);
        default:
          throw new Error(`Unknown assist action: ${params.action}`);
      }
    },
  );

  ipcMain.handle("wiki:isLLMAvailable", async (): Promise<boolean> => {
    return llm?.isAvailable() ?? false;
  });

  // ── Chat ──────────────────────────────────────────────────────

  ipcMain.handle("wiki:startChatSession", async (event) => {
    if (!chat) throw new Error("Chat service is not available.");
    const { session, warning } = await chat.startSession();
    if (warning) {
      event.sender.send("wiki:chatWarning", { message: warning });
    }
    return session;
  });

  ipcMain.handle(
    "wiki:sendChatMessage",
    async (event, payload: { requestId: string; content: string }) => {
      if (!chat) throw new Error("Chat service is not available.");
      const { requestId, content } = payload;
      const sender = event.sender;
      try {
        for await (const chunk of chat.sendMessage(content)) {
          sender.send("wiki:chatChunk", { requestId, chunk });
        }
        sender.send("wiki:chatEnd", { requestId });
      } catch (err) {
        const errorMessage = (err as Error).message || "Chat generation failed";
        sender.send("wiki:chatEnd", { requestId, error: errorMessage });
      }
    },
  );

  ipcMain.handle("wiki:stopChatGeneration", async () => {
    if (!chat) throw new Error("Chat service is not available.");
    chat.stopGeneration();
  });

  ipcMain.handle("wiki:getChatSession", async () => {
    if (!chat) return null;
    return chat.getSession();
  });

  // ── Config ───────────────────────────────────────────────────────

  ipcMain.handle("wiki:getConfig", async (): Promise<AppConfig> => {
    return config.getConfig();
  });

  ipcMain.handle(
    "wiki:saveConfig",
    async (_event, partial: Partial<AppConfig>): Promise<void> => {
      // Detect transition from no-vault to vault-selected
      const isNewVault =
        typeof partial.vaultPath === "string" &&
        partial.vaultPath.length > 0 &&
        fileSystem === null;

      if (isNewVault) {
        try {
          await initializeVaultServices(partial.vaultPath!);
        } catch (err) {
          // Do not persist vaultPath on failure — re-throw so renderer receives the error
          throw err;
        }
      }

      config.saveConfig(partial);
    },
  );

  ipcMain.handle("wiki:getApiKey", async (): Promise<string> => {
    return config.getApiKey();
  });

  ipcMain.handle(
    "wiki:saveApiKey",
    async (_event, key: string): Promise<void> => {
      config.saveApiKey(key);
    },
  );

  ipcMain.handle(
    "wiki:testLLMConnection",
    async (_event, providerConfig: LLMProviderConfig): Promise<boolean> => {
      const apiKey = config.getApiKey();
      const testService = new LLMService(providerConfig, apiKey);
      return testService.testConnection();
    },
  );

  ipcMain.handle("wiki:selectVaultFolder", async (): Promise<string | null> => {
    return config.selectVaultFolder();
  });

  // ── Lifecycle ────────────────────────────────────────────────────

  ipcMain.on("wiki:notifyUnsavedChanges", (_event, isDirty: boolean) => {
    rendererHasUnsavedChanges = isDirty;
  });

  ipcMain.handle("wiki:confirmClose", async (): Promise<boolean> => {
    // The renderer calls this to confirm it's safe to close.
    // Actual unsaved-changes logic lives in the renderer; this is the
    // acknowledgement channel.
    return true;
  });
}

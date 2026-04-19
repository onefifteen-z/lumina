import { ipcMain, BrowserWindow } from "electron";
import { shell } from "electron";
import type {
  ArticleFile,
  ArticleMeta,
  AppConfig,
  LLMProviderConfig,
  LLMAssistParams,
} from "../shared/types";
import { reconfigureTelemetry } from "./telemetry";
import { titleToFilename, parseArticleFile } from "../shared/markdown-parser";
import { FileSystemService } from "./services/filesystem-service";
import { SearchIndexService } from "./services/search-index-service";
import { LLMService, LLMError } from "./services/llm-service";
import { ConfigService } from "./services/config-service";
import { ChatService } from "./services/chat-service";
import { ChatHistoryService } from "./services/chat-history-service";
import { debugLog, getDebugLogBacklog } from "./debug-log";

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
  chatHistory?: ChatHistoryService | null;
}): void {
  let fileSystem = services.fileSystem;
  let searchIndex = services.searchIndex;
  const { config } = services;
  let llm = services.llm;
  const chat = services.chat ?? null;
  const chatHistory = services.chatHistory ?? null;

  /**
   * Rebuild the LLM service from the current persisted config and API key,
   * then push the new instance into the chat service so it takes effect immediately.
   */
  function rebuildLLMService(): void {
    const appConfig = config.getConfig();
    if (appConfig.llmProvider) {
      const apiKey = config.getApiKey();
      llm = new LLMService(appConfig.llmProvider, apiKey);
    } else {
      llm = null;
    }
    chat?.setLLMService(llm);
  }

  // Keep a cached article list for backlink computation
  let cachedArticles: ArticleMeta[] = [];

  /**
   * Initialize vault services for a given path. Creates the marker file,
   * sets up FileSystemService + SearchIndexService, and starts the watcher.
   */
  async function initializeVaultServices(vaultPath: string): Promise<void> {
    // Stop any existing watcher before replacing the service
    fileSystem?.stopWatching();

    await config.createMarkerFile(vaultPath);
    config.addVaultToHistory(vaultPath);

    fileSystem = new FileSystemService(vaultPath);

    const newSearchIndex = new SearchIndexService();
    const articles = await fileSystem.scanVault();
    await newSearchIndex.buildIndex(articles);
    searchIndex = newSearchIndex;

    fileSystem.watchVault((event) => {
      services.mainWindow?.webContents.send("wiki:vaultChange", event);
    });

    chat?.setFileSystemService(fileSystem);
    try {
      chatHistory?.open(vaultPath);
    } catch (err) {
      console.warn("Failed to open chat history DB:", err);
    }
    // Reset chat session so the new vault's CLAUDE.md is loaded
    try {
      await chat?.startSession();
    } catch (err) {
      console.warn("Failed to reset chat session after vault switch:", err);
    }
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

  ipcMain.handle(
    "wiki:createFolder",
    async (_event, relativePath: string): Promise<void> => {
      if (!fileSystem) return;
      await fileSystem.createFolder(relativePath);
    },
  );

  async function refreshArticlesIndex(): Promise<void> {
    if (!fileSystem) return;
    const articles = await fileSystem.scanVault();
    if (searchIndex) await searchIndex.buildIndex(articles);
    cachedArticles = articles;
  }

  ipcMain.handle(
    "wiki:moveVaultEntry",
    async (_event, from: string, toDir: string): Promise<void> => {
      if (!fileSystem)
        throw new Error(
          "No vault is open. Please select a vault folder first.",
        );
      await fileSystem.moveVaultEntry(from, toDir);
      await refreshArticlesIndex();
    },
  );

  ipcMain.handle(
    "wiki:importExternalPaths",
    async (_event, absolutePaths: string[], toDir: string): Promise<void> => {
      if (!fileSystem)
        throw new Error(
          "No vault is open. Please select a vault folder first.",
        );
      await fileSystem.importExternalEntries(absolutePaths, toDir);
      await refreshArticlesIndex();
    },
  );

  ipcMain.handle(
    "wiki:getAbsolutePath",
    async (_event, filename: string): Promise<string> => {
      if (!fileSystem) throw new Error("No vault is open.");
      return require("path").join(fileSystem.getVaultPath(), filename);
    },
  );

  ipcMain.handle(
    "wiki:readFile",
    async (_event, filename: string): Promise<string> => {
      if (!fileSystem) throw new Error("No vault is open.");
      return fileSystem.readRawFile(filename);
    },
  );

  ipcMain.handle(
    "wiki:revealInFinder",
    async (_event, filename: string): Promise<void> => {
      if (!fileSystem) throw new Error("No vault is open.");
      const abs = require("path").join(fileSystem.getVaultPath(), filename);
      shell.showItemInFolder(abs);
    },
  );

  // ── Bookmarks (vault JSON) ───────────────────────────────────────

  ipcMain.handle("wiki:getBookmarks", async (): Promise<string[]> => {
    if (!fileSystem) return [];
    return fileSystem.getBookmarks();
  });

  ipcMain.handle(
    "wiki:setBookmarks",
    async (_event, filenames: string[]): Promise<void> => {
      if (!fileSystem)
        throw new Error(
          "No vault is open. Please select a vault folder first.",
        );
      await fileSystem.setBookmarks(filenames);
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
    ): Promise<{ exists: boolean; title: string; filename?: string }> => {
      if (!fileSystem) return { exists: false, title: target };

      // Obsidian-style: scan vault and find the file whose basename matches the
      // link target, regardless of which subfolder it lives in.
      try {
        const articles = await fileSystem.scanVault();
        const targetLower = target.toLowerCase();
        const targetAsFilename = titleToFilename(target).toLowerCase();

        const match = articles.find((a) => {
          if (!a.filename.toLowerCase().endsWith(".md")) return false;
          const basename = a.filename
            .split("/")
            .pop()!
            .replace(/\.md$/i, "")
            .toLowerCase();
          return basename === targetLower || basename === targetAsFilename;
        });

        if (match) {
          return { exists: true, title: match.title, filename: match.filename };
        }
      } catch {
        // fall through
      }

      return { exists: false, title: target };
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

      const startedAt = Date.now();
      let textChars = 0;
      let thinkingChars = 0;
      let traceCount = 0;
      debugLog("info", "chat", `→ sendChatMessage`, {
        requestId,
        contentPreview: content.slice(0, 200),
        contentLen: content.length,
      });

      try {
        for await (const chunk of chat.sendMessage(content)) {
          if (chunk.type === 'thinking') {
            thinkingChars += chunk.content.length;
            debugLog("stream", "chat", `thinking +${chunk.content.length}c`, {
              requestId,
              preview: chunk.content.slice(0, 120),
            });
            sender.send("wiki:chatThinkingChunk", { requestId, chunk: chunk.content });
          } else if (
            chunk.type === 'narration' ||
            chunk.type === 'tool_call' ||
            chunk.type === 'tool_result'
          ) {
            traceCount += 1;
            debugLog("info", "chat", `trace ${chunk.type}`, { requestId, chunk });
            sender.send("wiki:chatTraceChunk", { requestId, chunk });
          } else {
            textChars += chunk.content.length;
            debugLog("stream", "chat", `text +${chunk.content.length}c`, {
              requestId,
              preview: chunk.content.slice(0, 120),
            });
            sender.send("wiki:chatChunk", { requestId, chunk: chunk.content });
          }
        }
        debugLog("info", "chat", `← chatEnd ok`, {
          requestId,
          ms: Date.now() - startedAt,
          textChars,
          thinkingChars,
          traceCount,
        });
        sender.send("wiki:chatEnd", { requestId });
      } catch (err) {
        const code = err instanceof LLMError ? err.code : "unknown";
        const errorMessage = (err as Error).message || "Chat generation failed";
        debugLog("error", "chat", `← chatEnd error`, {
          requestId,
          ms: Date.now() - startedAt,
          code,
          errorMessage,
        });
        sender.send("wiki:chatEnd", { requestId, error: `${code}:${errorMessage}` });
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

  // ── Chat History ─────────────────────────────────────────────────

  ipcMain.handle("wiki:listChatSessions", async () => {
    return chatHistory?.listSessions() ?? [];
  });

  ipcMain.handle("wiki:getChatHistory", async (_event, sessionId: string) => {
    return chatHistory?.getSession(sessionId) ?? null;
  });

  ipcMain.handle("wiki:loadChatSession", async (_event, sessionId: string) => {
    if (!chat) throw new Error("Chat service is not available.");
    const stored = chatHistory?.getSession(sessionId);
    if (!stored) return null;
    // Strip the `title` field — it lives only in the history DB, not in the
    // in-memory ChatSession.
    return chat.loadSession({
      id: stored.id,
      systemPrompt: stored.systemPrompt,
      messages: stored.messages,
      createdAt: stored.createdAt,
    });
  });

  ipcMain.handle("wiki:saveChatSession", async (_event, session: any, title?: string) => {
    chatHistory?.saveSession(session, title);
  });

  ipcMain.handle("wiki:deleteChatSession", async (_event, sessionId: string) => {
    chatHistory?.deleteSession(sessionId);
  });

  ipcMain.handle("wiki:renameChatSession", async (_event, sessionId: string, newTitle: string) => {
    chatHistory?.renameSession(sessionId, newTitle);
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
      // If the provider config changed, rebuild the LLM service immediately.
      if (partial.llmProvider !== undefined) {
        rebuildLLMService();
      }
      // If the Phoenix config changed, reconfigure telemetry immediately.
      if (partial.phoenix !== undefined) {
        reconfigureTelemetry(partial.phoenix).catch(() => {});
      }
    },
  );

  ipcMain.handle("wiki:getApiKey", async (): Promise<string> => {
    return config.getApiKey();
  });

  ipcMain.handle(
    "wiki:saveApiKey",
    async (_event, key: string): Promise<void> => {
      config.saveApiKey(key);
      rebuildLLMService();
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

  // ── Vault history & switching ────────────────────────────────────

  ipcMain.handle("wiki:getVaultHistory", () => {
    return config.getVaultHistory();
  });

  ipcMain.handle("wiki:switchVault", async (_event, vaultPath: string): Promise<void> => {
    await initializeVaultServices(vaultPath);
    config.saveConfig({ vaultPath });
    services.mainWindow?.webContents.send("wiki:vaultSwitched", vaultPath);
  });

  ipcMain.handle("wiki:removeVaultFromHistory", (_event, vaultPath: string): void => {
    config.removeVaultFromHistory(vaultPath);
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

  // ── Debug log ────────────────────────────────────────────────────

  ipcMain.handle("wiki:getDebugLogBacklog", () => {
    return getDebugLogBacklog();
  });

  ipcMain.on(
    "wiki:rendererDebugLog",
    (
      _event,
      payload: { tag: string; message: string; data?: unknown },
    ) => {
      debugLog("debug", `ui:${payload.tag}`, payload.message, payload.data);
    },
  );
}

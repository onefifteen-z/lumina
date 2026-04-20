import { contextBridge, ipcRenderer } from "electron";
import type {
  ArticleFile,
  AppConfig,
  LLMProviderConfig,
  LLMAssistParams,
  VaultEntry,
  WikiAPI,
  ChatTraceChunk,
  DebugLogEntry,
  ChatContentBlock,
  IngestRequest,
} from "../shared/types";

/**
 * Typed preload script exposing the WikiAPI to the renderer via contextBridge.
 * Each method wraps an ipcRenderer.invoke call with a typed channel name.
 * Streaming LLM generation uses ipcRenderer.on to receive chunks as an async iterable.
 */
const api: WikiAPI = {
  // ── Article CRUD ─────────────────────────────────────────────────

  listArticles() {
    return ipcRenderer.invoke("wiki:listArticles");
  },

  getArticle(filename: string) {
    return ipcRenderer.invoke("wiki:getArticle", filename);
  },

  saveArticle(article: ArticleFile) {
    return ipcRenderer.invoke("wiki:saveArticle", article);
  },

  deleteArticle(title: string) {
    return ipcRenderer.invoke("wiki:deleteArticle", title);
  },

  articleExists(title: string) {
    return ipcRenderer.invoke("wiki:articleExists", title);
  },

  createFolder(relativePath: string) {
    return ipcRenderer.invoke("wiki:createFolder", relativePath);
  },

  moveVaultEntry(from: string, toDir: string) {
    return ipcRenderer.invoke("wiki:moveVaultEntry", from, toDir);
  },

  importExternalPaths(absolutePaths: string[], toDir: string) {
    return ipcRenderer.invoke("wiki:importExternalPaths", absolutePaths, toDir);
  },

  getAbsolutePath(filename: string) {
    return ipcRenderer.invoke("wiki:getAbsolutePath", filename);
  },

  readFile(filename: string) {
    return ipcRenderer.invoke("wiki:readFile", filename);
  },

  revealInFinder(filename: string) {
    return ipcRenderer.invoke("wiki:revealInFinder", filename);
  },

  // ── Search ───────────────────────────────────────────────────────

  search(query: string) {
    return ipcRenderer.invoke("wiki:search", query);
  },

  searchByTag(tag: string) {
    return ipcRenderer.invoke("wiki:searchByTag", tag);
  },

  // ── Link resolution ──────────────────────────────────────────────

  getBacklinks(title: string) {
    return ipcRenderer.invoke("wiki:getBacklinks", title);
  },

  resolveWikilink(target: string) {
    return ipcRenderer.invoke("wiki:resolveWikilink", target);
  },

  // ── LLM ──────────────────────────────────────────────────────────

  generateArticle(prompt: string): Promise<AsyncIterable<string>> {
    return new Promise((resolve) => {
      // Request the main process to start streaming generation.
      // The main process will send chunks via 'wiki:llmChunk' and
      // signal completion via 'wiki:llmChunkEnd'.
      const requestId = `llm-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const chunks: string[] = [];
      let done = false;
      let error: Error | null = null;
      let waiting: (() => void) | null = null;

      const onChunk = (
        _event: Electron.IpcRendererEvent,
        id: string,
        chunk: string,
      ) => {
        if (id !== requestId) return;
        chunks.push(chunk);
        if (waiting) {
          const resume = waiting;
          waiting = null;
          resume();
        }
      };

      const onEnd = (
        _event: Electron.IpcRendererEvent,
        id: string,
        err?: string,
      ) => {
        if (id !== requestId) return;
        done = true;
        if (err) error = new Error(err);
        ipcRenderer.removeListener("wiki:llmChunk", onChunk);
        ipcRenderer.removeListener("wiki:llmChunkEnd", onEnd);
        if (waiting) {
          const resume = waiting;
          waiting = null;
          resume();
        }
      };

      ipcRenderer.on("wiki:llmChunk", onChunk);
      ipcRenderer.on("wiki:llmChunkEnd", onEnd);

      // Create the async iterable that the renderer will consume
      const iterable: AsyncIterable<string> = {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<string>> {
              return new Promise((res, rej) => {
                if (chunks.length > 0) {
                  res({ value: chunks.shift()!, done: false });
                  return;
                }
                if (error) {
                  rej(error);
                  return;
                }
                if (done) {
                  res({ value: undefined as any, done: true });
                  return;
                }
                // Wait for next chunk or completion
                waiting = () => {
                  if (chunks.length > 0) {
                    res({ value: chunks.shift()!, done: false });
                  } else if (error) {
                    rej(error);
                  } else {
                    res({ value: undefined as any, done: true });
                  }
                };
              });
            },
          };
        },
      };

      // Kick off the generation on the main process side
      ipcRenderer.invoke("wiki:generateArticle", requestId, prompt);

      resolve(iterable);
    });
  },

  assistContent(params: LLMAssistParams) {
    return ipcRenderer.invoke("wiki:assistContent", params);
  },

  isLLMAvailable() {
    return ipcRenderer.invoke("wiki:isLLMAvailable");
  },

  // ── Config ───────────────────────────────────────────────────────

  getConfig() {
    return ipcRenderer.invoke("wiki:getConfig");
  },

  saveConfig(config: Partial<AppConfig>) {
    return ipcRenderer.invoke("wiki:saveConfig", config);
  },

  getApiKey() {
    return ipcRenderer.invoke("wiki:getApiKey");
  },

  saveApiKey(key: string) {
    return ipcRenderer.invoke("wiki:saveApiKey", key);
  },

  testLLMConnection(config: LLMProviderConfig) {
    return ipcRenderer.invoke("wiki:testLLMConnection", config);
  },

  selectVaultFolder() {
    return ipcRenderer.invoke("wiki:selectVaultFolder");
  },

  getVaultHistory(): Promise<VaultEntry[]> {
    return ipcRenderer.invoke("wiki:getVaultHistory");
  },

  switchVault(vaultPath: string) {
    return ipcRenderer.invoke("wiki:switchVault", vaultPath);
  },

  removeVaultFromHistory(vaultPath: string) {
    return ipcRenderer.invoke("wiki:removeVaultFromHistory", vaultPath);
  },

  onVaultSwitched(callback: (vaultPath: string) => void) {
    ipcRenderer.on("wiki:vaultSwitched", (_event, vaultPath: string) => callback(vaultPath));
  },

  removeVaultSwitchedListener() {
    ipcRenderer.removeAllListeners("wiki:vaultSwitched");
  },

  getBookmarks() {
    return ipcRenderer.invoke("wiki:getBookmarks");
  },

  setBookmarks(filenames: string[]) {
    return ipcRenderer.invoke("wiki:setBookmarks", filenames);
  },

  // ── Vault file watcher ─────────────────────────────────────────

  onVaultChange(
    callback: (event: import("../shared/types").VaultChangeEvent) => void,
  ) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      change: import("../shared/types").VaultChangeEvent,
    ) => {
      callback(change);
    };
    ipcRenderer.on("wiki:vaultChange", handler);
  },

  removeVaultChangeListener() {
    ipcRenderer.removeAllListeners("wiki:vaultChange");
  },

  // ── Chat ──────────────────────────────────────────────────────────

  startChatSession() {
    return ipcRenderer.invoke("wiki:startChatSession");
  },

  sendChatMessage(
    content: string,
    blocks?: ChatContentBlock[],
    options?: { reloadClaudeMd?: boolean },
  ) {
    const requestId = Date.now().toString();
    return ipcRenderer.invoke("wiki:sendChatMessage", {
      requestId,
      content,
      blocks,
      reloadClaudeMd: options?.reloadClaudeMd,
    });
  },

  stopChatGeneration() {
    return ipcRenderer.invoke("wiki:stopChatGeneration");
  },

  getChatSession() {
    return ipcRenderer.invoke("wiki:getChatSession");
  },

  onChatChunk(callback: (chunk: string) => void) {
    ipcRenderer.on(
      "wiki:chatChunk",
      (
        _event: Electron.IpcRendererEvent,
        { chunk }: { requestId: string; chunk: string },
      ) => {
        callback(chunk);
      },
    );
  },

  onChatThinkingChunk(callback: (chunk: string) => void) {
    ipcRenderer.on(
      "wiki:chatThinkingChunk",
      (
        _event: Electron.IpcRendererEvent,
        { chunk }: { requestId: string; chunk: string },
      ) => {
        callback(chunk);
      },
    );
  },

  onChatTraceChunk(callback: (chunk: ChatTraceChunk) => void) {
    ipcRenderer.on(
      "wiki:chatTraceChunk",
      (
        _event: Electron.IpcRendererEvent,
        { chunk }: { requestId: string; chunk: ChatTraceChunk },
      ) => {
        callback(chunk);
      },
    );
  },

  onChatEnd(callback: (error?: string) => void) {
    ipcRenderer.on(
      "wiki:chatEnd",
      (
        _event: Electron.IpcRendererEvent,
        { error }: { requestId: string; error?: string },
      ) => {
        callback(error);
      },
    );
  },

  onChatWarning(callback: (message: string) => void) {
    ipcRenderer.on(
      "wiki:chatWarning",
      (_event: Electron.IpcRendererEvent, { message }: { message: string }) => {
        callback(message);
      },
    );
  },

  removeChatListeners() {
    ipcRenderer.removeAllListeners("wiki:chatChunk");
    ipcRenderer.removeAllListeners("wiki:chatThinkingChunk");
    ipcRenderer.removeAllListeners("wiki:chatTraceChunk");
    ipcRenderer.removeAllListeners("wiki:chatEnd");
    ipcRenderer.removeAllListeners("wiki:chatWarning");
  },

  // ── Chat History ─────────────────────────────────────────────────

  listChatSessions() {
    return ipcRenderer.invoke("wiki:listChatSessions");
  },

  getChatHistory(sessionId: string) {
    return ipcRenderer.invoke("wiki:getChatHistory", sessionId);
  },

  loadChatSession(sessionId: string) {
    return ipcRenderer.invoke("wiki:loadChatSession", sessionId);
  },

  saveChatSession(session: any, title?: string) {
    return ipcRenderer.invoke("wiki:saveChatSession", session, title);
  },

  deleteChatSession(sessionId: string) {
    return ipcRenderer.invoke("wiki:deleteChatSession", sessionId);
  },

  // ── Ingest ───────────────────────────────────────────────────────

  // Deprecated: superseded by the model-callable `ingest_source` tool.
  // Kept exposed in case we want to re-add a power-user shortcut later.
  ingestFile(request: IngestRequest) {
    return ipcRenderer.invoke("wiki:ingestFile", request);
  },

  renameChatSession(sessionId: string, newTitle: string) {
    return ipcRenderer.invoke("wiki:renameChatSession", sessionId, newTitle);
  },

  // ── Lifecycle ────────────────────────────────────────────────────

  onUnsavedChanges(callback: (hasChanges: boolean) => void) {
    ipcRenderer.on("wiki:unsavedChanges", (_event, hasChanges: boolean) => {
      callback(hasChanges);
    });
  },

  notifyUnsavedChanges(isDirty: boolean) {
    ipcRenderer.send("wiki:notifyUnsavedChanges", isDirty);
  },

  confirmClose() {
    return ipcRenderer.invoke("wiki:confirmClose");
  },

  // ── Templates ────────────────────────────────────────────────────

  getClaudeMdTemplate(): Promise<string | null> {
    return ipcRenderer.invoke("wiki:getClaudeMdTemplate");
  },

  // ── Debug log ────────────────────────────────────────────────────

  getDebugLogBacklog() {
    return ipcRenderer.invoke("wiki:getDebugLogBacklog");
  },

  onDebugLog(callback: (entry: DebugLogEntry) => void) {
    const handler = (_e: Electron.IpcRendererEvent, entry: DebugLogEntry) => {
      callback(entry);
    };
    ipcRenderer.on("wiki:debugLog", handler);
  },

  removeDebugLogListeners() {
    ipcRenderer.removeAllListeners("wiki:debugLog");
  },

  notifyDebug(tag: string, message: string, data?: unknown) {
    ipcRenderer.send("wiki:rendererDebugLog", { tag, message, data });
  },
};

contextBridge.exposeInMainWorld("api", api);

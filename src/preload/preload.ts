import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  ArticleFile,
  AppConfig,
  LLMProviderConfig,
  LLMAssistParams,
  VaultEntry,
  VaultConfig,
  WikiAPI,
  ChatTraceChunk,
  DebugLogEntry,
  ChatContentBlock,
  ConfirmationRequest,
  IngestRequest,
  QmdSearchProgress,
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

  saveArticle(article: ArticleFile, targetFolder?: string) {
    return ipcRenderer.invoke("wiki:saveArticle", article, targetFolder);
  },

  writeRawFile(filename: string, content: string): Promise<void> {
    return ipcRenderer.invoke("wiki:writeRawFile", filename, content);
  },

  createVaultClaudeMdFromTemplate() {
    return ipcRenderer.invoke("wiki:createVaultClaudeMdFromTemplate");
  },

  getBundledClaudeMdTemplate() {
    return ipcRenderer.invoke("wiki:getBundledClaudeMdTemplate");
  },

  getBundledIngestMdTemplate() {
    return ipcRenderer.invoke("wiki:getBundledIngestMdTemplate");
  },

  deleteArticle(title: string) {
    return ipcRenderer.invoke("wiki:deleteArticle", title);
  },
  deleteVaultEntry(relativePath: string) {
    return ipcRenderer.invoke("wiki:deleteVaultEntry", relativePath);
  },

  articleExists(title: string, targetFolder?: string) {
    return ipcRenderer.invoke("wiki:articleExists", title, targetFolder);
  },

  createFolder(relativePath: string) {
    return ipcRenderer.invoke("wiki:createFolder", relativePath);
  },

  listEmptyWikiRawFolders() {
    return ipcRenderer.invoke("wiki:listEmptyWikiRawFolders");
  },

  isVaultInitialized() {
    return ipcRenderer.invoke("wiki:isVaultInitialized");
  },

  createVaultMarker() {
    return ipcRenderer.invoke("wiki:createVaultMarker");
  },

  moveVaultEntry(from: string, toDir: string) {
    return ipcRenderer.invoke("wiki:moveVaultEntry", from, toDir);
  },

  importExternalPaths(absolutePaths: string[], toDir: string) {
    return ipcRenderer.invoke("wiki:importExternalPaths", absolutePaths, toDir);
  },

  getPathForFile(file: File) {
    return webUtils.getPathForFile(file);
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

  getQmdStatus() {
    return ipcRenderer.invoke("wiki:getQmdStatus");
  },

  rebuildQmdIndex() {
    return ipcRenderer.invoke("wiki:rebuildQmdIndex");
  },

  getMcpStatus() {
    return ipcRenderer.invoke("wiki:getMcpStatus");
  },

  regenerateMcpToken() {
    return ipcRenderer.invoke("wiki:regenerateMcpToken");
  },

  onQmdProgress(callback: (progress: QmdSearchProgress) => void) {
    ipcRenderer.on("wiki:qmdProgress", (_event, progress: QmdSearchProgress) =>
      callback(progress),
    );
  },

  removeQmdProgressListener() {
    ipcRenderer.removeAllListeners("wiki:qmdProgress");
  },

  // ── Link resolution ──────────────────────────────────────────────

  getBacklinks(title: string) {
    return ipcRenderer.invoke("wiki:getBacklinks", title);
  },

  resolveWikilink(target: string) {
    return ipcRenderer.invoke("wiki:resolveWikilink", target);
  },

  resolveWikilinks(targets: string[]) {
    return ipcRenderer.invoke("wiki:resolveWikilinks", targets);
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

  getAppVersion() {
    return ipcRenderer.invoke("wiki:getAppVersion");
  },

  saveConfig(config: Partial<AppConfig>) {
    return ipcRenderer.invoke("wiki:saveConfig", config);
  },

  getVaultConfig() {
    return ipcRenderer.invoke("wiki:getVaultConfig");
  },

  saveVaultConfig(config: Partial<VaultConfig>) {
    return ipcRenderer.invoke("wiki:saveVaultConfig", config);
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

  onConfirmRequest(callback: (request: ConfirmationRequest) => void) {
    ipcRenderer.on(
      "wiki:confirmRequest",
      (_event: Electron.IpcRendererEvent, request: ConfirmationRequest) => {
        callback(request);
      },
    );
  },

  removeConfirmRequestListener() {
    ipcRenderer.removeAllListeners("wiki:confirmRequest");
  },

  replyConfirm(id: string, approved: boolean) {
    return ipcRenderer.invoke("wiki:confirmReply", { id, approved });
  },

  // Dev-only helper: trigger a confirmation prompt directly from the
  // renderer console (`await window.api.__debugTriggerConfirmation(...)`).
  // The main-process handler only exists in NODE_ENV=development, so in
  // a packaged build this invoke will reject harmlessly.
  __debugTriggerConfirmation(opts?: {
    title?: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: "default" | "warning" | "danger";
  }): Promise<boolean> {
    return ipcRenderer.invoke("wiki:__debugTriggerConfirmation", opts ?? {});
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

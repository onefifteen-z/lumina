import { contextBridge, ipcRenderer } from "electron";
import type {
  ArticleFile,
  AppConfig,
  LLMProviderConfig,
  LLMAssistParams,
  WikiAPI,
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

  getArticle(title: string) {
    return ipcRenderer.invoke("wiki:getArticle", title);
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

  testLLMConnection(config: LLMProviderConfig) {
    return ipcRenderer.invoke("wiki:testLLMConnection", config);
  },

  selectVaultFolder() {
    return ipcRenderer.invoke("wiki:selectVaultFolder");
  },

  // ── Lifecycle ────────────────────────────────────────────────────

  onUnsavedChanges(callback: (hasChanges: boolean) => void) {
    ipcRenderer.on("wiki:unsavedChanges", (_event, hasChanges: boolean) => {
      callback(hasChanges);
    });
  },

  confirmClose() {
    return ipcRenderer.invoke("wiki:confirmClose");
  },
};

contextBridge.exposeInMainWorld("api", api);

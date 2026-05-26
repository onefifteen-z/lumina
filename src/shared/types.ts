// Shared type definitions for LLM Wiki

/** YAML frontmatter metadata stored at the top of each Markdown article file. */
export interface FrontmatterData {
  title: string;
  tags: string[];
  created: string; // ISO 8601 timestamp
  modified: string; // ISO 8601 timestamp
  [key: string]: unknown; // Allow additional user-defined fields
}

/** In-memory representation of a wiki article, mapping directly to a Markdown file on disk. */
export interface ArticleFile {
  frontmatter: FrontmatterData;
  content: string; // Markdown body (everything after frontmatter)
  rawContent: string; // Original full file content for round-trip fidelity
}

/** Lightweight article metadata used for lists, search indexing, and link resolution. */
export interface ArticleMeta {
  title: string;
  filename: string;
  tags: string[];
  created: string;
  modified: string;
  wikilinks: string[]; // Titles of articles linked from this article
  excerpt: string; // First ~200 chars of body for search result previews
  /**
   * Raw-source references declared in the article's `sources` frontmatter
   * field. Populated only for wiki .md files that declare them; absent on
   * non-markdown leaves and on wiki pages that don't reference any source.
   *
   * Powers the "ingested" badge on raw/ files in the file tree — a raw
   * file is shown as ingested iff some wiki page references it here.
   */
  sources?: string[];
}

/** A single search result entry. */
export interface SearchResult {
  title: string;
  filename: string;
  excerpt: string;
  matches: SearchMatch[];
  score: number;
}

/** Describes where a search match occurred. */
export interface SearchMatch {
  field: "title" | "content" | "tags";
  snippet: string; // Context around the match with highlights
}

/** A parsed wikilink reference extracted from Markdown content. */
export interface WikilinkRef {
  target: string; // The article title referenced
  alias?: string; // Optional display text: [[target|alias]]
  position: { start: number; end: number }; // Character offsets in content
}

/** A parsed embed reference extracted from Markdown content. */
export interface EmbedRef {
  target: string; // The article title to embed
  position: { start: number; end: number }; // Character offsets in content
}

/**
 * Visual tone for a confirmation prompt. Drives banner border / button
 * color in the renderer. Keep this tiny and stable — each new tone is a
 * design decision, not a free-form colour choice.
 */
export type ConfirmationTone = "default" | "warning" | "danger";

/**
 * A confirm/cancel prompt issued by the main process. The renderer shows
 * it above the chat input and replies with an approval boolean. `id`
 * uniquely pairs the request with the reply so concurrent prompts can't
 * clobber each other's resolvers.
 *
 * Used for anything where Lumina needs an explicit user yes/no before
 * performing a side-effectful action: installing the Python venv,
 * overwriting wiki pages, deleting files, etc.
 */
export interface ConfirmationRequest {
  id: string;
  /** One-line headline shown in the banner's title row. Keep ≤ ~60 chars. */
  title: string;
  /**
   * Supporting body text. Plain text only — the renderer will render it
   * as-is inside a <p>, no markdown parsing. Multi-line allowed.
   */
  description?: string;
  /** Button label for the confirm action. Defaults to "Continue" on the renderer. */
  confirmLabel?: string;
  /** Button label for the cancel action. Defaults to "Cancel" on the renderer. */
  cancelLabel?: string;
  /** Visual tone; defaults to "default". Use "danger" for destructive actions. */
  tone?: ConfirmationTone;
}

/** Content of the .lumina-vault marker file. */
export interface VaultMarker {
  createdAt: string; // ISO 8601
}

/** A vault entry stored in the recent-vaults history. */
export interface VaultEntry {
  path: string;
  name: string; // basename of path
}

/** Bookmarks persisted at `{vault}/.lumina/bookmarks.json`. */
export interface BookmarksFile {
  version: number;
  filenames: string[];
}

/** Configuration for an LLM provider endpoint. */
export interface LLMProviderConfig {
  endpointUrl: string;
  model: string;
  // API key stored separately in OS keychain, referenced by provider ID
}

/** Configuration for the Phoenix observability backend. */
export interface PhoenixConfig {
  enabled: boolean;
  scheme: "http" | "https";
  host: string;
  port: number;
}

/** Application-level configuration persisted via electron-store. */
export interface AppConfig {
  vaultPath: string;
  llmProvider: LLMProviderConfig | null;
  phoenix: PhoenixConfig;
  /** When true, PDFs are rasterized to page PNGs for chat attach and ingest_source vision mode. Default off: PDFs use markitdown text only. */
  pdfImageIngest: boolean;
  /** When true, PDF/image/PPTX files are uploaded via OpenAI Files API and referenced by file_id. Only works with OpenAI-compatible endpoints. */
  fileIngest: boolean;
  theme: "light" | "dark" | "system";
  chatHistorySidebarOpen: boolean;
  lastChatSessionId: string;
}

/** Parameters for LLM content assistance actions. */
export interface LLMAssistParams {
  text: string;
  action: "summarize" | "expand" | "refine";
}

/** Event emitted by the vault file watcher. */
export interface VaultChangeEvent {
  type: "add" | "change" | "unlink";
  filename: string;
}

/** A tagged chunk yielded during LLM streaming. */
export type ChatChunk =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'narration'; content: string }
  | { type: 'tool_call'; id: string; name: string; args: string }
  | { type: 'tool_result'; id: string; output: string };

/** A chunk carrying one trace entry (narration / tool_call / tool_result). */
export type ChatTraceChunk =
  | { type: 'narration'; content: string }
  | { type: 'tool_call'; id: string; name: string; args: string }
  | { type: 'tool_result'; id: string; output: string };

/** OpenAI-compatible multimodal content block used in chat requests. */
export type ChatContentBlock =
  | { type: "text"; text: string }
  | {
      type: "file";
      file: {
        file_id: string;
        filename?: string;
        format?: string;
      };
    }
  | {
      type: "image_url";
      image_url: {
        url: string;
        detail?: "low" | "medium" | "high" | "ultra_high" | "auto";
      };
    };

/** One-shot slash-command metadata attached to the current send action. */
export type ChatSendCommand =
  | {
      type: "ingest";
      filename: string;
      prompt: string;
    }
  | {
      // `/lint` lints the entire wiki using the live CLAUDE.md as its
      // source of conventions. It does NOT target a single file (we used
      // to thread `filename` through here for the old "lint this note"
      // UX). The optional `prompt` is whatever free-form text the user
      // typed after `/lint` — e.g. "focus on the entities pages" — which
      // ChatView surfaces verbatim as "additional instruction" appended
      // to the lint workflow prompt. Empty / missing means "do the
      // default whole-wiki lint pass".
      type: "lint";
      prompt?: string;
    };

/**
 * Request payload for ingesting a vault file into chat content blocks.
 *
 * @deprecated Superseded by the model-callable `ingest_source` tool
 * (see src/main/services/ingest-tool.ts). The renderer no longer calls
 * `window.api.ingestFile`; the model drives extraction itself via tool
 * calls following the protocol in assets/templates/INGEST.md. Kept so
 * the existing main-process IngestService remains type-safe.
 */
export interface IngestRequest {
  filename: string;
}

/** @deprecated Used only by the deprecated `ingestFile` IPC. */
export type IngestKind = "text" | "pdf" | "pptx" | "image";

/**
 * Normalized ingest output consumed by the renderer and chat pipeline.
 *
 * @deprecated Used only by the deprecated `ingestFile` IPC. The
 * `ingest_source` tool returns its output as a structured string instead.
 */
export interface IngestResult {
  sourceFilename: string;
  kind: IngestKind;
  blocks: ChatContentBlock[];
  summary: string;
  chunkCount: number;
}

/** A single message in a chat conversation. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string; // ISO 8601
}

/** A complete chat session. */
export interface ChatSession {
  id: string;
  systemPrompt: string;
  messages: ChatMessage[];
  createdAt: string; // ISO 8601
}

/** A chat history list entry (no messages). */
export interface ChatHistoryEntry {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** Typed IPC bridge API exposed to the renderer via contextBridge. */
export interface WikiAPI {
  // Article CRUD
  listArticles(): Promise<ArticleMeta[]>;
  getArticle(filename: string): Promise<ArticleFile>;
  saveArticle(article: ArticleFile, targetFolder?: string): Promise<void>;
  /**
   * Write a literal file to the vault, bypassing article frontmatter
   * serialization. Use for creating files that should be 0-byte or contain
   * exactly the content provided (e.g. an empty CLAUDE.md slot).
   */
  writeRawFile(filename: string, content: string): Promise<void>;
  deleteArticle(title: string): Promise<void>;
  articleExists(title: string, targetFolder?: string): Promise<boolean>;
  createFolder(relativePath: string): Promise<void>;
  /** Paths like `wiki/inbox` that exist on disk but contain no indexed files. */
  listEmptyWikiRawFolders(): Promise<string[]>;
  /** Move a vault file or folder into another folder (vault-relative paths). */
  moveVaultEntry(from: string, toDir: string): Promise<void>;
  /** Copy or move OS paths into a vault folder (`toDir` vault-relative). */
  importExternalPaths(absolutePaths: string[], toDir: string): Promise<void>;
  /** Absolute filesystem path for a dropped or picked `File` (Electron `webUtils.getPathForFile`). */
  getPathForFile(file: File): string;
  getAbsolutePath(filename: string): Promise<string>;
  readFile(filename: string): Promise<string>;
  revealInFinder(filename: string): Promise<void>;

  // Search
  search(query: string): Promise<SearchResult[]>;
  searchByTag(tag: string): Promise<ArticleMeta[]>;

  // Link resolution
  getBacklinks(title: string): Promise<{ title: string; filename: string }[]>;
  resolveWikilink(target: string): Promise<{ exists: boolean; title: string; filename?: string }>;

  // LLM
  generateArticle(prompt: string): Promise<AsyncIterable<string>>;
  assistContent(params: LLMAssistParams): Promise<string>;
  isLLMAvailable(): Promise<boolean>;

  // Config
  getConfig(): Promise<AppConfig>;
  saveConfig(config: Partial<AppConfig>): Promise<void>;
  getApiKey(): Promise<string>;
  saveApiKey(key: string): Promise<void>;
  testLLMConnection(config: LLMProviderConfig): Promise<boolean>;
  selectVaultFolder(): Promise<string | null>;

  // Vault history & switching
  getVaultHistory(): Promise<VaultEntry[]>;
  switchVault(vaultPath: string): Promise<void>;
  removeVaultFromHistory(vaultPath: string): Promise<void>;
  onVaultSwitched(callback: (vaultPath: string) => void): void;
  removeVaultSwitchedListener(): void;

  // Bookmarks (vault JSON)
  getBookmarks(): Promise<string[]>;
  setBookmarks(filenames: string[]): Promise<void>;

  // Vault file watcher
  onVaultChange(callback: (event: VaultChangeEvent) => void): void;
  removeVaultChangeListener(): void;

  // Chat
  startChatSession(): Promise<ChatSession>;
  sendChatMessage(
    content: string,
    blocks?: ChatContentBlock[],
    options?: { reloadClaudeMd?: boolean },
  ): Promise<void>; // streaming via events
  stopChatGeneration(): Promise<void>;
  getChatSession(): Promise<ChatSession | null>;
  onChatChunk(callback: (chunk: string) => void): void;
  onChatThinkingChunk(callback: (chunk: string) => void): void;
  onChatTraceChunk(callback: (chunk: ChatTraceChunk) => void): void;
  onChatEnd(callback: (error?: string) => void): void;
  onChatWarning(callback: (message: string) => void): void;
  removeChatListeners(): void;

  // Chat history
  listChatSessions(): Promise<ChatHistoryEntry[]>;
  getChatHistory(sessionId: string): Promise<(ChatSession & { title: string }) | null>;
  loadChatSession(sessionId: string): Promise<ChatSession | null>;
  saveChatSession(session: ChatSession, title?: string): Promise<void>;
  deleteChatSession(sessionId: string): Promise<void>;

  // Ingest
  ingestFile(request: IngestRequest): Promise<IngestResult>;
  renameChatSession(sessionId: string, newTitle: string): Promise<void>;

  /**
   * Subscribe to generic confirmation prompts from the main process.
   * Used for any action that needs an explicit user yes/no: the Python
   * venv install gate, the `request_user_confirmation` chat tool, future
   * destructive operations. Reply with `replyConfirm(id, approved)` —
   * the awaiting caller proceeds only when `approved === true`.
   */
  onConfirmRequest(callback: (request: ConfirmationRequest) => void): void;
  removeConfirmRequestListener(): void;
  replyConfirm(id: string, approved: boolean): Promise<void>;

  /**
   * Dev-only: open a confirmation banner with arbitrary contents so you
   * can iterate on the UI without driving a real ingest / tool call.
   * Resolves to the user's choice (or rejects in a packaged build, where
   * the main-process handler isn't registered). Safe to call from the
   * DevTools console as `window.api.__debugTriggerConfirmation(...)`.
   */
  __debugTriggerConfirmation(opts?: {
    title?: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: ConfirmationTone;
  }): Promise<boolean>;

  // Lifecycle
  onUnsavedChanges(callback: (hasChanges: boolean) => void): void;
  notifyUnsavedChanges(isDirty: boolean): void;
  confirmClose(): Promise<boolean>;

  // Debug log
  getDebugLogBacklog(): Promise<DebugLogEntry[]>;
  onDebugLog(callback: (entry: DebugLogEntry) => void): void;
  removeDebugLogListeners(): void;
  notifyDebug(tag: string, message: string, data?: unknown): void;
}

/** Severity / category tag for a debug log entry. */
export type DebugLogLevel = "info" | "warn" | "error" | "debug" | "stream";

/** A single line of structured debug output emitted by the main process. */
export interface DebugLogEntry {
  ts: number;
  level: DebugLogLevel;
  tag: string;
  message: string;
  data?: unknown;
}

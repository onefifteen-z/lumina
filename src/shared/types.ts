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

/** Content of the .lumina-vault marker file. */
export interface VaultMarker {
  createdAt: string; // ISO 8601
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

/** Application-level configuration persisted via electron-store. */
export interface AppConfig {
  vaultPath: string;
  llmProvider: LLMProviderConfig | null;
  theme: "light" | "dark" | "system";
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

/** Typed IPC bridge API exposed to the renderer via contextBridge. */
export interface WikiAPI {
  // Article CRUD
  listArticles(): Promise<ArticleMeta[]>;
  getArticle(filename: string): Promise<ArticleFile>;
  saveArticle(article: ArticleFile): Promise<void>;
  deleteArticle(title: string): Promise<void>;
  articleExists(title: string): Promise<boolean>;

  // Search
  search(query: string): Promise<SearchResult[]>;
  searchByTag(tag: string): Promise<ArticleMeta[]>;

  // Link resolution
  getBacklinks(title: string): Promise<{ title: string; filename: string }[]>;
  resolveWikilink(target: string): Promise<{ exists: boolean; title: string }>;

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

  // Bookmarks (vault JSON)
  getBookmarks(): Promise<string[]>;
  setBookmarks(filenames: string[]): Promise<void>;

  // Vault file watcher
  onVaultChange(callback: (event: VaultChangeEvent) => void): void;
  removeVaultChangeListener(): void;

  // Chat
  startChatSession(): Promise<ChatSession>;
  sendChatMessage(content: string): Promise<void>; // streaming via events
  stopChatGeneration(): Promise<void>;
  getChatSession(): Promise<ChatSession | null>;
  onChatChunk(callback: (chunk: string) => void): void;
  onChatEnd(callback: (error?: string) => void): void;
  onChatWarning(callback: (message: string) => void): void;
  removeChatListeners(): void;

  // Lifecycle
  onUnsavedChanges(callback: (hasChanges: boolean) => void): void;
  notifyUnsavedChanges(isDirty: boolean): void;
  confirmClose(): Promise<boolean>;

}

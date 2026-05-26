/** YAML frontmatter metadata stored at the top of each Markdown article file. */
export interface FrontmatterData {
    title: string;
    tags: string[];
    created: string;
    modified: string;
    [key: string]: unknown;
}
/** In-memory representation of a wiki article, mapping directly to a Markdown file on disk. */
export interface ArticleFile {
    frontmatter: FrontmatterData;
    content: string;
    rawContent: string;
}
/** Lightweight article metadata used for lists, search indexing, and link resolution. */
export interface ArticleMeta {
    title: string;
    filename: string;
    tags: string[];
    created: string;
    modified: string;
    wikilinks: string[];
    excerpt: string;
    /**
     * Raw-source references declared in the article's `sources` frontmatter
     * field. Populated only for wiki .md files that declare them. Powers
     * the file-tree "Ingested" badge on raw/ files.
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
    snippet: string;
}
/** A parsed wikilink reference extracted from Markdown content. */
export interface WikilinkRef {
    target: string;
    alias?: string;
    position: {
        start: number;
        end: number;
    };
}
/** A parsed embed reference extracted from Markdown content. */
export interface EmbedRef {
    target: string;
    position: {
        start: number;
        end: number;
    };
}
/** Configuration for an LLM provider endpoint. */
export interface LLMProviderConfig {
    endpointUrl: string;
    model: string;
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
/** Bookmarks persisted at `{vault}/.lumina/bookmarks.json`. */
export interface BookmarksFile {
    version: number;
    filenames: string[];
}
/** Typed IPC bridge API exposed to the renderer via contextBridge. */
export interface WikiAPI {
    listArticles(): Promise<ArticleMeta[]>;
    listEmptyWikiRawFolders(): Promise<string[]>;
    getArticle(title: string): Promise<ArticleFile>;
    saveArticle(article: ArticleFile, targetFolder?: string): Promise<void>;
    deleteArticle(title: string): Promise<void>;
    articleExists(title: string, targetFolder?: string): Promise<boolean>;
    search(query: string): Promise<SearchResult[]>;
    searchByTag(tag: string): Promise<ArticleMeta[]>;
    getBacklinks(title: string): Promise<string[]>;
    resolveWikilink(target: string): Promise<{
        exists: boolean;
        title: string;
    }>;
    generateArticle(prompt: string): Promise<AsyncIterable<string>>;
    assistContent(params: LLMAssistParams): Promise<string>;
    isLLMAvailable(): Promise<boolean>;
    getConfig(): Promise<AppConfig>;
    saveConfig(config: Partial<AppConfig>): Promise<void>;
    getApiKey(): Promise<string>;
    saveApiKey(key: string): Promise<void>;
    testLLMConnection(config: LLMProviderConfig): Promise<boolean>;
    selectVaultFolder(): Promise<string | null>;
    getBookmarks(): Promise<string[]>;
    setBookmarks(filenames: string[]): Promise<void>;
    onVaultChange(callback: (event: VaultChangeEvent) => void): void;
    removeVaultChangeListener(): void;
    onUnsavedChanges(callback: (hasChanges: boolean) => void): void;
    notifyUnsavedChanges(isDirty: boolean): void;
    confirmClose(): Promise<boolean>;
}

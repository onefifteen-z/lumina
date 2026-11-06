import * as fs from "fs/promises";
import * as path from "path";
import type { ArticleMeta, QmdSearchStatus } from "../shared/types";
import { parseArticleFile } from "../shared/markdown-parser";
import { CLAUDE_MD_CANDIDATES, INGEST_MD_CANDIDATES } from "../shared/vault-prompt-files";
import { runIngestTool, type IngestMode } from "../main/services/ingest-tool";
import type { WikiSearchHit } from "../main/services/qmd-search-service";
import {
  WIKI_DIR,
  WikiPathError,
  appendWikiLog,
  normalizeWikiPagePath,
  writeWikiPage,
  type WikiLogEntry,
  type WriteWikiPageResult,
} from "./wiki-write";

export type McpCapabilities = {
  /** Registers write_wiki_page / append_wiki_log. */
  allowWrite: boolean;
  /** Registers ingest_with_lumina (requires backend.ingestWithLumina). */
  allowLuminaIngest: boolean;
};

export type IngestWithLuminaProgress = { step: number; message: string };

export type IngestWithLuminaResult = {
  reply: string;
  changedFiles: string[];
  toolCalls: number;
};

export type ArticleSummary = {
  title: string;
  filename: string;
  tags: string[];
  modified: string;
  excerpt: string;
};

export type LuminaStatus = {
  vaultPath: string;
  articleCount: number;
  search: "qmd" | "flexsearch";
  qmd: Pick<QmdSearchStatus, "enabled" | "ready" | "totalDocuments" | "needsEmbedding" | "error"> | null;
  capabilities: McpCapabilities & { luminaIngestAvailable: boolean };
};

export type IngestSourceResult = {
  text: string;
  images: { mimeType: string; data: string }[];
};

/** Everything the MCP layer needs from a vault, independent of transport. */
export interface LuminaBackend {
  search(query: string, limit: number): Promise<WikiSearchHit[]>;
  getArticle(filename: string): Promise<{ filename: string; frontmatter: Record<string, unknown>; body: string }>;
  listArticles(opts: { prefix?: string; tag?: string; limit: number }): Promise<{ total: number; articles: ArticleSummary[] }>;
  getBacklinks(title: string): Promise<{ title: string; filename: string }[]>;
  ingestSource(sourcePath: string, mode?: IngestMode): Promise<IngestSourceResult>;
  writePage(pagePath: string, content: string, overwrite: boolean): Promise<WriteWikiPageResult>;
  appendLog(entry: WikiLogEntry): Promise<{ path: string }>;
  status(caps: McpCapabilities): Promise<LuminaStatus>;
  answerPrompt(question: string): Promise<string>;
  ingestPrompt(sourcePath: string): Promise<string>;
  ingestWithLumina?: (
    sourcePath: string,
    note: string | undefined,
    onProgress: (p: IngestWithLuminaProgress) => void,
  ) => Promise<IngestWithLuminaResult>;
}

export type VaultBackendDeps = {
  getVaultPath(): string | null;
  /** Cached vault scan (all files); the backend filters to wiki/ markdown. */
  listAllArticles(): Promise<ArticleMeta[]>;
  search(query: string): Promise<WikiSearchHit[]>;
  searchEngine(): "qmd" | "flexsearch";
  qmdStatus(): Promise<QmdSearchStatus | null>;
  loadBundledTemplate(name: "CLAUDE.md" | "INGEST.md"): Promise<string | null>;
  pdfImageIngest?: () => boolean;
  ingestWithLumina?: LuminaBackend["ingestWithLumina"];
};

function requireVault(deps: VaultBackendDeps): string {
  const vault = deps.getVaultPath();
  if (!vault) throw new Error("No Lumina vault is open.");
  return vault;
}

function isWikiMarkdown(filename: string): boolean {
  return filename.startsWith(`${WIKI_DIR}/`) && filename.toLowerCase().endsWith(".md");
}

async function readFirstNonEmpty(vault: string, candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(path.join(vault, candidate), "utf-8");
      if (content.trim()) return content;
    } catch {
      // try next
    }
  }
  return null;
}

const MCP_TOOL_MAPPING = [
  "## Tools available over MCP (these replace the in-app tools mentioned below)",
  "- `search_wiki(query, limit?)` instead of `search_wiki` / `grep` over wiki/.",
  "- `get_article(filename)` to read a wiki page instead of `cat`.",
  "- `list_articles(prefix?, tag?)` instead of `ls wiki/...`.",
  "- `get_backlinks(title)` to find pages linking to a title.",
  "- `ingest_source(path, mode?)` to extract a raw/ source (same as in-app).",
  "- `write_wiki_page(path, content, overwrite?)` instead of `shell` heredocs; paths must be under wiki/.",
  "- `append_wiki_log(operation, title, details?)` instead of appending to wiki/log.md with `shell`.",
  "- Every tool accepts `vault` (name or path from `list_vaults`); keep passing the same vault for one task.",
  "- There is no `shell` and no `request_user_confirmation` over MCP. raw/ is read-only.",
].join("\n");

export function createVaultBackend(deps: VaultBackendDeps): LuminaBackend {
  const wikiArticles = async () =>
    (await deps.listAllArticles()).filter((a) => isWikiMarkdown(a.filename));

  const loadManual = async (vault: string) => {
    const claude =
      (await readFirstNonEmpty(vault, CLAUDE_MD_CANDIDATES)) ??
      (await deps.loadBundledTemplate("CLAUDE.md")) ??
      "";
    const ingest =
      (await readFirstNonEmpty(vault, INGEST_MD_CANDIDATES)) ??
      (await deps.loadBundledTemplate("INGEST.md")) ??
      "";
    return { claude, ingest };
  };

  return {
    async search(query, limit) {
      const q = query.trim();
      if (!q) return [];
      // The FlexSearch fallback indexes the whole vault; MCP readers only get wiki/ pages.
      const hits = (await deps.search(q)).filter((h) => isWikiMarkdown(h.filename)).slice(0, limit);
      // QMD reports the matched chunk's heading as the title; prefer the page title.
      const titles = new Map((await deps.listAllArticles()).map((a) => [a.filename, a.title]));
      return hits.map((h) => ({ ...h, title: titles.get(h.filename) ?? h.title }));
    },

    async getArticle(filename) {
      const vault = requireVault(deps);
      const rel = normalizeWikiPagePath(filename);
      let raw: string;
      try {
        raw = await fs.readFile(path.join(vault, rel), "utf-8");
      } catch {
        throw new WikiPathError(`${rel} not found`);
      }
      const parsed = parseArticleFile(raw);
      return { filename: rel, frontmatter: parsed.frontmatter as Record<string, unknown>, body: parsed.content };
    },

    async listArticles({ prefix, tag, limit }) {
      let articles = await wikiArticles();
      if (prefix) {
        const p = prefix.replace(/\\/g, "/").replace(/^\/+/, "");
        const full = p.startsWith(`${WIKI_DIR}/`) || p === WIKI_DIR ? p : `${WIKI_DIR}/${p}`;
        articles = articles.filter((a) => a.filename.startsWith(full));
      }
      if (tag) {
        const t = tag.replace(/^#/, "").toLowerCase();
        articles = articles.filter((a) => a.tags.some((x) => x.toLowerCase() === t));
      }
      articles.sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
      return {
        total: articles.length,
        articles: articles.slice(0, limit).map((a) => ({
          title: a.title,
          filename: a.filename,
          tags: a.tags,
          modified: a.modified,
          excerpt: a.excerpt,
        })),
      };
    },

    async getBacklinks(title) {
      const target = title.trim().toLowerCase();
      return (await wikiArticles())
        .filter((a) => a.wikilinks.some((l) => l.toLowerCase() === target))
        .map((a) => ({ title: a.title, filename: a.filename }));
    },

    async ingestSource(sourcePath, mode) {
      const vault = requireVault(deps);
      const result = await runIngestTool(
        { path: sourcePath, mode },
        { vaultRoot: vault, pdfImageIngest: deps.pdfImageIngest?.() ?? false, fileIngest: false },
      );
      const images: IngestSourceResult["images"] = [];
      for (const block of result.contentBlocks ?? []) {
        if (block.type !== "image_url") continue;
        const url = (block.image_url as { url?: string }).url;
        const m = url?.match(/^data:([^;]+);base64,(.*)$/s);
        if (m) images.push({ mimeType: m[1], data: m[2] });
      }
      return { text: result.output, images };
    },

    writePage(pagePath, content, overwrite) {
      return writeWikiPage(requireVault(deps), pagePath, content, overwrite);
    },

    appendLog(entry) {
      return appendWikiLog(requireVault(deps), entry);
    },

    async status(caps) {
      const vault = requireVault(deps);
      const qmd = await deps.qmdStatus();
      return {
        vaultPath: vault,
        articleCount: (await wikiArticles()).length,
        search: deps.searchEngine(),
        qmd: qmd
          ? {
              enabled: qmd.enabled,
              ready: qmd.ready,
              totalDocuments: qmd.totalDocuments,
              needsEmbedding: qmd.needsEmbedding,
              error: qmd.error,
            }
          : null,
        capabilities: { ...caps, luminaIngestAvailable: Boolean(deps.ingestWithLumina) },
      };
    },

    async answerPrompt(question) {
      const vault = requireVault(deps);
      const { claude } = await loadManual(vault);
      return [
        "You are answering a question from a personal wiki managed by Lumina.",
        "Answer only from the wiki. Workflow:",
        "1. Call `search_wiki` with 2-4 focused queries derived from the question.",
        "2. Call `get_article` on the most relevant pages (and `get_backlinks` when helpful).",
        "3. Answer concisely, citing every claim with the page filename, e.g. (wiki/concepts/foo.md).",
        "4. If the wiki does not cover the question, say so instead of guessing.",
        "",
        MCP_TOOL_MAPPING,
        "",
        "## The vault's operating manual (CLAUDE.md)",
        claude,
        "",
        "## Question",
        question,
      ].join("\n");
    },

    async ingestPrompt(sourcePath) {
      const vault = requireVault(deps);
      const { claude, ingest } = await loadManual(vault);
      return [
        `Ingest the source \`${sourcePath}\` into this Lumina wiki.`,
        "Follow the vault's ingest workflow below exactly, using the MCP tools in place of shell.",
        "Start with `ingest_source`, read related pages with `search_wiki`/`get_article`, write pages with `write_wiki_page`, update wiki/index.md, and finish with `append_wiki_log`.",
        "",
        MCP_TOOL_MAPPING,
        "",
        "## The vault's operating manual (CLAUDE.md)",
        claude,
        "",
        "## Ingest protocol (INGEST.md)",
        ingest,
      ].join("\n");
    },

    ingestWithLumina: deps.ingestWithLumina,
  };
}

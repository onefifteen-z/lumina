import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { LuminaBackend, McpCapabilities } from "./backend";
import type { VaultInfo, VaultRegistry } from "./vault-registry";

export const LUMINA_MCP_SERVER_NAME = "lumina";
/** Max length of the free-text note forwarded to Lumina's own agent. */
export const INGEST_NOTE_MAX_CHARS = 500;

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toolError(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return toolError(err);
  }
}

const VAULT_ARG = z
  .string()
  .optional()
  .describe("Vault name or path from list_vaults; omit for the default vault.");

function isRawSourcePath(p: string): boolean {
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
  return norm.startsWith("raw/") && !norm.split("/").includes("..");
}

function vaultHint(info: VaultInfo): string {
  return `\n\n## Vault\nThis is the vault "${info.name}" (${info.path}). Pass \`vault: ${JSON.stringify(info.path)}\` to every Lumina tool call.`;
}

export function createLuminaMcpServer(
  registry: VaultRegistry,
  caps: McpCapabilities,
  version = "0.0.0",
): McpServer {
  const withVault = (vault: string | undefined, fn: (backend: LuminaBackend, info: VaultInfo) => Promise<CallToolResult>) =>
    guarded(async () => {
      const { backend, info } = await registry.resolve(vault);
      return fn(backend, info);
    });

  const server = new McpServer(
    { name: LUMINA_MCP_SERVER_NAME, version },
    {
      instructions:
        "Lumina is a personal LLM-maintained wiki. Use search_wiki then get_article to answer from it and cite wiki/ filenames. Several vaults may be available: call list_vaults and pass `vault` to target one (default: the open vault). The answer_from_wiki and ingest prompts contain the vault's own conventions.",
    },
  );

  // ── Read tools ───────────────────────────────────────────────

  server.registerTool(
    "list_vaults",
    {
      title: "List vaults",
      description:
        "List the Lumina vaults this server can access: [{name, path, default, initialized}]. Pass a name or path as `vault` to other tools.",
      annotations: { readOnlyHint: true },
    },
    () => guarded(async () => json(await registry.list())),
  );

  server.registerTool(
    "search_wiki",
    {
      title: "Search wiki",
      description:
        "Search the Lumina wiki (QMD hybrid search when enabled, otherwise keyword). Returns [{title, filename, excerpt}]. Use focused queries.",
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).optional(),
        vault: VAULT_ARG,
      }),
      annotations: { readOnlyHint: true },
    },
    ({ query, limit, vault }) => withVault(vault, async (b) => json(await b.search(query, limit ?? 8))),
  );

  server.registerTool(
    "get_article",
    {
      title: "Read wiki page",
      description: "Read one wiki page by vault-relative filename (e.g. wiki/concepts/foo.md). Returns frontmatter and markdown body.",
      inputSchema: z.object({ filename: z.string().min(1), vault: VAULT_ARG }),
      annotations: { readOnlyHint: true },
    },
    ({ filename, vault }) => withVault(vault, async (b) => json(await b.getArticle(filename))),
  );

  server.registerTool(
    "list_articles",
    {
      title: "List wiki pages",
      description: "List wiki pages, newest first. Filter by folder prefix (e.g. wiki/entities) and/or tag.",
      inputSchema: z.object({
        prefix: z.string().optional(),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        vault: VAULT_ARG,
      }),
      annotations: { readOnlyHint: true },
    },
    ({ prefix, tag, limit, vault }) =>
      withVault(vault, async (b) => json(await b.listArticles({ prefix, tag, limit: limit ?? 50 }))),
  );

  server.registerTool(
    "get_backlinks",
    {
      title: "Get backlinks",
      description: "List wiki pages that link to the given page title via [[wikilinks]].",
      inputSchema: z.object({ title: z.string().min(1), vault: VAULT_ARG }),
      annotations: { readOnlyHint: true },
    },
    ({ title, vault }) => withVault(vault, async (b) => json(await b.getBacklinks(title))),
  );

  server.registerTool(
    "ingest_source",
    {
      title: "Extract a source file",
      description:
        "Extract the content of a vault file (usually under raw/) as text/markdown: text files, images, PDF and Office docs. Read-only. Use mode=vision for scanned PDFs.",
      inputSchema: z.object({
        path: z.string().min(1),
        mode: z.enum(["auto", "text", "vision"]).optional(),
        vault: VAULT_ARG,
      }),
      annotations: { readOnlyHint: true },
    },
    ({ path, mode, vault }) =>
      withVault(vault, async (b) => {
        const result = await b.ingestSource(path, mode);
        return {
          content: [
            { type: "text", text: result.text },
            ...result.images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
          ],
        };
      }),
  );

  server.registerTool(
    "lumina_status",
    {
      title: "Lumina status",
      description: "Vault path, wiki page count, search engine/QMD state, and which write capabilities are enabled.",
      inputSchema: z.object({ vault: VAULT_ARG }),
      annotations: { readOnlyHint: true },
    },
    ({ vault }) => withVault(vault, async (b) => json(await b.status(caps))),
  );

  // ── Write tools (caller's model performs the ingest) ─────────

  if (caps.allowWrite) {
    server.registerTool(
      "write_wiki_page",
      {
        title: "Write wiki page",
        description:
          "Create or replace a markdown page under wiki/ (e.g. wiki/sources/foo.md). Fails if the page exists unless overwrite is true. raw/ is read-only.",
        inputSchema: z.object({
          path: z.string().min(1),
          content: z.string(),
          overwrite: z.boolean().optional(),
          vault: VAULT_ARG,
        }),
        annotations: { destructiveHint: true, idempotentHint: true },
      },
      ({ path, content, overwrite, vault }) =>
        withVault(vault, async (b) => json(await b.writePage(path, content, overwrite ?? false))),
    );

    server.registerTool(
      "append_wiki_log",
      {
        title: "Append to wiki log",
        description: "Append an entry to wiki/log.md as `## [YYYY-MM-DD] operation | title` followed by optional details.",
        inputSchema: z.object({
          operation: z.string().optional(),
          title: z.string().min(1),
          details: z.string().optional(),
          vault: VAULT_ARG,
        }),
      },
      ({ operation, title, details, vault }) =>
        withVault(vault, async (b) => json(await b.appendLog({ operation, title, details }))),
    );
  }

  // ── Lumina's own model performs the ingest (App only) ────────

  if (caps.allowLuminaIngest && registry.supportsLuminaIngest) {
    server.registerTool(
      "ingest_with_lumina",
      {
        title: "Ingest with Lumina",
        description:
          "Have Lumina's own configured model ingest a raw/ source end-to-end (summary page, entity/concept pages, index and log), exactly like ingesting in the app. Can take several minutes. Returns the agent's reply and changed files.",
        inputSchema: z.object({
          path: z.string().min(1),
          note: z.string().max(INGEST_NOTE_MAX_CHARS).optional(),
          vault: VAULT_ARG,
        }),
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      ({ path, note, vault }, ctx) =>
        withVault(vault, async (b) => {
          if (!isRawSourcePath(path)) throw new Error("path must be a file under raw/");
          if (!b.ingestWithLumina) throw new Error("ingest_with_lumina is not available for this vault");
          const progressToken = ctx.mcpReq._meta?.progressToken;
          const result = await b.ingestWithLumina(path, note, ({ step, message }) => {
            if (progressToken === undefined) return;
            void ctx.mcpReq
              .notify({
                method: "notifications/progress",
                params: { progressToken, progress: step, message },
              })
              .catch(() => {});
          });
          return json(result);
        }),
    );
  }

  // ── Prompts (the caller's model writes the answer / pages) ───

  server.registerPrompt(
    "answer_from_wiki",
    {
      title: "Answer from wiki",
      description: "Instructions for answering a question from this wiki with citations, using the Lumina tools.",
      argsSchema: z.object({ question: z.string().min(1), vault: VAULT_ARG }),
    },
    async ({ question, vault }) => {
      const { backend, info } = await registry.resolve(vault);
      const text = (await backend.answerPrompt(question)) + vaultHint(info);
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    },
  );

  server.registerPrompt(
    "ingest",
    {
      title: "Ingest a source",
      description:
        "The vault's ingest protocol (CLAUDE.md + INGEST.md) mapped to MCP tools, for ingesting a raw/ source with your own model. Requires write tools to be enabled.",
      argsSchema: z.object({ path: z.string().min(1), vault: VAULT_ARG }),
    },
    async ({ path, vault }) => {
      const { backend, info } = await registry.resolve(vault);
      const text = (await backend.ingestPrompt(path)) + vaultHint(info);
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    },
  );

  return server;
}

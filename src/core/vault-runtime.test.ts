import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("electron", () => {
  throw new Error("the MCP CLI module graph must not import electron");
});

import { VaultRuntime } from "./vault-runtime";
import { createVaultBackend } from "../mcp/backend";
import { createLuminaMcpServer } from "../mcp/server-factory";
import { DEFAULT_QMD_SEARCH_CONFIG } from "../shared/types";
import { singleVault } from "../mcp/test-utils";

let vault: string;
let runtime: VaultRuntime | null = null;

function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), content);
}

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-runtime-"));
  write("wiki/concepts/agent-eval.md", "---\ntitle: Agent Eval\ntags: [agents]\n---\nEvaluating agents with [[Benchmarks]].\n");
  write("wiki/benchmarks.md", "---\ntitle: Benchmarks\n---\nBenchmark suites.\n");
  write("raw/notes.md", "Raw notes about agents.\n");
  write("CLAUDE.md", "# Vault manual\nBe precise.\n");
});

afterEach(async () => {
  await runtime?.close();
  runtime = null;
  fs.rmSync(vault, { recursive: true, force: true });
});

async function openBackend() {
  runtime = await VaultRuntime.open({ vaultPath: vault, qmdSearch: DEFAULT_QMD_SEARCH_CONFIG, userDataDir: null });
  return createVaultBackend(runtime.backendDeps());
}

describe("VaultRuntime + vault backend", () => {
  it("loads without electron and builds an MCP server", async () => {
    const backend = await openBackend();
    expect(createLuminaMcpServer(singleVault(backend), { allowWrite: false, allowLuminaIngest: false })).toBeTruthy();
  });

  it("lists only wiki/ markdown and filters by prefix and tag", async () => {
    const backend = await openBackend();
    const all = await backend.listArticles({ limit: 50 });
    expect(all.articles.map((a) => a.filename).sort()).toEqual(["wiki/benchmarks.md", "wiki/concepts/agent-eval.md"]);
    expect((await backend.listArticles({ prefix: "concepts", limit: 50 })).total).toBe(1);
    expect((await backend.listArticles({ tag: "#agents", limit: 50 })).articles[0].title).toBe("Agent Eval");
  });

  it("searches with FlexSearch when QMD is disabled", async () => {
    const backend = await openBackend();
    const hits = await backend.search("evaluating", 5);
    expect(hits.map((h) => h.filename)).toContain("wiki/concepts/agent-eval.md");
    expect(await backend.search("raw notes", 5)).toEqual([]);
  });

  it("reads articles and backlinks", async () => {
    const backend = await openBackend();
    const article = await backend.getArticle("concepts/agent-eval.md");
    expect(article.frontmatter.title).toBe("Agent Eval");
    expect((await backend.getBacklinks("Benchmarks")).map((a) => a.filename)).toEqual(["wiki/concepts/agent-eval.md"]);
    await expect(backend.getArticle("raw/notes.md")).rejects.toThrow(/read-only/);
  });

  it("builds prompts from the vault's CLAUDE.md", async () => {
    const backend = await openBackend();
    const prompt = await backend.answerPrompt("What is agent eval?");
    expect(prompt).toContain("Be precise.");
    expect(prompt).toContain("What is agent eval?");
  });

  it("picks up new pages after refresh", async () => {
    const backend = await openBackend();
    write("wiki/new-page.md", "---\ntitle: New Page\n---\nFresh.\n");
    await runtime!.refresh();
    expect((await backend.listArticles({ limit: 50 })).total).toBe(3);
  });
});

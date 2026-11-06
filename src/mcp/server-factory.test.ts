import { describe, it, expect, vi } from "vitest";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createLuminaMcpServer } from "./server-factory";
import type { LuminaBackend, McpCapabilities } from "./backend";
import { callRpc, INITIALIZE_PARAMS, singleVault, staticRegistry } from "./test-utils";

function fakeBackend(overrides: Partial<LuminaBackend> = {}): LuminaBackend {
  return {
    search: vi.fn().mockResolvedValue([{ title: "Agent", filename: "wiki/agent.md", excerpt: "about agents" }]),
    getArticle: vi.fn().mockResolvedValue({ filename: "wiki/agent.md", frontmatter: { title: "Agent" }, body: "# Agent" }),
    listArticles: vi.fn().mockResolvedValue({ total: 0, articles: [] }),
    getBacklinks: vi.fn().mockResolvedValue([]),
    ingestSource: vi.fn().mockResolvedValue({ text: "[ingest_source ok kind=text]\n\nhello", images: [] }),
    writePage: vi.fn().mockResolvedValue({ path: "wiki/a.md", created: true, bytes: 3 }),
    appendLog: vi.fn().mockResolvedValue({ path: "wiki/log.md" }),
    status: vi.fn().mockResolvedValue({ vaultPath: "/v" }),
    answerPrompt: vi.fn().mockResolvedValue("ANSWER PROMPT"),
    ingestPrompt: vi.fn().mockResolvedValue("INGEST PROMPT"),
    ...overrides,
  };
}

function handlerFor(backend: LuminaBackend, caps: McpCapabilities) {
  return createMcpHandler(() => createLuminaMcpServer(singleVault(backend), caps));
}

async function toolNames(backend: LuminaBackend, caps: McpCapabilities): Promise<string[]> {
  const handler = handlerFor(backend, caps);
  await callRpc(handler, "initialize", INITIALIZE_PARAMS);
  const res = await callRpc(handler, "tools/list");
  return ((res.result?.tools as { name: string }[]) ?? []).map((t) => t.name).sort();
}

const READ_TOOLS = ["get_article", "get_backlinks", "ingest_source", "list_articles", "list_vaults", "lumina_status", "search_wiki"];

describe("createLuminaMcpServer", () => {
  it("exposes only read tools by default", async () => {
    expect(await toolNames(fakeBackend(), { allowWrite: false, allowLuminaIngest: false })).toEqual(READ_TOOLS);
  });

  it("adds write tools when allowWrite is on", async () => {
    expect(await toolNames(fakeBackend(), { allowWrite: true, allowLuminaIngest: false })).toEqual(
      [...READ_TOOLS, "append_wiki_log", "write_wiki_page"].sort(),
    );
  });

  it("adds ingest_with_lumina only when enabled and the backend supports it", async () => {
    const caps = { allowWrite: false, allowLuminaIngest: true };
    expect(await toolNames(fakeBackend(), caps)).not.toContain("ingest_with_lumina");
    const withIngest = fakeBackend({
      ingestWithLumina: vi.fn().mockResolvedValue({ reply: "done", changedFiles: [], toolCalls: 0 }),
    });
    expect(await toolNames(withIngest, caps)).toContain("ingest_with_lumina");
  });

  it("calls search_wiki and returns compact JSON", async () => {
    const backend = fakeBackend();
    const handler = handlerFor(backend, { allowWrite: false, allowLuminaIngest: false });
    const res = await callRpc(handler, "tools/call", {
      name: "search_wiki",
      arguments: { query: "agents", limit: 3 },
    });
    expect(backend.search).toHaveBeenCalledWith("agents", 3);
    expect(JSON.parse(res.result!.content![0].text!)).toEqual([
      { title: "Agent", filename: "wiki/agent.md", excerpt: "about agents" },
    ]);
  });

  it("returns tool errors as isError results instead of throwing", async () => {
    const backend = fakeBackend({ getArticle: vi.fn().mockRejectedValue(new Error("wiki/x.md not found")) });
    const handler = handlerFor(backend, { allowWrite: false, allowLuminaIngest: false });
    const res = await callRpc(handler, "tools/call", { name: "get_article", arguments: { filename: "x.md" } });
    expect(res.result?.isError).toBe(true);
    expect(res.result!.content![0].text).toMatch(/not found/);
  });

  it("rejects ingest_with_lumina paths outside raw/", async () => {
    const ingestWithLumina = vi.fn();
    const handler = handlerFor(fakeBackend({ ingestWithLumina }), { allowWrite: false, allowLuminaIngest: true });
    const res = await callRpc(handler, "tools/call", {
      name: "ingest_with_lumina",
      arguments: { path: "wiki/../CLAUDE.md" },
    });
    expect(res.result?.isError).toBe(true);
    expect(ingestWithLumina).not.toHaveBeenCalled();
  });

  it("serves answer_from_wiki and ingest prompts", async () => {
    const handler = handlerFor(fakeBackend(), { allowWrite: true, allowLuminaIngest: false });
    const list = await callRpc(handler, "prompts/list");
    expect(((list.result?.prompts as { name: string }[]) ?? []).map((p) => p.name).sort()).toEqual([
      "answer_from_wiki",
      "ingest",
    ]);
    const prompt = await callRpc(handler, "prompts/get", {
      name: "answer_from_wiki",
      arguments: { question: "What is X?" },
    });
    const messages = prompt.result?.messages as { content: { text: string } }[];
    expect(messages[0].content.text).toMatch(/^ANSWER PROMPT\n\n## Vault\n.*"\/vaults\/main"/s);
  });

  describe("multiple vaults", () => {
    const work = fakeBackend();
    const personal = fakeBackend({ search: vi.fn().mockResolvedValue([{ title: "P", filename: "wiki/p.md", excerpt: "" }]) });
    const handler = createMcpHandler(() =>
      createLuminaMcpServer(
        staticRegistry([
          { name: "Work", path: "/vaults/work", backend: work },
          { name: "Personal", path: "/vaults/personal", backend: personal },
        ]),
        { allowWrite: true, allowLuminaIngest: false },
      ),
    );

    it("lists vaults", async () => {
      const res = await callRpc(handler, "tools/call", { name: "list_vaults", arguments: {} });
      expect(JSON.parse(res.result!.content![0].text!)).toEqual([
        { name: "Work", path: "/vaults/work", default: true, initialized: true },
        { name: "Personal", path: "/vaults/personal", default: false, initialized: true },
      ]);
    });

    it("routes calls by vault name or path and defaults to the first", async () => {
      await callRpc(handler, "tools/call", { name: "search_wiki", arguments: { query: "a", vault: "personal" } });
      expect(personal.search).toHaveBeenCalledWith("a", 8);
      await callRpc(handler, "tools/call", { name: "write_wiki_page", arguments: { path: "x.md", content: "x", vault: "/vaults/personal" } });
      expect(personal.writePage).toHaveBeenCalled();
      await callRpc(handler, "tools/call", { name: "search_wiki", arguments: { query: "b" } });
      expect(work.search).toHaveBeenCalledWith("b", 8);
    });

    it("returns an error result for unknown vaults", async () => {
      const res = await callRpc(handler, "tools/call", { name: "get_article", arguments: { filename: "a.md", vault: "nope" } });
      expect(res.result?.isError).toBe(true);
      expect(res.result!.content![0].text).toMatch(/list_vaults/);
    });
  });
});

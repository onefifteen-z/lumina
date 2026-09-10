import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { QmdSearchService } from "./qmd-search-service";

const mockStore = {
  update: vi.fn().mockResolvedValue({
    collections: 1,
    indexed: 1,
    updated: 0,
    unchanged: 0,
    removed: 0,
    skipped: 0,
    needsEmbedding: 0,
  }),
  embed: vi.fn().mockResolvedValue({ embedded: 0, skipped: 0 }),
  searchLex: vi.fn().mockResolvedValue([
    {
      filepath: "/vault/wiki/test.md",
      displayPath: "wiki/test.md",
      title: "Test Page",
      body: "Body about deployment",
      score: 0.9,
      source: "fts",
      context: null,
      hash: "abc",
      docid: "#abc123",
      collectionName: "vault",
      modifiedAt: "2026-01-01",
      bodyLength: 24,
    },
  ]),
  search: vi.fn().mockResolvedValue([
    {
      file: "qmd://vault/wiki/hybrid.md",
      displayPath: "wiki/hybrid.md",
      title: "Hybrid Page",
      body: "Full body",
      bestChunk: "Hybrid chunk about release",
      bestChunkPos: 0,
      score: 0.95,
      context: null,
      docid: "#hyb001",
    },
  ]),
  getStatus: vi.fn().mockResolvedValue({
    totalDocuments: 2,
    needsEmbedding: 0,
    hasVectorIndex: true,
    collections: [],
  }),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@tobilu/qmd", () => ({
  createStore: vi.fn().mockResolvedValue(mockStore),
}));

describe("QmdSearchService", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-qmd-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const svc = new QmdSearchService(tmpDir, { enabled: false });
    await svc.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("maps lex search results to wiki hits", async () => {
    const svc = new QmdSearchService(tmpDir, {
      enabled: true,
      mode: "lex",
      autoEmbed: false,
    });
    await svc.initialize();
    const hits = await svc.search("deployment");
    expect(hits).toEqual([
      {
        title: "Test Page",
        filename: "wiki/test.md",
        excerpt: "Body about deployment",
      },
    ]);
    expect(mockStore.searchLex).toHaveBeenCalledWith("deployment", { limit: 8 });
  });

  it("maps hybrid search results to wiki hits", async () => {
    const svc = new QmdSearchService(tmpDir, {
      enabled: true,
      mode: "hybrid",
      autoEmbed: false,
    });
    await svc.initialize();
    const hits = await svc.search("release pipeline");
    expect(hits[0]).toMatchObject({
      title: "Hybrid Page",
      filename: "wiki/hybrid.md",
      excerpt: "Hybrid chunk about release",
    });
    expect(mockStore.search).toHaveBeenCalled();
  });

  it("reports detailed status from the store", async () => {
    const svc = new QmdSearchService(tmpDir, {
      enabled: true,
      mode: "lex",
      autoEmbed: false,
    });
    await svc.initialize();
    const status = await svc.getDetailedStatus();
    expect(status.totalDocuments).toBe(2);
    expect(status.hasVectorIndex).toBe(true);
    expect(status.ready).toBe(true);
  });
});

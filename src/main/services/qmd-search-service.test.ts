import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { mockStore, createStore } = vi.hoisted(() => {
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
      filepath: "qmd://vault/test.md",
      displayPath: "vault/test.md",
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
      file: "qmd://vault/sources/hybrid.md",
      displayPath: "vault/sources/hybrid.md",
      title: "Hybrid Page",
      body: "Full body",
      bestChunk: "---\ntitle: Hybrid Page\ntags: [x]\n---\nHybrid chunk about release",
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
  const createStore = vi.fn().mockResolvedValue(mockStore);
  return { mockStore, createStore };
});

vi.mock("./load-tobilu-qmd", () => ({
  loadTobiluQmdModule: vi.fn().mockResolvedValue({ createStore }),
}));

import { QmdSearchService } from "./qmd-search-service";
import type { QmdModelManager } from "./qmd-model-manager";

function fakeModels(ready: boolean): QmdModelManager {
  return {
    embedModelPath: "/models/embed.gguf",
    isEmbedModelReady: vi.fn().mockReturnValue(ready),
    ensureEmbedModel: vi.fn(async (opts?: { onProgress?: (p: { receivedBytes: number; totalBytes: number }) => void }) => {
      opts?.onProgress?.({ receivedBytes: 5, totalBytes: 10 });
      return "/models/embed.gguf";
    }),
  } as unknown as QmdModelManager;
}

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

  it("indexes only the wiki directory", async () => {
    const svc = new QmdSearchService(tmpDir, {
      enabled: true,
      mode: "lex",
      autoEmbed: false,
    });
    await svc.initialize();
    const config = createStore.mock.calls[0][0].config;
    expect(config.collections.vault.path).toBe(path.join(tmpDir, "wiki"));
    expect(config.models).toBeUndefined();
  });

  it("maps lex search results to vault-relative wiki hits", async () => {
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

  it("runs hybrid search without query expansion or reranking", async () => {
    const svc = new QmdSearchService(tmpDir, {
      enabled: true,
      mode: "hybrid",
      autoEmbed: false,
    });
    await svc.initialize();
    const hits = await svc.search("release pipeline");
    expect(hits[0]).toMatchObject({
      title: "Hybrid Page",
      filename: "wiki/sources/hybrid.md",
      excerpt: "Hybrid chunk about release",
    });
    expect(mockStore.search).toHaveBeenCalledWith({
      queries: [
        { type: "lex", query: "release pipeline" },
        { type: "vec", query: "release pipeline" },
      ],
      limit: 8,
      rerank: false,
    });
  });

  it("downloads the embed model first and passes its local path to qmd", async () => {
    const models = fakeModels(false);
    const svc = new QmdSearchService(
      tmpDir,
      { enabled: true, mode: "hybrid", autoEmbed: true },
      models,
    );
    const phases: string[] = [];
    svc.setProgressHandler((p) => phases.push(p.phase));
    await svc.initialize();
    expect(models.ensureEmbedModel).toHaveBeenCalledTimes(1);
    expect(createStore.mock.calls[0][0].config.models).toEqual({
      embed: "/models/embed.gguf",
    });
    expect(phases[0]).toBe("download");
    expect(phases).toContain("embed");
    expect(svc.getStatus().ready).toBe(true);
  });

  it("does not download the model in lex mode without auto-embed", async () => {
    const models = fakeModels(false);
    const svc = new QmdSearchService(
      tmpDir,
      { enabled: true, mode: "lex", autoEmbed: false },
      models,
    );
    await svc.initialize();
    expect(models.ensureEmbedModel).not.toHaveBeenCalled();
  });

  it("reports a download failure instead of hanging", async () => {
    const models = fakeModels(false);
    vi.mocked(models.ensureEmbedModel).mockRejectedValueOnce(
      new Error("Failed to download embedding model: HTTP 403"),
    );
    const svc = new QmdSearchService(
      tmpDir,
      { enabled: true, mode: "hybrid", autoEmbed: true },
      models,
    );
    await svc.initialize();
    const status = svc.getStatus();
    expect(status.ready).toBe(false);
    expect(status.downloading).toBe(false);
    expect(status.error).toMatch(/HTTP 403/);
    expect(createStore).not.toHaveBeenCalled();
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

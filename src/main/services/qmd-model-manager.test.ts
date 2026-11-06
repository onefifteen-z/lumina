import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EMBED_MODEL_FILENAME,
  QmdModelManager,
  type ModelDownloadProgress,
} from "./qmd-model-manager";

function ggufBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(Buffer.from("GGUF"), 0);
  return bytes;
}

function responseOf(
  bytes: Uint8Array,
  opts: { status?: number; contentLength?: number; chunk?: number } = {},
): Response {
  const chunk = opts.chunk ?? 4;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) {
        controller.enqueue(bytes.slice(i, i + chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: opts.status ?? 200,
    headers: { "content-length": String(opts.contentLength ?? bytes.length) },
  });
}

describe("QmdModelManager", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-qmd-models-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips download when a valid model already exists", async () => {
    fs.writeFileSync(path.join(dir, EMBED_MODEL_FILENAME), ggufBytes(16));
    const fetch = vi.fn();
    const mgr = new QmdModelManager({ modelsDir: dir, fetch });
    await expect(mgr.ensureEmbedModel()).resolves.toBe(
      path.join(dir, EMBED_MODEL_FILENAME),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("downloads, reports progress, and renames into place", async () => {
    const fetch = vi.fn().mockResolvedValue(responseOf(ggufBytes(10)));
    const mgr = new QmdModelManager({ modelsDir: dir, fetch });
    const progress: ModelDownloadProgress[] = [];
    const result = await mgr.ensureEmbedModel({
      onProgress: (p) => progress.push(p),
    });
    expect(result).toBe(path.join(dir, EMBED_MODEL_FILENAME));
    expect(fs.statSync(result).size).toBe(10);
    expect(fs.existsSync(`${result}.part`)).toBe(false);
    expect(progress.at(-1)).toEqual({ receivedBytes: 10, totalBytes: 10 });
    expect(mgr.isEmbedModelReady()).toBe(true);
  });

  it("rejects non-GGUF payloads and cleans up the partial file", async () => {
    const html = new TextEncoder().encode("<html>blocked</html>");
    const fetch = vi.fn().mockResolvedValue(responseOf(html));
    const mgr = new QmdModelManager({ modelsDir: dir, fetch });
    await expect(mgr.ensureEmbedModel()).rejects.toThrow(/not a GGUF file/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("rejects truncated downloads", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(responseOf(ggufBytes(8), { contentLength: 100 }));
    const mgr = new QmdModelManager({ modelsDir: dir, fetch });
    await expect(mgr.ensureEmbedModel()).rejects.toThrow(/incomplete/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("surfaces network and HTTP errors", async () => {
    const mgr = new QmdModelManager({
      modelsDir: dir,
      fetch: vi.fn().mockRejectedValue(new Error("SELF_SIGNED_CERT_IN_CHAIN")),
    });
    await expect(mgr.ensureEmbedModel()).rejects.toThrow(
      /SELF_SIGNED_CERT_IN_CHAIN/,
    );
    const mgr404 = new QmdModelManager({
      modelsDir: dir,
      fetch: vi.fn().mockResolvedValue(new Response("nope", { status: 404 })),
    });
    await expect(mgr404.ensureEmbedModel()).rejects.toThrow(/HTTP 404/);
  });

  it("shares one download between concurrent callers", async () => {
    const fetch = vi.fn().mockResolvedValue(responseOf(ggufBytes(12)));
    const mgr = new QmdModelManager({ modelsDir: dir, fetch });
    const [a, b] = await Promise.all([
      mgr.ensureEmbedModel(),
      mgr.ensureEmbedModel(),
    ]);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

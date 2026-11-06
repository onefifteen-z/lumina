import fs from "fs";
import path from "path";

export const EMBED_MODEL_URL =
  "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf";
export const EMBED_MODEL_FILENAME = "embeddinggemma-300M-Q8_0.gguf";

const GGUF_MAGIC = "GGUF";

export type ModelDownloadProgress = {
  receivedBytes: number;
  totalBytes: number;
};

export type FetchLike = (url: string) => Promise<Response>;

export type QmdModelManagerOptions = {
  modelsDir: string;
  /**
   * Must trust the OS certificate store: Node's bundled CAs reject corporate
   * TLS-inspection roots, which makes node-llama-cpp's downloader retry forever.
   * In Electron main pass `net.fetch`.
   */
  fetch: FetchLike;
};

function hasGgufMagic(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    const read = fs.readSync(fd, buf, 0, 4, 0);
    return read === 4 && buf.toString("ascii") === GGUF_MAGIC;
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Downloads QMD's GGUF models into an app-owned directory so qmd receives an
 * absolute path and never hits the network itself.
 */
export class QmdModelManager {
  private readonly modelsDir: string;
  private readonly fetchImpl: FetchLike;
  private embedDownload: Promise<string> | null = null;
  private progressListeners = new Set<(p: ModelDownloadProgress) => void>();

  constructor(options: QmdModelManagerOptions) {
    this.modelsDir = options.modelsDir;
    this.fetchImpl = options.fetch;
  }

  get embedModelPath(): string {
    return path.join(this.modelsDir, EMBED_MODEL_FILENAME);
  }

  isEmbedModelReady(): boolean {
    return hasGgufMagic(this.embedModelPath);
  }

  async ensureEmbedModel(
    options: { onProgress?: (p: ModelDownloadProgress) => void } = {},
  ): Promise<string> {
    if (this.isEmbedModelReady()) return this.embedModelPath;
    const { onProgress } = options;
    if (onProgress) this.progressListeners.add(onProgress);
    try {
      if (!this.embedDownload) {
        this.embedDownload = this.download(
          EMBED_MODEL_URL,
          this.embedModelPath,
        ).finally(() => {
          this.embedDownload = null;
        });
      }
      return await this.embedDownload;
    } finally {
      if (onProgress) this.progressListeners.delete(onProgress);
    }
  }

  private emit(progress: ModelDownloadProgress): void {
    for (const listener of this.progressListeners) listener(progress);
  }

  private async download(url: string, dest: string): Promise<string> {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const partPath = `${dest}.part`;
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to download embedding model: ${reason}`);
      }
      if (!res.ok || !res.body) {
        throw new Error(
          `Failed to download embedding model: HTTP ${res.status} from ${url}`,
        );
      }
      const totalBytes = Number(res.headers.get("content-length")) || 0;
      let receivedBytes = 0;
      this.emit({ receivedBytes, totalBytes });

      const out = fs.createWriteStream(partPath);
      const outDone = new Promise<void>((resolve, reject) => {
        out.on("finish", resolve);
        out.on("error", reject);
      });
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          receivedBytes += value.byteLength;
          if (!out.write(value)) {
            await new Promise<void>((resolve) => out.once("drain", resolve));
          }
          this.emit({ receivedBytes, totalBytes });
        }
      } finally {
        out.end();
      }
      await outDone;

      if (totalBytes > 0 && receivedBytes !== totalBytes) {
        throw new Error(
          `Embedding model download incomplete (${receivedBytes} of ${totalBytes} bytes)`,
        );
      }
      if (!hasGgufMagic(partPath)) {
        throw new Error(
          "Downloaded embedding model is not a GGUF file (a proxy may have returned an error page)",
        );
      }
      fs.renameSync(partPath, dest);
      return dest;
    } catch (err) {
      fs.rmSync(partPath, { force: true });
      throw err;
    }
  }
}

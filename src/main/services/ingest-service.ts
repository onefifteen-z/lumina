import fs from "fs/promises";
import path from "path";
import type {
  ChatContentBlock,
  IngestRequest,
  IngestResult,
  IngestKind,
} from "../../shared/types";
import type { LLMService } from "./llm-service";
import type { FileSystemService } from "./filesystem-service";
import { rasterizePdfToPngs } from "./pdf-rasterize";

const TEXT_CHAR_LIMIT = 180_000;
/**
 * Hard cap on PDF pages that get rasterized for vision input. The chat
 * gateway has a token budget, and one PNG page typically consumes thousands
 * of vision tokens; capping at 50 keeps even dense slide decks under the
 * limit. PDFs longer than this are truncated with a user-facing warning.
 */
const PDF_MAX_PAGES = 50;

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".csv",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".html",
  ".htm",
  ".xml",
  ".css",
  ".scss",
  ".log",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
  ".svg",
]);

export class IngestService {
  private llm: LLMService | null;
  private fileSystem: FileSystemService | null;

  constructor(llm: LLMService | null, fileSystem: FileSystemService | null) {
    this.llm = llm;
    this.fileSystem = fileSystem;
  }

  setLLMService(llm: LLMService | null): void {
    this.llm = llm;
  }

  setFileSystemService(fileSystem: FileSystemService | null): void {
    this.fileSystem = fileSystem;
  }

  async ingestFile(request: IngestRequest): Promise<IngestResult> {
    if (!this.fileSystem) {
      throw new Error("No vault is open. Please select a vault folder first.");
    }

    const rel = normaliseVaultRelativePath(request.filename);
    const abs = resolveVaultPath(this.fileSystem.getVaultPath(), rel);

    const ext = path.extname(rel).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      return this.ingestImage(abs, rel);
    }
    if (ext === ".pdf") {
      return this.ingestPdf(abs, rel, "pdf");
    }
    if (ext === ".pptx") {
      return this.ingestPptx(abs, rel);
    }
    if (TEXT_EXTENSIONS.has(ext) || ext === "") {
      return this.ingestText(abs, rel);
    }

    throw new Error(
      `Unsupported file type "${ext || "unknown"}". Supported: text, pdf, pptx, image.`,
    );
  }

  private async ingestText(absPath: string, sourceFilename: string): Promise<IngestResult> {
    const raw = await fs.readFile(absPath, "utf-8");
    const text =
      raw.length > TEXT_CHAR_LIMIT
        ? `${raw.slice(0, TEXT_CHAR_LIMIT)}\n\n...[truncated ${raw.length - TEXT_CHAR_LIMIT} chars]`
        : raw;

    const blocks: ChatContentBlock[] = [
      {
        type: "text",
        text: `File: ${sourceFilename}\n\n${text}`,
      },
    ];

    return {
      sourceFilename,
      kind: "text",
      blocks,
      summary: `Ingested text file (${text.length} chars${raw.length > text.length ? ", truncated" : ""}).`,
      chunkCount: 1,
    };
  }

  private async ingestImage(absPath: string, sourceFilename: string): Promise<IngestResult> {
    const buffer = await fs.readFile(absPath);
    const mimeType = detectMimeType(sourceFilename);
    const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
    const blocks: ChatContentBlock[] = [
      {
        type: "image_url",
        image_url: {
          url: dataUrl,
          detail: "high",
        },
      },
    ];

    return {
      sourceFilename,
      kind: "image",
      blocks,
      summary: `Attached image as vision input (${mimeType}, ${(buffer.length / 1024).toFixed(1)} KiB).`,
      chunkCount: 1,
    };
  }

  /**
   * Rasterize each PDF page to PNG and ship as `image_url` blocks.
   *
   * History: this used to upload the PDF to `/v1/files` and reference it
   * by `file_id`. Our LLM gateway now blocks that endpoint, so we render
   * pages locally with pdfjs + napi-canvas and send them through the
   * standard vision content channel that *is* allowed.
   *
   * Trade-offs vs. the old upload path:
   *   + Works on locked-down gateways (no /v1/files needed)
   *   + Provider-agnostic (any model with vision input can read it)
   *   - Larger payload (one base64 PNG per page)
   *   - Token-hungry — capped at PDF_MAX_PAGES with a warning
   */
  private async ingestPdf(
    absPath: string,
    sourceFilename: string,
    kind: IngestKind,
  ): Promise<IngestResult> {
    const sourceBytes = await fs.readFile(absPath);
    const { pages, totalPages, truncated } = await rasterizePdfToPngs(
      new Uint8Array(sourceBytes),
      { maxPages: PDF_MAX_PAGES },
    );

    if (pages.length === 0) {
      throw new Error(
        `Failed to render PDF "${sourceFilename}": no pages could be rasterized.`,
      );
    }

    // First block is a text header so the model knows where the images
    // came from and which page each subsequent image represents. Without
    // this, multi-page PDFs become an ambiguous wall of pictures.
    const headerLines = [
      `File: ${sourceFilename}`,
      `Pages rendered: ${pages.length} of ${totalPages}` +
        (truncated
          ? ` (truncated to first ${PDF_MAX_PAGES} pages — ask about specific later pages if needed)`
          : ""),
      "Each subsequent image is one page of this PDF, in order.",
    ];
    const blocks: ChatContentBlock[] = [
      { type: "text", text: headerLines.join("\n") },
    ];

    let totalBytes = 0;
    for (const page of pages) {
      totalBytes += page.png.length;
      blocks.push({
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${page.png.toString("base64")}`,
          detail: "high",
        },
      });
    }

    const sizeMiB = (totalBytes / 1024 / 1024).toFixed(2);
    const summary = truncated
      ? `Rasterized ${pages.length} of ${totalPages} pages to PNG (${sizeMiB} MiB). Truncated at ${PDF_MAX_PAGES}-page cap.`
      : `Rasterized ${pages.length} pages to PNG (${sizeMiB} MiB).`;

    return {
      sourceFilename,
      kind,
      blocks,
      summary,
      chunkCount: pages.length,
    };
  }

  /**
   * PPTX ingest is temporarily unavailable on gateways that block
   * `/v1/files`. The previous code path uploaded the .pptx blob directly,
   * which the gateway now rejects. Rendering PPTX → images locally would
   * require shelling out to LibreOffice (already a heavy dependency we'd
   * rather not introduce just for this path), so for now we ask users to
   * convert to PDF first — the PDF path renders pages to PNG and works
   * end-to-end.
   */
  private async ingestPptx(_absPath: string, sourceFilename: string): Promise<IngestResult> {
    throw new Error(
      `PPTX ingest is not supported on this LLM gateway. ` +
        `Please export "${sourceFilename}" to PDF first (File → Export As → PDF) and then ingest the PDF.`,
    );
  }

}

function detectMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    default:
      return "application/octet-stream";
  }
}

function normaliseVaultRelativePath(input: string): string {
  const rel = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel) throw new Error("Filename is required.");
  if (rel.split("/").some((seg) => seg === "..")) {
    throw new Error("Path escapes vault.");
  }
  return rel;
}

function resolveVaultPath(vaultRoot: string, relative: string): string {
  const root = path.resolve(vaultRoot);
  const abs = path.resolve(path.join(root, relative));
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("Path escapes vault.");
  }
  return abs;
}

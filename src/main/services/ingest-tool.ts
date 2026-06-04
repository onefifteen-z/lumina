/**
 * Implementation of the `ingest_source` tool exposed to the model.
 *
 * The model calls this with `{ path, mode? }` and gets back a single string.
 * The first line is always a status header the model can pattern-match on:
 *   `[ingest_source ok kind=<text|image|office|office-vision>]`
 *   `[ingest_source error kind=<...>]`
 * followed by a blank line and then either the extracted content (markdown,
 * plain text, or markdown with embedded image data URLs) or a human-readable
 * error message.
 *
 * Why a string and not a structured `tool_result` with image blocks?
 * OpenAI Chat-Completions only accepts string content on `role: tool`
 * messages. Even on Anthropic-style providers that allow multipart, our LLM
 * gateway behaviour around array-form tool results is inconsistent. Embedding
 * images as markdown data URLs is the lowest-common-denominator that works
 * for every vision-capable model we ship to.
 *
 * The dispatch contract (kept aligned with `assets/templates/INGEST.md`):
 *   - mode='text' / mode='vision':
 *       always win over OpenAI File Upload — never POST to /v1/files
 *   - mode='auto' (default):
 *       when `ctx.fileIngest` is on → upload office/PDF files via Files
 *       API (fall back to markitdown if upload fails); images inline
 *       text exts            → read file, truncate, return as text
 *       image exts           → read file, return ![](data:...)
 *       office exts (pdf...) → ensureLuminaVenv → markitdown
 *       unknown              → error
 *   - mode='text':
 *       always go through markitdown (caller swears it's a text doc)
 *   - mode='vision':
 *       PDF only → rasterize each page to PNG when `ctx.pdfImageIngest` is
 *       true; otherwise same markitdown path as office (no page images).
 *       Anything else → error (PPTX vision rasterization isn't implemented;
 *                       images don't need it)
 */

import * as path from "path";
import * as fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { ensureLuminaVenv, luminaVenvNeedsBootstrap, shQuote } from "./lumina-venv";
import type { EnsureVenvResult } from "./lumina-venv";
import { rasterizePdfToPngs } from "./pdf-rasterize";
import type { ChatContentBlock } from "../../shared/types";

const execAsync = promisify(exec);

/** Hard cap on text content returned by the tool. Mirrors ingest-service. */
export const TEXT_CHAR_LIMIT = 180_000;

/** Hard cap on PDF pages we'll rasterize on the vision path. */
export const PDF_VISION_MAX_PAGES = 50;

/** markitdown can be slow on large/complex PDFs; 5 min ceiling. */
export const MARKITDOWN_TIMEOUT_MS = 300_000;

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".csv",
  ".tsv",
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
  ".sh",
  ".toml",
  ".ini",
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

/** Anything markitdown can plausibly handle. */
const OFFICE_EXTENSIONS = new Set([
  ".pdf",
  ".pptx",
  ".xlsx",
  ".docx",
  ".doc",
  ".ppt",
  ".xls",
  ".epub",
  ".rtf",
]);

export type IngestMode = "auto" | "text" | "vision";

export interface IngestArgs {
  path: string;
  mode?: IngestMode;
}

export interface IngestContext {
  /** Absolute path to the open vault. Required — there's no global default. */
  vaultRoot: string;
  /**
   * When true, `mode=vision` on PDFs rasterizes pages to PNGs. When false or
   * omitted, vision on PDF uses markitdown only (matches default app setting).
   */
  pdfImageIngest?: boolean;
  /**
   * When true, PDF/image/PPTX files are uploaded via the OpenAI Files API
   * and referenced by file_id instead of being processed locally.
   */
  fileIngest?: boolean;
  /**
   * When true, the chat transport is the OpenAI Responses API, which (unlike
   * Chat Completions) accepts `file_id` for non-PDF office formats too.
   * Loosens the `fileIngest` branch so `.pptx`, `.xlsx`, `.docx`, `.doc`,
   * `.epub`, `.rtf` get uploaded natively instead of falling back to
   * markitdown. Has no effect when `fileIngest` is false.
   */
  responsesApi?: boolean;
  /** Upload a file via the LLM provider's /v1/files endpoint. */
  uploadFile?: (filePath: string) => Promise<{ id: string }>;
  /** Override the venv-bootstrap step. Tests inject a stub. */
  ensureVenv?: () => Promise<EnsureVenvResult>;
  /**
   * Consent gate for the venv bootstrap. Called *only* when the shared
   * `~/.lumina/venv/` needs to be created, rebuilt, or have markitdown
   * (re)installed — i.e. operations that shell out to pip and download
   * ~200MB of transitive dependencies. When omitted, bootstrap proceeds
   * without prompting (matches previous silent behaviour; used by tests
   * and the legacy `IngestService`).
   *
   * Implementations should return `true` to proceed, `false` to abort the
   * current ingest. The probe for "is bootstrap needed?" is separate from
   * this callback so cached/ready venvs never trigger a prompt.
   */
  requestVenvConsent?: () => Promise<boolean>;
  /** Override `luminaVenvNeedsBootstrap` for tests. */
  probeVenvNeedsBootstrap?: () => Promise<boolean>;
  /** Override the rasterize call. Tests inject a stub. */
  rasterize?: typeof rasterizePdfToPngs;
  /** Override exec. Tests inject a stub so markitdown never actually runs. */
  execCommand?: (cmd: string, opts: { timeout: number; maxBuffer?: number }) =>
    Promise<{ stdout: string; stderr: string }>;
}

export type ExtractMarkdownResult =
  | { ok: true; body: string }
  | { ok: false; headerKind: string; message: string };

/**
 * Run markitdown on a document path (PDF, Office, etc.). Shared by
 * `runOffice`, vision fallback when rasterization is disabled, and chat PDF
 * ingest without images.
 */
export async function extractMarkdownViaMarkitdown(
  absPath: string,
  rel: string,
  ctx: IngestContext,
  opts?: { includeVisionRetryHint?: boolean },
): Promise<ExtractMarkdownResult> {
  const includeVisionRetryHint = opts?.includeVisionRetryHint !== false;
  // Consent gate: if a bootstrap step is needed AND the caller wired a
  // consent callback, ask before shelling out to pip. When the user
  // declines we return a distinct `office-consent-declined` header so the
  // model can relay a friendly "no action taken" message instead of
  // pretending the file was un-ingestable.
  if (ctx.requestVenvConsent) {
    const probe = ctx.probeVenvNeedsBootstrap ?? luminaVenvNeedsBootstrap;
    let needsBootstrap = false;
    try {
      needsBootstrap = await probe();
    } catch {
      // Probe errors are pessimistic by design — treat as "needs bootstrap"
      // so we prompt rather than skipping consent silently.
      needsBootstrap = true;
    }
    if (needsBootstrap) {
      const approved = await ctx.requestVenvConsent();
      if (!approved) {
        return {
          ok: false,
          headerKind: "office-consent-declined",
          message:
            `Lumina needs to create a local Python venv at ~/.lumina/venv/ and install markitdown to parse "${rel}", ` +
            `but the user declined the installation prompt. Ask the user to re-try this ingest and approve the prompt, ` +
            `or to install markitdown manually and retry. No files were changed.`,
        };
      }
    }
  }
  const ensure = ctx.ensureVenv ?? ensureLuminaVenv;
  const venv = await ensure();
  if (!venv.ok) {
    return {
      ok: false,
      headerKind: `office-${venv.reason}`,
      message: venv.message,
    };
  }

  const cmd = `${shQuote(venv.pythonBin)} -m markitdown ${shQuote(absPath)}`;
  const runExec = ctx.execCommand ?? defaultExec;

  let stdout = "";
  try {
    const result = await runExec(cmd, {
      timeout: MARKITDOWN_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stderr?: string;
      stdout?: string;
      killed?: boolean;
      signal?: string;
    };
    if (e.killed && e.signal === "SIGTERM") {
      const pdf = path.extname(rel).toLowerCase() === ".pdf";
      const visionPart =
        includeVisionRetryHint && pdf
          ? ` For PDFs, retry with mode: "vision" to rasterize pages instead.`
          : "";
      return {
        ok: false,
        headerKind: "office-timeout",
        message:
          `markitdown timed out after ${MARKITDOWN_TIMEOUT_MS / 1000}s on "${rel}".${visionPart}`,
      };
    }
    const stderr = (e.stderr ?? "").trim();
    const ext = path.extname(rel).toLowerCase();
    const visionHint =
      includeVisionRetryHint && ext === ".pdf"
        ? ` For PDFs you can retry with mode: "vision" to rasterize pages.`
        : ext === ".pptx" || ext === ".ppt"
          ? ` PPTX vision rasterization is not implemented — please convert "${rel}" to PDF first and ingest the PDF.`
          : "";
    return {
      ok: false,
      headerKind: "office-failed",
      message:
        `markitdown failed on "${rel}": ${stderr || e.message || "unknown error"}.${visionHint}`,
    };
  }

  const truncated = stdout.length > TEXT_CHAR_LIMIT;
  const content = truncated
    ? `${stdout.slice(0, TEXT_CHAR_LIMIT)}\n\n…[truncated ${stdout.length - TEXT_CHAR_LIMIT} chars]`
    : stdout;
  const note = truncated
    ? `Source: ${rel} (extracted via markitdown; ${stdout.length} chars, truncated to ${TEXT_CHAR_LIMIT})\n\n`
    : `Source: ${rel} (extracted via markitdown; ${stdout.length} chars)\n\n`;
  return { ok: true, body: note + content };
}

/**
 * Status header emitter. Centralised so we can change the format in one
 * place — INGEST.md depends on this exact shape.
 */
function header(ok: boolean, kind: string): string {
  return `[ingest_source ${ok ? "ok" : "error"} kind=${kind}]`;
}

/**
 * Build the standard tool-result string. Header on its own line, blank
 * line, body. The blank line lets the model's markdown parser cleanly
 * separate the status from any markdown content that follows.
 */
function format(status: string, body: string): string {
  return `${status}\n\n${body}`;
}

/**
 * Validate + normalise the model-supplied vault-relative path.
 *
 * Mirrors `normaliseVaultRelativePath` in ingest-service.ts but local to
 * this module so we don't couple to the legacy IPC surface. We reject any
 * `..` segment to prevent the model from reading outside the vault even
 * if the prompt tries to coax it.
 */
export function normaliseRelativePath(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) throw new Error("path is required");
  const normalised = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalised.split("/").some((seg) => seg === "..")) {
    throw new Error("path escapes vault");
  }
  return normalised;
}

/** Resolve a vault-relative path to an absolute one, with a containment check. */
export function resolveAbsolute(vaultRoot: string, relative: string): string {
  const root = path.resolve(vaultRoot);
  const abs = path.resolve(root, relative);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("path escapes vault");
  }
  return abs;
}

/** Mime type → for image data URLs. Falls back to octet-stream for unknown. */
export function detectImageMime(filename: string): string {
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

/** Result from runIngestTool: tool output string + optional content blocks to inject. */
export interface IngestToolResult {
  output: string;
  contentBlocks?: ChatContentBlock[];
}

/**
 * Top-level entry. Always returns a result — never throws to the caller.
 * Throwing would surface as a generic "tool execution failed" message, but
 * we want every failure to carry an actionable message the model can pass
 * to the user.
 */
export async function runIngestTool(
  rawArgs: unknown,
  ctx: IngestContext,
): Promise<IngestToolResult> {
  let args: IngestArgs;
  try {
    args = parseArgs(rawArgs);
  } catch (err) {
    return { output: format(
      header(false, "args"),
      `Invalid arguments: ${(err as Error).message}`,
    ) };
  }

  let rel: string;
  let abs: string;
  try {
    rel = normaliseRelativePath(args.path);
    abs = resolveAbsolute(ctx.vaultRoot, rel);
  } catch (err) {
    return { output: format(
      header(false, "path"),
      `Invalid path "${args.path}": ${(err as Error).message}`,
    ) };
  }

  // Existence check up front gives us a single, helpful "file not found"
  // message instead of three different errors from the three branches.
  try {
    await fs.access(abs);
  } catch {
    return { output: format(
      header(false, "not-found"),
      `File "${rel}" does not exist in the vault. Check the path (it must be vault-relative, e.g. raw/foo.pdf).`,
    ) };
  }

  const mode = args.mode ?? "auto";
  const ext = path.extname(rel).toLowerCase();

  // Explicit mode overrides take precedence over OpenAI File Upload.
  if (mode === "vision") {
    return { output: await runVision(abs, rel, ext, ctx) };
  }
  if (mode === "text") {
    return { output: await runOffice(abs, rel, ctx) };
  }

  // File upload mode (mode === "auto" only): branch by file type AND by
  // which chat transport we're talking to.
  //
  // Chat Completions:
  //   - .pdf                       → upload + `file_id` content block
  //   - images                     → inline as base64 `image_url` block
  //                                  (CC has no file_id-by-image path)
  //   - .xlsx/.xls/.pptx/.ppt/...  → markitdown via runOffice. CC validator
  //                                  rejects file_id for non-PDF MIME types.
  //
  // Responses API (`ctx.responsesApi === true`):
  //   - .pdf and other OFFICE_EXTENSIONS → upload + `file_id` content
  //                                        block (Responses API's
  //                                        `input_file` accepts all of
  //                                        them; pptx/docx extract text,
  //                                        xlsx gets spreadsheet
  //                                        augmentation server-side).
  //   - images                     → still inline as base64 `image_url`.
  //                                  Cheaper than uploading and works on
  //                                  both transports.
  if (ctx.fileIngest) {
    if (OFFICE_EXTENSIONS.has(ext)) {
      // Responses API: every OFFICE_EXTENSIONS file rides Files API.
      // Chat Completions: only .pdf does; everything else still uses
      // markitdown locally (CC validator rejects file_id for non-PDF).
      const uploadable = ctx.responsesApi === true || ext === ".pdf";
      if (uploadable && ctx.uploadFile) {
        return runFileUpload(abs, rel, ctx);
      }
      return { output: await runOffice(abs, rel, ctx) };
    }
    if (IMAGE_EXTENSIONS.has(ext)) {
      return runImageBlock(abs, rel);
    }
  }

  // mode === 'auto' — dispatch by extension
  if (IMAGE_EXTENSIONS.has(ext)) {
    return { output: await runImage(abs, rel) };
  }
  if (TEXT_EXTENSIONS.has(ext) || ext === "") {
    return { output: await runText(abs, rel) };
  }
  if (OFFICE_EXTENSIONS.has(ext)) {
    return { output: await runOffice(abs, rel, ctx) };
  }
  return { output: format(
    header(false, "unsupported"),
    `Unsupported extension "${ext || "(none)"}". ` +
      `Supported: text (.txt/.md/.json/...), image (.png/.jpg/...), ` +
      `office (.pdf/.pptx/.xlsx/.docx/...).`,
  ) };
}

/**
 * File-upload-mode handler for images. We bypass the Files API entirely
 * because OpenAI's Chat Completions endpoint does not accept `file_id`
 * for non-PDF MIME types — it explicitly rejects with "Expected a file
 * with an application/pdf MIME type, but got unsupported MIME type
 * 'image/jpeg'". Instead we read the bytes, attach them as a standard
 * `image_url` content block (base64 data URL), and the model "sees" them
 * the same way it would via the regular `runImage` path.
 *
 * The tool-output text is intentionally lightweight (no embedded data
 * URL): we don't want the model echoing megabytes of base64 back into
 * follow-up prompts via the tool-result transcript.
 */
async function runImageBlock(
  absPath: string,
  rel: string,
): Promise<IngestToolResult> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(absPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      output: format(
        header(false, "file-upload"),
        `Failed to read "${rel}": ${e.message ?? "unknown error"}`,
      ),
    };
  }
  const mime = detectImageMime(rel);
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  const contentBlocks: ChatContentBlock[] = [
    {
      type: "image_url",
      image_url: { url: dataUrl, detail: "auto" },
    },
  ];
  return {
    output: format(
      header(true, "file-upload"),
      `Attached "${rel}" (${(buf.length / 1024).toFixed(1)} KiB, ${mime}) as an image content block. The image is now visible to you — no further action needed.`,
    ),
    contentBlocks,
  };
}

/** Upload a file via the OpenAI Files API and return a file content block. */
async function runFileUpload(
  absPath: string,
  rel: string,
  ctx: IngestContext,
): Promise<IngestToolResult> {
  if (!ctx.uploadFile) {
    return { output: format(header(false, "file-upload"), "File upload service is not available.") };
  }
  try {
    const result = await ctx.uploadFile(absPath);
    // NOTE: OpenAI's Chat Completions API rejects `filename` on a file
    // content part when `file_id` is also set ("Unknown parameter:
    // messages[…].content[…].file.filename"). `filename` is only valid
    // alongside inline `file_data` (base64). We keep the filename in the
    // tool output text so the model still has the human-readable name.
    const contentBlocks: ChatContentBlock[] = [{
      type: "file",
      file: { file_id: result.id },
    }];
    return {
      output: format(header(true, "file-upload"), `Uploaded "${rel}" via Files API (file_id: ${result.id}). The file content is now available to you as an attached file.`),
      contentBlocks,
    };
  } catch (err) {
    const uploadErr = (err as Error).message;
    const officeOutput = await runOffice(absPath, rel, ctx);
    const note =
      `OpenAI Files API upload failed (${uploadErr}). ` +
      `Fell back to local markitdown extraction.`;
    return { output: injectAfterIngestHeader(officeOutput, note) };
  }
}

/** Insert a paragraph immediately after the `[ingest_source …]` header line. */
function injectAfterIngestHeader(output: string, paragraph: string): string {
  const sep = output.indexOf("\n\n");
  if (sep === -1) return `${output}\n\n${paragraph}`;
  return `${output.slice(0, sep + 2)}${paragraph}\n\n${output.slice(sep + 2)}`;
}

/** Parse + validate the raw tool arguments object. */
function parseArgs(raw: unknown): IngestArgs {
  if (!raw || typeof raw !== "object") {
    throw new Error("expected an object with { path, mode? }");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.path !== "string") {
    throw new Error("path must be a string");
  }
  let mode: IngestMode | undefined;
  if (obj.mode !== undefined) {
    if (
      obj.mode !== "auto" &&
      obj.mode !== "text" &&
      obj.mode !== "vision"
    ) {
      throw new Error(`mode must be one of "auto"|"text"|"vision"`);
    }
    mode = obj.mode;
  }
  return { path: obj.path, mode };
}

async function runText(absPath: string, rel: string): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf-8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return format(
      header(false, "text"),
      `Failed to read "${rel}": ${e.message ?? "unknown error"}`,
    );
  }
  const truncated = raw.length > TEXT_CHAR_LIMIT;
  const content = truncated
    ? `${raw.slice(0, TEXT_CHAR_LIMIT)}\n\n…[truncated ${raw.length - TEXT_CHAR_LIMIT} chars]`
    : raw;
  const note = truncated
    ? `Source: ${rel} (${raw.length} chars; truncated to ${TEXT_CHAR_LIMIT})\n\n`
    : `Source: ${rel} (${raw.length} chars)\n\n`;
  return format(header(true, "text"), note + content);
}

async function runImage(absPath: string, rel: string): Promise<string> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(absPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return format(
      header(false, "image"),
      `Failed to read "${rel}": ${e.message ?? "unknown error"}`,
    );
  }
  const mime = detectImageMime(rel);
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  // Markdown-image syntax with a path label so the model can refer back to
  // it (e.g. "as you can see in the image at raw/diagram.png ..."). Vision
  // models render the data URL inline.
  const body = `Source: ${rel} (${(buf.length / 1024).toFixed(1)} KiB, ${mime})\n\n![${rel}](${dataUrl})`;
  return format(header(true, "image"), body);
}

async function runOffice(
  absPath: string,
  rel: string,
  ctx: IngestContext,
  officeOpts?: { includeVisionRetryHint?: boolean },
): Promise<string> {
  const extracted = await extractMarkdownViaMarkitdown(absPath, rel, ctx, {
    includeVisionRetryHint: officeOpts?.includeVisionRetryHint !== false,
  });
  if (!extracted.ok) {
    return format(header(false, extracted.headerKind), extracted.message);
  }
  return format(header(true, "office"), extracted.body);
}

async function runVision(
  absPath: string,
  rel: string,
  ext: string,
  ctx: IngestContext,
): Promise<string> {
  if (ext !== ".pdf") {
    return format(
      header(false, "vision-unsupported"),
      `mode="vision" is only supported for .pdf files. ` +
        (ext === ".pptx" || ext === ".ppt"
          ? `For "${rel}", convert to PDF first and re-ingest.`
          : `For "${rel}", use mode="auto".`),
    );
  }

  if (ctx.pdfImageIngest !== true) {
    return runOffice(absPath, rel, ctx, { includeVisionRetryHint: false });
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(absPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return format(
      header(false, "vision-read"),
      `Failed to read "${rel}": ${e.message ?? "unknown error"}`,
    );
  }

  const rasterizer = ctx.rasterize ?? rasterizePdfToPngs;
  let result: Awaited<ReturnType<typeof rasterizePdfToPngs>>;
  try {
    result = await rasterizer(new Uint8Array(bytes), {
      maxPages: PDF_VISION_MAX_PAGES,
    });
  } catch (err) {
    return format(
      header(false, "vision-rasterize"),
      `Rasterize failed for "${rel}": ${(err as Error).message ?? "unknown error"}. ` +
        `The PDF may be corrupt or password-protected.`,
    );
  }

  if (result.pages.length === 0) {
    return format(
      header(false, "vision-empty"),
      `No pages could be rasterized from "${rel}".`,
    );
  }

  // Embed each page as a markdown image with a labelled alt text so the
  // model can reference specific pages later ("on page 3 of raw/foo.pdf...").
  const lines: string[] = [];
  let totalBytes = 0;
  for (const page of result.pages) {
    totalBytes += page.png.length;
    lines.push(
      `![${rel} page ${page.pageNumber}](data:image/png;base64,${page.png.toString("base64")})`,
    );
  }

  const sizeMiB = (totalBytes / 1024 / 1024).toFixed(2);
  const truncationNote = result.truncated
    ? ` (truncated to first ${PDF_VISION_MAX_PAGES} pages of ${result.totalPages})`
    : "";
  const note =
    `Source: ${rel} (rasterized ${result.pages.length} pages` +
    truncationNote +
    `; total ${sizeMiB} MiB)\n\n` +
    `Each image below is one page of the PDF, in order.\n\n`;
  return format(header(true, "office-vision"), note + lines.join("\n\n"));
}

/** Default exec wrapper; isolated so tests can fully mock it. */
async function defaultExec(
  cmd: string,
  opts: { timeout: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execAsync(cmd, opts);
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

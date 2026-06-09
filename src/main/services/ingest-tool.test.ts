import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import {
  runIngestTool,
  normaliseRelativePath,
  resolveAbsolute,
  detectImageMime,
  TEXT_CHAR_LIMIT,
  type IngestContext,
} from "./ingest-tool";
import type { EnsureVenvResult } from "./lumina-venv";

/**
 * These tests pin the ingest_source tool's behaviour: dispatch by extension
 * + mode override, error string shapes (which INGEST.md depends on), text
 * truncation, image data URL formatting, and the venv/markitdown failure
 * paths. The venv and rasterize calls are stubbed — we never bootstrap a
 * real Python environment or render real PDFs in CI.
 */

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lumina-ingest-test-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** Build a context that always succeeds at venv bootstrap (pythonBin is fake). */
function happyCtx(overrides: Partial<IngestContext> = {}): IngestContext {
  return {
    vaultRoot: tmpRoot,
    /** Tests that expect rasterized vision output opt in explicitly via overrides when needed. */
    pdfImageIngest: true,
    ensureVenv: async (): Promise<EnsureVenvResult> => ({
      ok: true,
      pythonBin: "/fake/venv/bin/python",
      venvDir: "/fake/venv",
    }),
    rasterize: async () => ({
      pages: [
        {
          pageNumber: 1,
          width: 100,
          height: 100,
          png: Buffer.from("fake-png-page-1"),
        },
      ],
      totalPages: 1,
      truncated: false,
    }),
    execCommand: async () => ({ stdout: "extracted markdown", stderr: "" }),
    ...overrides,
  };
}

async function writeFile(rel: string, content: string | Buffer): Promise<void> {
  const abs = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

// ── Pure helpers ──────────────────────────────────────────────────

describe("normaliseRelativePath", () => {
  it("trims, normalises slashes, strips leading slash", () => {
    expect(normaliseRelativePath("  raw/foo.pdf  ")).toBe("raw/foo.pdf");
    expect(normaliseRelativePath("/raw/foo.pdf")).toBe("raw/foo.pdf");
    expect(normaliseRelativePath("raw\\foo.pdf")).toBe("raw/foo.pdf");
  });

  it("rejects empty input", () => {
    expect(() => normaliseRelativePath("")).toThrow(/required/);
    expect(() => normaliseRelativePath("   ")).toThrow(/required/);
  });

  it("rejects path-escape attempts", () => {
    // The model should never be able to read outside the vault even if the
    // prompt instructs it to. Pinning every variant we can think of.
    expect(() => normaliseRelativePath("../etc/passwd")).toThrow(/escapes/);
    expect(() => normaliseRelativePath("raw/../../etc/passwd")).toThrow(/escapes/);
    expect(() => normaliseRelativePath("a/../b")).toThrow(/escapes/);
  });
});

describe("resolveAbsolute", () => {
  it("joins vault root with the relative path", () => {
    const abs = resolveAbsolute("/v", "raw/foo.pdf");
    expect(abs).toBe(path.resolve("/v/raw/foo.pdf"));
  });

  it("rejects an escape via absolute resolution mismatch", () => {
    // Even if normaliseRelativePath is bypassed, a final containment
    // check ensures the resolved path stays inside the vault.
    expect(() => resolveAbsolute("/v", "../../etc/passwd")).toThrow(/escapes/);
  });
});

describe("detectImageMime", () => {
  it("maps common image extensions to the right MIME", () => {
    expect(detectImageMime("a.png")).toBe("image/png");
    expect(detectImageMime("a.jpg")).toBe("image/jpeg");
    expect(detectImageMime("a.JPEG")).toBe("image/jpeg");
    expect(detectImageMime("a.svg")).toBe("image/svg+xml");
    expect(detectImageMime("a.tif")).toBe("image/tiff");
  });

  it("falls back to octet-stream for unknown extensions", () => {
    expect(detectImageMime("a.unknownext")).toBe("application/octet-stream");
  });
});

// ── runIngestTool argument validation ─────────────────────────────

describe("runIngestTool: arg validation", () => {
  it("rejects non-object args with kind=args header", async () => {
    const { output: out } = await runIngestTool(null, happyCtx());
    expect(out).toMatch(/^\[ingest_source error kind=args\]/);
  });

  it("rejects missing path with kind=args header", async () => {
    const { output: out } = await runIngestTool({ mode: "auto" }, happyCtx());
    expect(out).toMatch(/^\[ingest_source error kind=args\]/);
    expect(out).toMatch(/path must be a string/);
  });

  it("rejects unknown mode with kind=args header", async () => {
    const { output: out } = await runIngestTool(
      { path: "x.txt", mode: "magic" },
      happyCtx(),
    );
    expect(out).toMatch(/^\[ingest_source error kind=args\]/);
    expect(out).toMatch(/auto.*text.*vision/);
  });

  it("rejects path-escape with kind=path header", async () => {
    const { output: out } = await runIngestTool({ path: "../etc/passwd" }, happyCtx());
    expect(out).toMatch(/^\[ingest_source error kind=path\]/);
  });

  it("returns kind=not-found for missing files", async () => {
    const { output: out } = await runIngestTool({ path: "raw/nope.pdf" }, happyCtx());
    expect(out).toMatch(/^\[ingest_source error kind=not-found\]/);
    expect(out).toContain("raw/nope.pdf");
  });
});

// ── auto dispatch by extension ────────────────────────────────────

describe("runIngestTool auto dispatch", () => {
  it("text file → kind=text + content body", async () => {
    await writeFile("notes.md", "# hello\nworld");
    const { output: out } = await runIngestTool({ path: "notes.md" }, happyCtx());
    expect(out).toMatch(/^\[ingest_source ok kind=text\]/);
    expect(out).toContain("# hello");
    expect(out).toContain("world");
  });

  it("text file with no extension → kind=text (fallback)", async () => {
    await writeFile("README", "plain readme");
    const { output: out } = await runIngestTool({ path: "README" }, happyCtx());
    expect(out).toMatch(/^\[ingest_source ok kind=text\]/);
    expect(out).toContain("plain readme");
  });

  it("text file beyond TEXT_CHAR_LIMIT → truncation note", async () => {
    const big = "x".repeat(TEXT_CHAR_LIMIT + 100);
    await writeFile("big.txt", big);
    const { output: out } = await runIngestTool({ path: "big.txt" }, happyCtx());
    expect(out).toContain("truncated");
    expect(out).toContain(`truncated to ${TEXT_CHAR_LIMIT}`);
  });

  it("image file → kind=image + data URL", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile("diagram.png", png);
    const { output: out } = await runIngestTool({ path: "diagram.png" }, happyCtx());
    expect(out).toMatch(/^\[ingest_source ok kind=image\]/);
    expect(out).toContain("data:image/png;base64,");
    // markdown image syntax with rel-path label
    expect(out).toContain("![diagram.png]");
  });

  it("PDF file → kind=office (markitdown happy path)", async () => {
    await writeFile("raw/doc.pdf", Buffer.from("fake-pdf-bytes"));
    const { output: out } = await runIngestTool({ path: "raw/doc.pdf" }, happyCtx());
    expect(out).toMatch(/^\[ingest_source ok kind=office\]/);
    expect(out).toContain("extracted markdown");
    expect(out).toContain("Source: raw/doc.pdf");
  });

  it("unsupported extension → kind=unsupported", async () => {
    await writeFile("blob.qqq", "weird");
    const { output: out } = await runIngestTool({ path: "blob.qqq" }, happyCtx());
    expect(out).toMatch(/^\[ingest_source error kind=unsupported\]/);
    expect(out).toContain(".qqq");
  });
});

// ── mode overrides ────────────────────────────────────────────────

describe("runIngestTool mode overrides", () => {
  it("mode=text routes any extension through markitdown", async () => {
    // .png would normally go down the image path; mode=text forces office.
    const png = Buffer.from([0x89]);
    await writeFile("forced.png", png);
    const { output: out } = await runIngestTool(
      { path: "forced.png", mode: "text" },
      happyCtx(),
    );
    expect(out).toMatch(/^\[ingest_source ok kind=office\]/);
    expect(out).toContain("extracted markdown");
  });

  it("mode=vision on PDF → kind=office-vision with rasterized images", async () => {
    await writeFile("raw/scan.pdf", Buffer.from("fake-pdf"));
    const { output: out } = await runIngestTool(
      { path: "raw/scan.pdf", mode: "vision" },
      happyCtx(),
    );
    expect(out).toMatch(/^\[ingest_source ok kind=office-vision\]/);
    // Each page is embedded as a markdown image with a labelled alt text.
    expect(out).toContain("![raw/scan.pdf page 1]");
    expect(out).toContain("data:image/png;base64,");
  });

  it("mode=vision on PDF with pdfImageIngest:false → office (markitdown), no rasterize", async () => {
    let rasterCalled = false;
    await writeFile("raw/scan.pdf", Buffer.from("fake-pdf"));
    const { output: out } = await runIngestTool(
      { path: "raw/scan.pdf", mode: "vision" },
      happyCtx({
        pdfImageIngest: false,
        rasterize: async () => {
          rasterCalled = true;
          throw new Error("rasterize should not run");
        },
      }),
    );
    expect(rasterCalled).toBe(false);
    expect(out).toMatch(/^\[ingest_source ok kind=office\]/);
    expect(out).toContain("extracted markdown");
  });

  it("mode=vision on non-PDF → kind=vision-unsupported", async () => {
    await writeFile("raw/slides.pptx", Buffer.from("fake"));
    const { output: out } = await runIngestTool(
      { path: "raw/slides.pptx", mode: "vision" },
      happyCtx(),
    );
    expect(out).toMatch(/^\[ingest_source error kind=vision-unsupported\]/);
    // Should hint at the PPTX-specific workaround.
    expect(out).toContain("convert to PDF");
  });

  it("mode=vision on .png → kind=vision-unsupported with auto hint", async () => {
    await writeFile("img.png", Buffer.from([0x89]));
    const { output: out } = await runIngestTool(
      { path: "img.png", mode: "vision" },
      happyCtx(),
    );
    expect(out).toMatch(/^\[ingest_source error kind=vision-unsupported\]/);
    expect(out).toContain('mode="auto"');
  });
});

// ── venv failure surfaces ─────────────────────────────────────────

describe("runIngestTool venv failures (office path)", () => {
  it("propagates kind=office-no-python", async () => {
    await writeFile("raw/doc.pdf", Buffer.from("x"));
    const { output: out } = await runIngestTool(
      { path: "raw/doc.pdf" },
      happyCtx({
        ensureVenv: async () => ({
          ok: false,
          reason: "no-python",
          message: "python3 was not found on PATH.",
        }),
      }),
    );
    expect(out).toMatch(/^\[ingest_source error kind=office-no-python\]/);
    expect(out).toContain("python3 was not found");
  });

  it("propagates kind=office-install-failed with the underlying message", async () => {
    await writeFile("raw/doc.pdf", Buffer.from("x"));
    const { output: out } = await runIngestTool(
      { path: "raw/doc.pdf" },
      happyCtx({
        ensureVenv: async () => ({
          ok: false,
          reason: "install-failed",
          message: "pip: ERROR: could not find a version that satisfies",
        }),
      }),
    );
    expect(out).toMatch(/^\[ingest_source error kind=office-install-failed\]/);
    expect(out).toContain("could not find a version");
  });

  it("propagates kind=office-venv-failed", async () => {
    await writeFile("raw/doc.pdf", Buffer.from("x"));
    const { output: out } = await runIngestTool(
      { path: "raw/doc.pdf" },
      happyCtx({
        ensureVenv: async () => ({
          ok: false,
          reason: "venv-failed",
          message: "permission denied",
        }),
      }),
    );
    expect(out).toMatch(/^\[ingest_source error kind=office-venv-failed\]/);
  });
});

// ── consent gate ──────────────────────────────────────────────────

describe("runIngestTool venv consent gate (office path)", () => {
  it("skips the prompt when the venv is already ready", async () => {
    await writeFile("raw/doc.pdf", Buffer.from("x"));
    let probeCalls = 0;
    let consentCalls = 0;
    const { output: out } = await runIngestTool(
      { path: "raw/doc.pdf" },
      happyCtx({
        probeVenvNeedsBootstrap: async () => {
          probeCalls++;
          return false;
        },
        requestVenvConsent: async () => {
          consentCalls++;
          return true;
        },
      }),
    );
    expect(probeCalls).toBe(1);
    expect(consentCalls).toBe(0);
    expect(out).toMatch(/^\[ingest_source ok kind=office\]/);
  });

  it("prompts when bootstrap is needed and proceeds on approval", async () => {
    await writeFile("raw/doc.pdf", Buffer.from("x"));
    let consentCalls = 0;
    const { output: out } = await runIngestTool(
      { path: "raw/doc.pdf" },
      happyCtx({
        probeVenvNeedsBootstrap: async () => true,
        requestVenvConsent: async () => {
          consentCalls++;
          return true;
        },
      }),
    );
    expect(consentCalls).toBe(1);
    expect(out).toMatch(/^\[ingest_source ok kind=office\]/);
  });

  it("returns kind=office-consent-declined when the user cancels", async () => {
    await writeFile("raw/doc.pdf", Buffer.from("x"));
    let ensureVenvCalled = false;
    const { output: out } = await runIngestTool(
      { path: "raw/doc.pdf" },
      happyCtx({
        probeVenvNeedsBootstrap: async () => true,
        requestVenvConsent: async () => false,
        ensureVenv: async () => {
          ensureVenvCalled = true;
          return {
            ok: true,
            pythonBin: "/fake/python",
            venvDir: "/fake/venv",
          };
        },
      }),
    );
    expect(out).toMatch(/^\[ingest_source error kind=office-consent-declined\]/);
    expect(out).toContain("declined");
    expect(ensureVenvCalled).toBe(false);
  });

  it("treats probe errors pessimistically and still prompts", async () => {
    await writeFile("raw/doc.pdf", Buffer.from("x"));
    let consentCalls = 0;
    const { output: out } = await runIngestTool(
      { path: "raw/doc.pdf" },
      happyCtx({
        probeVenvNeedsBootstrap: async () => {
          throw new Error("probe exploded");
        },
        requestVenvConsent: async () => {
          consentCalls++;
          return true;
        },
      }),
    );
    expect(consentCalls).toBe(1);
    expect(out).toMatch(/^\[ingest_source ok kind=office\]/);
  });
});

// ── markitdown failure surfaces ───────────────────────────────────

describe("runIngestTool markitdown failure (office path)", () => {
  it("PDF failure → kind=office-failed with vision retry hint", async () => {
    await writeFile("raw/doc.pdf", Buffer.from("x"));
    const { output: out } = await runIngestTool(
      { path: "raw/doc.pdf" },
      happyCtx({
        execCommand: async () => {
          const e = new Error("markitdown: scanned image, no text") as Error & {
            stderr?: string;
          };
          e.stderr = "markitdown: scanned image, no text";
          throw e;
        },
      }),
    );
    expect(out).toMatch(/^\[ingest_source error kind=office-failed\]/);
    expect(out).toContain("scanned image");
    // Vision hint is the pivot the model uses for retry.
    expect(out).toMatch(/mode:\s*"vision"/);
  });

  it("PPTX failure → kind=office-failed with PDF-conversion hint", async () => {
    await writeFile("raw/slides.pptx", Buffer.from("x"));
    const { output: out } = await runIngestTool(
      { path: "raw/slides.pptx" },
      happyCtx({
        execCommand: async () => {
          throw new Error("markitdown couldn't parse pptx");
        },
      }),
    );
    expect(out).toMatch(/^\[ingest_source error kind=office-failed\]/);
    expect(out).toContain("convert");
    expect(out).toContain("PDF");
  });

  it("markitdown timeout → kind=office-timeout", async () => {
    await writeFile("raw/big.pdf", Buffer.from("x"));
    const { output: out } = await runIngestTool(
      { path: "raw/big.pdf" },
      happyCtx({
        execCommand: async () => {
          const e = new Error("timed out") as Error & {
            killed?: boolean;
            signal?: string;
          };
          e.killed = true;
          e.signal = "SIGTERM";
          throw e;
        },
      }),
    );
    expect(out).toMatch(/^\[ingest_source error kind=office-timeout\]/);
  });
});

// ── fileIngest (OpenAI File Upload toggle) ────────────────────────

describe("runIngestTool file-upload mode (ctx.fileIngest=true)", () => {
  /**
   * The OpenAI Chat Completions API only accepts `file_id` on a `file`
   * content part when the underlying upload was an `application/pdf`.
   * It rejects images, PPTX, and anything else with:
   *   "Expected a file with an application/pdf MIME type, but got
   *    unsupported MIME type 'image/jpeg'."
   * So `ingest_source` must branch per file type when the toggle is on:
   *   .pdf       → upload + `file` content block
   *   .png/.jpg…  → inline `image_url` base64 on Chat Completions; on the
   *                 Responses API (ctx.responsesApi=true) upload + image
   *                 `file_id` block, falling back to base64 on failure
   *   .pptx/.ppt → fall back to markitdown (runOffice)
   * These tests pin every branch.
   */

  it("uploads PDF and returns a file content block", async () => {
    await writeFile("raw/doc.pdf", Buffer.from("pdf-bytes"));
    let uploadedPath: string | null = null;
    const result = await runIngestTool(
      { path: "raw/doc.pdf" },
      happyCtx({
        fileIngest: true,
        uploadFile: async (filePath: string) => {
          uploadedPath = filePath;
          return { id: "file-abc123" };
        },
      }),
    );
    expect(uploadedPath).toMatch(/raw\/doc\.pdf$/);
    expect(result.output).toMatch(/^\[ingest_source ok kind=file-upload\]/);
    expect(result.output).toContain("file-abc123");
    expect(result.contentBlocks).toHaveLength(1);
    expect(result.contentBlocks?.[0]).toEqual({
      type: "file",
      file: { file_id: "file-abc123" },
    });
  });

  it("attaches JPG as an image_url content block without calling uploadFile", async () => {
    // Regression: before the fix, this path called uploadFile and built a
    // `file` content block, which the LLM gateway rejected with
    // "Expected application/pdf, but got image/jpeg".
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    await writeFile("raw/photo.jpg", jpg);
    let uploadCalled = false;
    const result = await runIngestTool(
      { path: "raw/photo.jpg" },
      happyCtx({
        fileIngest: true,
        uploadFile: async () => {
          uploadCalled = true;
          return { id: "should-not-be-used" };
        },
      }),
    );
    expect(uploadCalled).toBe(false);
    expect(result.output).toMatch(/^\[ingest_source ok kind=file-upload\]/);
    expect(result.contentBlocks).toHaveLength(1);
    const block = result.contentBlocks?.[0];
    expect(block?.type).toBe("image_url");
    if (block?.type === "image_url") {
      expect(block.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
      expect(block.image_url.detail).toBe("auto");
    }
    // Tool-result text must NOT echo the base64 bytes back — otherwise the
    // model would re-send megabytes on every follow-up turn.
    expect(result.output).not.toContain("data:image/jpeg;base64,");
  });

  it("uploads an image (purpose=vision) and returns a file_id image block on the Responses API", async () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    await writeFile("raw/photo.jpg", jpg);
    let uploadedPath: string | null = null;
    let uploadedPurpose: string | undefined;
    const result = await runIngestTool(
      { path: "raw/photo.jpg" },
      happyCtx({
        fileIngest: true,
        responsesApi: true,
        uploadFile: async (filePath: string, purpose?: string) => {
          uploadedPath = filePath;
          uploadedPurpose = purpose;
          return { id: "file-img-1" };
        },
      }),
    );
    expect(uploadedPath).toMatch(/raw\/photo\.jpg$/);
    expect(uploadedPurpose).toBe("vision");
    expect(result.output).toMatch(/^\[ingest_source ok kind=file-upload\]/);
    expect(result.output).toContain("file-img-1");
    expect(result.contentBlocks).toHaveLength(1);
    const block = result.contentBlocks?.[0];
    expect(block?.type).toBe("image_url");
    if (block?.type === "image_url") {
      expect(block.image_url.file_id).toBe("file-img-1");
      expect(block.image_url.url).toBeUndefined();
      expect(block.image_url.detail).toBe("auto");
    }
  });

  it("falls back to inline base64 when the image upload fails on the Responses API", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile("raw/diagram.png", png);
    const result = await runIngestTool(
      { path: "raw/diagram.png" },
      happyCtx({
        fileIngest: true,
        responsesApi: true,
        uploadFile: async () => {
          throw new Error("network down");
        },
      }),
    );
    expect(result.output).toMatch(/^\[ingest_source ok kind=file-upload\]/);
    expect(result.output).toContain("Fell back to inline base64");
    const block = result.contentBlocks?.[0];
    expect(block?.type).toBe("image_url");
    if (block?.type === "image_url") {
      expect(block.image_url.url).toMatch(/^data:image\/png;base64,/);
      expect(block.image_url.file_id).toBeUndefined();
    }
  });

  it("attaches PNG with the correct image/png MIME", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile("raw/diagram.png", png);
    const result = await runIngestTool(
      { path: "raw/diagram.png" },
      happyCtx({
        fileIngest: true,
        uploadFile: async () => {
          throw new Error("uploadFile must not run for images");
        },
      }),
    );
    expect(result.output).toMatch(/^\[ingest_source ok kind=file-upload\]/);
    const block = result.contentBlocks?.[0];
    expect(block?.type).toBe("image_url");
    if (block?.type === "image_url") {
      expect(block.image_url.url).toMatch(/^data:image\/png;base64,/);
    }
  });

  it("falls back to markitdown for PPTX (Chat Completions can't take file_id for pptx)", async () => {
    await writeFile("raw/slides.pptx", Buffer.from("fake-pptx"));
    let uploadCalled = false;
    const result = await runIngestTool(
      { path: "raw/slides.pptx" },
      happyCtx({
        fileIngest: true,
        uploadFile: async () => {
          uploadCalled = true;
          return { id: "should-not-be-used" };
        },
      }),
    );
    expect(uploadCalled).toBe(false);
    expect(result.output).toMatch(/^\[ingest_source ok kind=office\]/);
    expect(result.output).toContain("extracted markdown");
    expect(result.contentBlocks).toBeUndefined();
  });

  it("falls back to markitdown for legacy .ppt as well", async () => {
    await writeFile("raw/legacy.ppt", Buffer.from("fake-ppt"));
    const result = await runIngestTool(
      { path: "raw/legacy.ppt" },
      happyCtx({
        fileIngest: true,
        uploadFile: async () => {
          throw new Error("uploadFile must not run for .ppt");
        },
      }),
    );
    expect(result.output).toMatch(/^\[ingest_source ok kind=office\]/);
  });

  // Regression: a previous fix routed images and pptx but xlsx still
  // crashed silently if the toggle later started uploading every office
  // format. Pin the contract that every office extension falls back to
  // markitdown when the toggle is on — never tries to upload.
  it("falls back to markitdown for XLSX (Chat Completions can't take file_id for xlsx)", async () => {
    await writeFile("raw/sheet.xlsx", Buffer.from("fake-xlsx"));
    let uploadCalled = false;
    const result = await runIngestTool(
      { path: "raw/sheet.xlsx" },
      happyCtx({
        fileIngest: true,
        uploadFile: async () => {
          uploadCalled = true;
          return { id: "should-not-be-used" };
        },
      }),
    );
    expect(uploadCalled).toBe(false);
    expect(result.output).toMatch(/^\[ingest_source ok kind=office\]/);
    expect(result.output).toContain("extracted markdown");
    expect(result.contentBlocks).toBeUndefined();
  });

  it("falls back to markitdown for legacy .xls as well", async () => {
    await writeFile("raw/legacy.xls", Buffer.from("fake-xls"));
    const result = await runIngestTool(
      { path: "raw/legacy.xls" },
      happyCtx({
        fileIngest: true,
        uploadFile: async () => {
          throw new Error("uploadFile must not run for .xls");
        },
      }),
    );
    expect(result.output).toMatch(/^\[ingest_source ok kind=office\]/);
  });

  it("falls back to markitdown for DOCX (and other office formats)", async () => {
    // Covers .docx/.doc/.epub/.rtf via a representative — they all share
    // the same OFFICE_EXTENSIONS guard, so testing one pins the contract.
    await writeFile("raw/report.docx", Buffer.from("fake-docx"));
    const result = await runIngestTool(
      { path: "raw/report.docx" },
      happyCtx({
        fileIngest: true,
        uploadFile: async () => {
          throw new Error("uploadFile must not run for .docx");
        },
      }),
    );
    expect(result.output).toMatch(/^\[ingest_source ok kind=office\]/);
  });

  it("text files still use the normal text-read path when fileIngest is on", async () => {
    await writeFile("notes.md", "# hello");
    const result = await runIngestTool(
      { path: "notes.md" },
      happyCtx({
        fileIngest: true,
        uploadFile: async () => {
          throw new Error("uploadFile must not run for text");
        },
      }),
    );
    expect(result.output).toMatch(/^\[ingest_source ok kind=text\]/);
    expect(result.contentBlocks).toBeUndefined();
  });

  it("falls back to markitdown when uploadFile fails for PDFs", async () => {
    await writeFile("raw/doc.pdf", Buffer.from("x"));
    const result = await runIngestTool(
      { path: "raw/doc.pdf" },
      happyCtx({
        fileIngest: true,
        uploadFile: async () => {
          throw new Error("network timeout");
        },
      }),
    );
    expect(result.output).toMatch(/^\[ingest_source ok kind=office\]/);
    expect(result.output).toContain("network timeout");
    expect(result.output).toContain("Fell back to local markitdown");
    expect(result.output).toContain("extracted markdown");
    expect(result.contentBlocks).toBeUndefined();
  });

  it("mode=text bypasses uploadFile for PDFs when fileIngest is on", async () => {
    await writeFile("raw/doc.pdf", Buffer.from("x"));
    let uploadCalled = false;
    const result = await runIngestTool(
      { path: "raw/doc.pdf", mode: "text" },
      happyCtx({
        fileIngest: true,
        uploadFile: async () => {
          uploadCalled = true;
          return { id: "file-should-not-run" };
        },
      }),
    );
    expect(uploadCalled).toBe(false);
    expect(result.output).toMatch(/^\[ingest_source ok kind=office\]/);
    expect(result.contentBlocks).toBeUndefined();
  });

  it("mode=vision bypasses uploadFile for PDFs when fileIngest is on", async () => {
    await writeFile("raw/scan.pdf", Buffer.from("fake-pdf"));
    let uploadCalled = false;
    const result = await runIngestTool(
      { path: "raw/scan.pdf", mode: "vision" },
      happyCtx({
        fileIngest: true,
        uploadFile: async () => {
          uploadCalled = true;
          return { id: "file-should-not-run" };
        },
      }),
    );
    expect(uploadCalled).toBe(false);
    expect(result.output).toMatch(/^\[ingest_source ok kind=office-vision\]/);
    expect(result.contentBlocks).toBeUndefined();
  });

  it("surfaces image read failures with kind=file-upload", async () => {
    // No file written → ENOENT before runImageBlock can read.
    const result = await runIngestTool(
      { path: "raw/missing.jpg" },
      happyCtx({ fileIngest: true, uploadFile: async () => ({ id: "x" }) }),
    );
    // The up-front existence check fires first, so we get kind=not-found
    // rather than kind=file-upload. Pinning that contract.
    expect(result.output).toMatch(/^\[ingest_source error kind=not-found\]/);
  });

  it("falls back to normal dispatch when fileIngest is true but uploadFile is unset (no LLM service)", async () => {
    // ChatService passes uploadFile only when it has an LLM service.
    // Without it, PDFs should still ingest via markitdown rather than
    // raising "service unavailable" — the toggle is informational at
    // that point, not a hard requirement.
    await writeFile("raw/doc.pdf", Buffer.from("x"));
    const result = await runIngestTool(
      { path: "raw/doc.pdf" },
      happyCtx({ fileIngest: true, uploadFile: undefined }),
    );
    expect(result.output).toMatch(/^\[ingest_source ok kind=office\]/);
  });
});

// ── responsesApi (OpenAI Responses API) ──────────────────────────

describe("runIngestTool file-upload mode with responsesApi=true", () => {
  /**
   * The Responses API's `input_file` content part accepts every office
   * extension we ship — pptx, xlsx, docx, etc. — not just PDF. When the
   * user has both "OpenAI File Upload" enabled AND the endpoint is
   * OpenAI (i.e. the chat transport switches to /v1/responses), the
   * dispatch in `ingest_source` should upload every OFFICE_EXTENSIONS
   * file via the Files API and emit a `type: "file"` content block —
   * never fall back to markitdown.
   *
   * These tests pin that contract. The Chat-Completions fallback (which
   * still gates non-PDFs through markitdown) is covered by the suite
   * above.
   */

  it("uploads PPTX via Files API and emits a file content block", async () => {
    await writeFile("raw/slides.pptx", Buffer.from("fake-pptx"));
    let uploadedPath: string | null = null;
    const result = await runIngestTool(
      { path: "raw/slides.pptx" },
      happyCtx({
        fileIngest: true,
        responsesApi: true,
        uploadFile: async (filePath: string) => {
          uploadedPath = filePath;
          return { id: "file-pptx-1" };
        },
      }),
    );
    expect(uploadedPath).toMatch(/raw\/slides\.pptx$/);
    expect(result.output).toMatch(/^\[ingest_source ok kind=file-upload\]/);
    expect(result.output).toContain("file-pptx-1");
    expect(result.contentBlocks).toEqual([
      { type: "file", file: { file_id: "file-pptx-1" } },
    ]);
  });

  it("uploads XLSX via Files API (spreadsheet augmentation on the server side)", async () => {
    await writeFile("raw/sheet.xlsx", Buffer.from("fake-xlsx"));
    const result = await runIngestTool(
      { path: "raw/sheet.xlsx" },
      happyCtx({
        fileIngest: true,
        responsesApi: true,
        uploadFile: async () => ({ id: "file-xlsx-2" }),
      }),
    );
    expect(result.output).toMatch(/^\[ingest_source ok kind=file-upload\]/);
    expect(result.contentBlocks).toEqual([
      { type: "file", file: { file_id: "file-xlsx-2" } },
    ]);
  });

  it("uploads DOCX via Files API", async () => {
    await writeFile("raw/report.docx", Buffer.from("fake-docx"));
    const result = await runIngestTool(
      { path: "raw/report.docx" },
      happyCtx({
        fileIngest: true,
        responsesApi: true,
        uploadFile: async () => ({ id: "file-docx-3" }),
      }),
    );
    expect(result.output).toMatch(/^\[ingest_source ok kind=file-upload\]/);
    expect(result.contentBlocks).toEqual([
      { type: "file", file: { file_id: "file-docx-3" } },
    ]);
  });

  it("still uploads PDF via Files API (unchanged from the Chat-Completions path)", async () => {
    await writeFile("raw/doc.pdf", Buffer.from("fake-pdf"));
    const result = await runIngestTool(
      { path: "raw/doc.pdf" },
      happyCtx({
        fileIngest: true,
        responsesApi: true,
        uploadFile: async () => ({ id: "file-pdf-4" }),
      }),
    );
    expect(result.output).toMatch(/^\[ingest_source ok kind=file-upload\]/);
    expect(result.contentBlocks).toEqual([
      { type: "file", file: { file_id: "file-pdf-4" } },
    ]);
  });

  it("uploads images by file_id when responsesApi is on (upload-first, base64 fallback)", async () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    await writeFile("raw/photo.jpg", jpg);
    let uploadCalled = false;
    const result = await runIngestTool(
      { path: "raw/photo.jpg" },
      happyCtx({
        fileIngest: true,
        responsesApi: true,
        uploadFile: async () => {
          uploadCalled = true;
          return { id: "file-img-resp" };
        },
      }),
    );
    expect(uploadCalled).toBe(true);
    expect(result.output).toMatch(/^\[ingest_source ok kind=file-upload\]/);
    const block = result.contentBlocks?.[0];
    expect(block?.type).toBe("image_url");
    if (block?.type === "image_url") {
      expect(block.image_url.file_id).toBe("file-img-resp");
      expect(block.image_url.url).toBeUndefined();
    }
  });

  it("falls back to markitdown when upload fails for office formats too", async () => {
    await writeFile("raw/slides.pptx", Buffer.from("fake"));
    const result = await runIngestTool(
      { path: "raw/slides.pptx" },
      happyCtx({
        fileIngest: true,
        responsesApi: true,
        uploadFile: async () => {
          throw new Error("413 payload too large");
        },
      }),
    );
    expect(result.output).toMatch(/^\[ingest_source ok kind=office\]/);
    expect(result.output).toContain("413 payload too large");
    expect(result.output).toContain("Fell back to local markitdown");
    expect(result.contentBlocks).toBeUndefined();
  });

  it("falls back to markitdown when responsesApi is true but uploadFile is missing", async () => {
    // The responsesApi flag without an upload channel is a misconfiguration
    // (no LLM service wired) — we don't want to error out, we want to keep
    // ingesting via the local fallback so the user still gets text content.
    await writeFile("raw/slides.pptx", Buffer.from("fake"));
    const result = await runIngestTool(
      { path: "raw/slides.pptx" },
      happyCtx({ fileIngest: true, responsesApi: true, uploadFile: undefined }),
    );
    expect(result.output).toMatch(/^\[ingest_source ok kind=office\]/);
  });

  it("text files still use the plain text-read path under responsesApi", async () => {
    await writeFile("notes.md", "# hello");
    const result = await runIngestTool(
      { path: "notes.md" },
      happyCtx({
        fileIngest: true,
        responsesApi: true,
        uploadFile: async () => {
          throw new Error("uploadFile must not run for text");
        },
      }),
    );
    expect(result.output).toMatch(/^\[ingest_source ok kind=text\]/);
    expect(result.contentBlocks).toBeUndefined();
  });
});

// ── vision failure surfaces ───────────────────────────────────────

describe("runIngestTool vision failures", () => {
  it("rasterize throws → kind=vision-rasterize", async () => {
    await writeFile("raw/bad.pdf", Buffer.from("x"));
    const { output: out } = await runIngestTool(
      { path: "raw/bad.pdf", mode: "vision" },
      happyCtx({
        rasterize: async () => {
          throw new Error("InvalidPDFException");
        },
      }),
    );
    expect(out).toMatch(/^\[ingest_source error kind=vision-rasterize\]/);
    expect(out).toContain("InvalidPDFException");
    // We point at the typical cause so the model's user-message is helpful.
    expect(out).toMatch(/corrupt|password/);
  });

  it("rasterize returns empty pages → kind=vision-empty", async () => {
    await writeFile("raw/empty.pdf", Buffer.from("x"));
    const { output: out } = await runIngestTool(
      { path: "raw/empty.pdf", mode: "vision" },
      happyCtx({
        rasterize: async () => ({ pages: [], totalPages: 0, truncated: false }),
      }),
    );
    expect(out).toMatch(/^\[ingest_source error kind=vision-empty\]/);
  });

  it("vision result includes truncation note when pages > cap", async () => {
    await writeFile("raw/long.pdf", Buffer.from("x"));
    const { output: out } = await runIngestTool(
      { path: "raw/long.pdf", mode: "vision" },
      happyCtx({
        rasterize: async () => ({
          pages: [
            {
              pageNumber: 1,
              width: 100,
              height: 100,
              png: Buffer.from("p1"),
            },
          ],
          totalPages: 999,
          truncated: true,
        }),
      }),
    );
    expect(out).toMatch(/^\[ingest_source ok kind=office-vision\]/);
    expect(out).toContain("truncated");
    expect(out).toContain("999");
  });
});

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
    const out = await runIngestTool(null, happyCtx());
    expect(out).toMatch(/^\[ingest_source error kind=args\]/);
  });

  it("rejects missing path with kind=args header", async () => {
    const out = await runIngestTool({ mode: "auto" }, happyCtx());
    expect(out).toMatch(/^\[ingest_source error kind=args\]/);
    expect(out).toMatch(/path must be a string/);
  });

  it("rejects unknown mode with kind=args header", async () => {
    const out = await runIngestTool(
      { path: "x.txt", mode: "magic" },
      happyCtx(),
    );
    expect(out).toMatch(/^\[ingest_source error kind=args\]/);
    expect(out).toMatch(/auto.*text.*vision/);
  });

  it("rejects path-escape with kind=path header", async () => {
    const out = await runIngestTool({ path: "../etc/passwd" }, happyCtx());
    expect(out).toMatch(/^\[ingest_source error kind=path\]/);
  });

  it("returns kind=not-found for missing files", async () => {
    const out = await runIngestTool({ path: "raw/nope.pdf" }, happyCtx());
    expect(out).toMatch(/^\[ingest_source error kind=not-found\]/);
    expect(out).toContain("raw/nope.pdf");
  });
});

// ── auto dispatch by extension ────────────────────────────────────

describe("runIngestTool auto dispatch", () => {
  it("text file → kind=text + content body", async () => {
    await writeFile("notes.md", "# hello\nworld");
    const out = await runIngestTool({ path: "notes.md" }, happyCtx());
    expect(out).toMatch(/^\[ingest_source ok kind=text\]/);
    expect(out).toContain("# hello");
    expect(out).toContain("world");
  });

  it("text file with no extension → kind=text (fallback)", async () => {
    await writeFile("README", "plain readme");
    const out = await runIngestTool({ path: "README" }, happyCtx());
    expect(out).toMatch(/^\[ingest_source ok kind=text\]/);
    expect(out).toContain("plain readme");
  });

  it("text file beyond TEXT_CHAR_LIMIT → truncation note", async () => {
    const big = "x".repeat(TEXT_CHAR_LIMIT + 100);
    await writeFile("big.txt", big);
    const out = await runIngestTool({ path: "big.txt" }, happyCtx());
    expect(out).toContain("truncated");
    expect(out).toContain(`truncated to ${TEXT_CHAR_LIMIT}`);
  });

  it("image file → kind=image + data URL", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile("diagram.png", png);
    const out = await runIngestTool({ path: "diagram.png" }, happyCtx());
    expect(out).toMatch(/^\[ingest_source ok kind=image\]/);
    expect(out).toContain("data:image/png;base64,");
    // markdown image syntax with rel-path label
    expect(out).toContain("![diagram.png]");
  });

  it("PDF file → kind=office (markitdown happy path)", async () => {
    await writeFile("raw/doc.pdf", Buffer.from("fake-pdf-bytes"));
    const out = await runIngestTool({ path: "raw/doc.pdf" }, happyCtx());
    expect(out).toMatch(/^\[ingest_source ok kind=office\]/);
    expect(out).toContain("extracted markdown");
    expect(out).toContain("Source: raw/doc.pdf");
  });

  it("unsupported extension → kind=unsupported", async () => {
    await writeFile("blob.qqq", "weird");
    const out = await runIngestTool({ path: "blob.qqq" }, happyCtx());
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
    const out = await runIngestTool(
      { path: "forced.png", mode: "text" },
      happyCtx(),
    );
    expect(out).toMatch(/^\[ingest_source ok kind=office\]/);
    expect(out).toContain("extracted markdown");
  });

  it("mode=vision on PDF → kind=office-vision with rasterized images", async () => {
    await writeFile("raw/scan.pdf", Buffer.from("fake-pdf"));
    const out = await runIngestTool(
      { path: "raw/scan.pdf", mode: "vision" },
      happyCtx(),
    );
    expect(out).toMatch(/^\[ingest_source ok kind=office-vision\]/);
    // Each page is embedded as a markdown image with a labelled alt text.
    expect(out).toContain("![raw/scan.pdf page 1]");
    expect(out).toContain("data:image/png;base64,");
  });

  it("mode=vision on non-PDF → kind=vision-unsupported", async () => {
    await writeFile("raw/slides.pptx", Buffer.from("fake"));
    const out = await runIngestTool(
      { path: "raw/slides.pptx", mode: "vision" },
      happyCtx(),
    );
    expect(out).toMatch(/^\[ingest_source error kind=vision-unsupported\]/);
    // Should hint at the PPTX-specific workaround.
    expect(out).toContain("convert to PDF");
  });

  it("mode=vision on .png → kind=vision-unsupported with auto hint", async () => {
    await writeFile("img.png", Buffer.from([0x89]));
    const out = await runIngestTool(
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
    const out = await runIngestTool(
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
    const out = await runIngestTool(
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
    const out = await runIngestTool(
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

// ── markitdown failure surfaces ───────────────────────────────────

describe("runIngestTool markitdown failure (office path)", () => {
  it("PDF failure → kind=office-failed with vision retry hint", async () => {
    await writeFile("raw/doc.pdf", Buffer.from("x"));
    const out = await runIngestTool(
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
    const out = await runIngestTool(
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
    const out = await runIngestTool(
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

// ── vision failure surfaces ───────────────────────────────────────

describe("runIngestTool vision failures", () => {
  it("rasterize throws → kind=vision-rasterize", async () => {
    await writeFile("raw/bad.pdf", Buffer.from("x"));
    const out = await runIngestTool(
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
    const out = await runIngestTool(
      { path: "raw/empty.pdf", mode: "vision" },
      happyCtx({
        rasterize: async () => ({ pages: [], totalPages: 0, truncated: false }),
      }),
    );
    expect(out).toMatch(/^\[ingest_source error kind=vision-empty\]/);
  });

  it("vision result includes truncation note when pages > cap", async () => {
    await writeFile("raw/long.pdf", Buffer.from("x"));
    const out = await runIngestTool(
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

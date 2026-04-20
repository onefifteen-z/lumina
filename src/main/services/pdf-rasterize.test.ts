import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { rasterizePdfToPngs, __setPdfjsLoaderForTesting } from "./pdf-rasterize";

/**
 * These tests exercise the real pdfjs + napi-canvas pipeline against a
 * tiny synthesized PDF. They don't hit the network and complete in well
 * under a second per case, so they're cheap enough to run on every CI.
 *
 * Vitest's worker doesn't wire up the host import() callback for our
 * eval-based dynamic loader, so we preload pdfjs via `createRequire`
 * (Node 20+ supports require()-ing ESM in worker contexts via this path)
 * and inject it through the testing override hook.
 */

beforeAll(async () => {
  // Resolve pdfjs through a real `await import()` — Vitest supports this
  // (it's only the eval()-wrapped form used in production-CJS that fails
  // under Vitest's worker), so the loaded module matches what the real
  // Electron main process sees at runtime.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  __setPdfjsLoaderForTesting(async () => pdfjs);
});

afterAll(() => {
  __setPdfjsLoaderForTesting(null);
});

async function buildPdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([400, 300]);
    page.drawText(`Page ${i}`, {
      x: 50,
      y: 200,
      size: 40,
      font,
      color: rgb(0, 0, 0),
    });
  }
  return doc.save();
}

describe("rasterizePdfToPngs", () => {
  it("renders every page when under the cap", async () => {
    const pdf = await buildPdf(3);
    const result = await rasterizePdfToPngs(pdf, { dpi: 72, maxPages: 50 });

    expect(result.totalPages).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.pages).toHaveLength(3);
    for (const page of result.pages) {
      // PNG magic header: 89 50 4E 47 ("\x89PNG")
      expect(page.png.subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
      expect(page.width).toBeGreaterThan(0);
      expect(page.height).toBeGreaterThan(0);
    }
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
  });

  it("truncates and flags when total pages exceed maxPages", async () => {
    const pdf = await buildPdf(5);
    const result = await rasterizePdfToPngs(pdf, { dpi: 72, maxPages: 2 });

    expect(result.totalPages).toBe(5);
    expect(result.pages).toHaveLength(2);
    expect(result.truncated).toBe(true);
    // Truncation always keeps the first N pages — confirms ordering and
    // makes the user-visible "first N pages" warning accurate.
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 2]);
  });

  it("clamps oversized pages via maxPageDimension", async () => {
    const pdf = await buildPdf(1);
    // 400x300 PDF user units at scale=4 → 1600x1200, then clamp to 800.
    const result = await rasterizePdfToPngs(pdf, {
      dpi: 72 * 4,
      maxPageDimension: 800,
    });
    expect(result.pages).toHaveLength(1);
    expect(Math.max(result.pages[0].width, result.pages[0].height)).toBe(800);
  });
});

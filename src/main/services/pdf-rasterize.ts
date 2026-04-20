/**
 * Rasterize PDF pages → PNG buffers using pdfjs-dist + @napi-rs/canvas.
 *
 * Why this exists: our LLM gateway blocks `POST /v1/files`, so we cannot
 * upload PDFs as files. Instead, ingest renders each page to a PNG and
 * sends them as `image_url` content blocks (which the chat-completions
 * endpoint accepts).
 *
 * Tunables:
 *   - DPI (default 96) → pdfjs `scale = dpi / 72`
 *   - MAX_PAGE_DIMENSION caps the longer edge to keep base64 payloads
 *     under control even for legal/poster-sized pages.
 *   - MAX_PAGES truncates very large PDFs; callers should surface a
 *     warning when this fires.
 *
 * Note on dynamic imports: pdfjs-dist v4 ships ESM-only, but the main
 * process is compiled to CJS. Using `await import()` (which TypeScript
 * preserves through CJS as a real dynamic import) is the supported
 * escape hatch.
 */

import * as path from "path";
import { createCanvas } from "@napi-rs/canvas";
import { pathToFileURL } from "url";

export interface RasterizedPage {
  pageNumber: number;
  width: number;
  height: number;
  png: Buffer;
}

export interface RasterizeOptions {
  /** Target rendering DPI. Default 96 balances readability and payload size. */
  dpi?: number;
  /** Cap on the longer edge of the rendered page (post-rasterization). */
  maxPageDimension?: number;
  /** Hard cap on number of pages to render (vision token budget guard). */
  maxPages?: number;
}

export interface RasterizeResult {
  pages: RasterizedPage[];
  totalPages: number;
  /** True when totalPages > maxPages — caller should warn the user. */
  truncated: boolean;
}

const DEFAULT_DPI = 96;
const DEFAULT_MAX_DIM = 1200;
const DEFAULT_MAX_PAGES = 50;

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/**
 * pdfjs-dist v4 is ESM-only. Our main process compiles to CommonJS, and
 * tsc lowers `await import(...)` into `require(...)` — which then crashes
 * with ERR_REQUIRE_ESM at runtime. Going through `eval` keeps the
 * dynamic import opaque to the TS transform; in the real Electron main
 * process this resolves the ESM module correctly.
 *
 * Test override: Vitest's worker runs in a vm context where `eval`'s
 * dynamic import host callback is not wired up, so tests inject a
 * pre-loaded module via `__setPdfjsLoaderForTesting`.
 */
let pdfjsLoaderOverride: (() => Promise<PdfjsModule>) | null = null;

async function loadPdfjs(): Promise<PdfjsModule> {
  if (pdfjsLoaderOverride) return pdfjsLoaderOverride();
  return (await eval(
    'import("pdfjs-dist/legacy/build/pdf.mjs")',
  )) as PdfjsModule;
}

/** @internal — for tests only; bypasses the eval()-based ESM loader. */
export function __setPdfjsLoaderForTesting(
  loader: (() => Promise<PdfjsModule>) | null,
): void {
  pdfjsLoaderOverride = loader;
}

/**
 * Render every page of a PDF to a PNG buffer. Pages beyond `maxPages` are
 * silently dropped, but `truncated` will be `true` so the caller can show
 * a warning.
 */
export async function rasterizePdfToPngs(
  pdfBytes: Uint8Array,
  options: RasterizeOptions = {},
): Promise<RasterizeResult> {
  const dpi = options.dpi ?? DEFAULT_DPI;
  const maxDim = options.maxPageDimension ?? DEFAULT_MAX_DIM;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  const pdfjs = await loadPdfjs();
  // pdfjs needs a workerSrc URL even when running on the main thread —
  // it spins up a "fake worker" by loading this file. Resolve via
  // require.resolve so this works in both dev (cwd-based) and packaged
  // (asar-extracted) installs.
  //
  // In a packaged Electron app, `require.resolve` returns a path inside
  // `app.asar`, but pdfjs loads the worker by URL (not via `fs`) and
  // `file://` URLs cannot read inside asar. We rewrite to
  // `app.asar.unpacked` — `asarUnpack` in package.json ensures the worker
  // file is mirrored there.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const resolvedWorker = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const workerPath = resolvedWorker.includes(`${path.sep}app.asar${path.sep}`)
    ? resolvedWorker.replace(
        `${path.sep}app.asar${path.sep}`,
        `${path.sep}app.asar.unpacked${path.sep}`,
      )
    : resolvedWorker;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pdfjs as any).GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).toString();

  const loadingTask = pdfjs.getDocument({
    data: pdfBytes,
    // Don't try to fetch system fonts in Electron — we render embedded fonts
    // only. Missing-glyph warnings are tolerable; crashing on missing system
    // fonts is not.
    disableFontFace: true,
    useSystemFonts: false,
    // Suppress pdfjs's verbose logging.
    verbosity: 0,
  });

  const doc = await loadingTask.promise;
  const totalPages = doc.numPages;
  const pageCount = Math.min(totalPages, maxPages);
  const pages: RasterizedPage[] = [];

  try {
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      try {
        // Compute initial scale from DPI, then clamp to maxDim. PDF
        // user-space units are 1/72 inch, so scale = dpi / 72.
        const baseViewport = page.getViewport({ scale: dpi / 72 });
        const longest = Math.max(baseViewport.width, baseViewport.height);
        const clampScale =
          longest > maxDim ? maxDim / longest : 1;
        const viewport = page.getViewport({ scale: (dpi / 72) * clampScale });

        const width = Math.ceil(viewport.width);
        const height = Math.ceil(viewport.height);

        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext("2d");

        // pdfjs expects a 2D context with the standard Canvas API; @napi-rs
        // canvas matches the browser shape closely enough for render() to
        // succeed. The `as any` shields the type system from minor
        // differences in optional fields.
        await page.render({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          canvasContext: ctx as any,
          viewport,
          // pdfjs v4 added a typed "background" knob; keep default white.
        }).promise;

        const png = canvas.toBuffer("image/png");
        pages.push({ pageNumber: i, width, height, png });
      } finally {
        // Free per-page worker resources — pdfjs accumulates without this.
        page.cleanup();
      }
    }
  } finally {
    // Close the document; pdfjs holds onto byte buffers otherwise.
    await doc.destroy();
  }

  return {
    pages,
    totalPages,
    truncated: totalPages > pageCount,
  };
}

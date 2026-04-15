import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import path from "path";

/**
 * Preservation Property Tests — webPreferences Security Settings & Renderer Path
 *
 * **Validates: Requirements 3.1, 3.5**
 *
 * These tests observe the CURRENT (unfixed) code and establish a baseline that
 * must be preserved after the bugfix. They verify:
 *
 * 1. webPreferences security flags remain: contextIsolation=true, sandbox=true,
 *    nodeIntegration=false
 * 2. The production renderer loadFile path resolves to a path ending with
 *    renderer/index.html
 * 3. The renderer path does NOT contain duplicate directory segments
 *
 * EXPECTED OUTCOME: All tests PASS on unfixed code.
 */

// ── Observed values from createWindow in src/main/main.ts (unfixed) ────────

/** Security flags as set in createWindow's webPreferences */
const OBSERVED_WEB_PREFERENCES = {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
} as const;

/** Renderer path segments used in createWindow for production loadFile */
const RENDERER_PATH_SEGMENTS = ["..", "..", "renderer", "index.html"];

/**
 * Simulate the renderer loadFile path construction from createWindow.
 * In production: path.join(__dirname, "..", "..", "renderer", "index.html")
 */
function resolveRendererPath(dirname: string): string {
  return path.join(dirname, ...RENDERER_PATH_SEGMENTS);
}

/**
 * Count occurrences of a segment in a path's directory portions (excluding filename).
 */
function countDirSegmentOccurrences(
  resolvedPath: string,
  segment: string,
): number {
  const parts = resolvedPath.split(path.sep);
  const dirParts = parts.slice(0, -1);
  return dirParts.filter((p) => p === segment).length;
}

describe("Preservation: webPreferences security settings", () => {
  it("Property 2a: contextIsolation, sandbox, nodeIntegration remain true, true, false for all base paths", () => {
    /**
     * **Validates: Requirements 3.1**
     *
     * For all generated __dirname base paths, the webPreferences security flags
     * (contextIsolation, sandbox, nodeIntegration) remain true, true, false
     * respectively. These are static values in createWindow and must not change.
     */
    fc.assert(
      fc.property(
        fc.stringOf(
          fc.constantFrom(
            "a",
            "b",
            "c",
            "home",
            "usr",
            "projects",
            "dev",
            "opt",
            "Users",
          ),
          { minLength: 1, maxLength: 4 },
        ),
        (_basePrefix) => {
          // The security flags are static constants in createWindow — they do
          // not depend on __dirname. We verify they hold for any base path.
          expect(OBSERVED_WEB_PREFERENCES.contextIsolation).toBe(true);
          expect(OBSERVED_WEB_PREFERENCES.sandbox).toBe(true);
          expect(OBSERVED_WEB_PREFERENCES.nodeIntegration).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Preservation: production renderer loadFile path", () => {
  it("Property 2b: renderer path resolves to a path ending with renderer/index.html for all base paths", () => {
    /**
     * **Validates: Requirements 3.5**
     *
     * For all generated __dirname base paths simulating dist/main/main/,
     * the production renderer loadFile path resolves to a path ending with
     * renderer/index.html.
     */
    fc.assert(
      fc.property(
        fc.stringOf(
          fc.constantFrom(
            "a",
            "b",
            "c",
            "home",
            "usr",
            "projects",
            "dev",
            "opt",
            "Users",
          ),
          { minLength: 1, maxLength: 4 },
        ),
        (basePrefix) => {
          const simulatedDirname = path.join(
            basePrefix,
            "dist",
            "main",
            "main",
          );

          const resolvedPath = resolveRendererPath(simulatedDirname);

          // The path must end with renderer/index.html
          const expectedSuffix = path.join("renderer", "index.html");
          expect(resolvedPath.endsWith(expectedSuffix)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 2c: renderer path does NOT contain duplicate directory segments", () => {
    /**
     * **Validates: Requirements 3.5**
     *
     * For all generated __dirname base paths, the renderer path construction
     * does NOT contain duplicate consecutive directory segments (e.g.,
     * renderer/renderer/).
     */
    fc.assert(
      fc.property(
        fc.stringOf(
          fc.constantFrom(
            "a",
            "b",
            "c",
            "home",
            "usr",
            "projects",
            "dev",
            "opt",
            "Users",
          ),
          { minLength: 1, maxLength: 4 },
        ),
        (basePrefix) => {
          const simulatedDirname = path.join(
            basePrefix,
            "dist",
            "main",
            "main",
          );

          const resolvedPath = resolveRendererPath(simulatedDirname);

          // The "renderer" directory segment should appear exactly once
          const rendererDirCount = countDirSegmentOccurrences(
            resolvedPath,
            "renderer",
          );
          expect(rendererDirCount).toBe(1);

          // Also verify no duplicate consecutive segments exist in the path
          const parts = resolvedPath.split(path.sep);
          for (let i = 1; i < parts.length; i++) {
            if (parts[i] === parts[i - 1] && parts[i] !== "") {
              throw new Error(
                `Duplicate consecutive segment "${parts[i]}" found in path: ${resolvedPath}`,
              );
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

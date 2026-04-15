import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import path from "path";

/**
 * Bug Condition Exploration Test — Duplicate Preload Path Segment
 *
 * Validates: Requirements 1.1, 2.1
 *
 * The createWindow function in src/main/main.ts constructs the preload path as:
 *   path.join(__dirname, "..", "..", "preload", "preload", "preload.js")
 *
 * This test extracts the same path segments and asserts the EXPECTED (correct)
 * behavior: the resolved path should contain exactly one "preload" directory
 * segment (excluding the filename) and end with dist/preload/preload.js.
 *
 * On UNFIXED code this test MUST FAIL — failure confirms the bug exists.
 */

// These are the exact path segments used in createWindow (unfixed code)
const BUGGY_PRELOAD_SEGMENTS = ["..", "..", "preload", "preload", "preload.js"];

/**
 * Count occurrences of a segment in a path's directory portions (excluding filename).
 */
function countDirSegmentOccurrences(
  resolvedPath: string,
  segment: string,
): number {
  const parts = resolvedPath.split(path.sep);
  // Exclude the last part (filename)
  const dirParts = parts.slice(0, -1);
  return dirParts.filter((p) => p === segment).length;
}

describe("Bug Condition: Preload path duplicate segment", () => {
  it("Property 1: resolved preload path should contain exactly one 'preload' directory segment", () => {
    /**
     * **Validates: Requirements 1.1, 2.1**
     *
     * Generate arbitrary base directory paths simulating __dirname within
     * dist/main/main/ and verify the preload path has exactly one "preload"
     * directory segment (excluding the filename).
     */
    fc.assert(
      fc.property(
        // Generate an arbitrary base path prefix to simulate different project roots
        fc.stringOf(
          fc.constantFrom("a", "b", "c", "home", "usr", "projects", "dev"),
          { minLength: 1, maxLength: 3 },
        ),
        (basePrefix) => {
          // Simulate __dirname as <basePrefix>/dist/main/main
          const simulatedDirname = path.join(
            basePrefix,
            "dist",
            "main",
            "main",
          );

          // Resolve the preload path using the same segments as createWindow
          const resolvedPath = path.join(
            simulatedDirname,
            ...BUGGY_PRELOAD_SEGMENTS,
          );

          // ASSERTION 1: The directory portion should contain exactly ONE "preload" segment
          const preloadDirCount = countDirSegmentOccurrences(
            resolvedPath,
            "preload",
          );
          expect(preloadDirCount).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 1b: resolved preload path should end with dist/preload/preload.js", () => {
    /**
     * **Validates: Requirements 2.1**
     *
     * For any simulated __dirname within dist/main/main/, the resolved preload
     * path should end with the canonical dist/preload/preload.js suffix.
     */
    fc.assert(
      fc.property(
        fc.stringOf(
          fc.constantFrom("a", "b", "c", "home", "usr", "projects", "dev"),
          { minLength: 1, maxLength: 3 },
        ),
        (basePrefix) => {
          const simulatedDirname = path.join(
            basePrefix,
            "dist",
            "main",
            "main",
          );

          const resolvedPath = path.join(
            simulatedDirname,
            ...BUGGY_PRELOAD_SEGMENTS,
          );

          // ASSERTION 2: Path should end with dist/preload/preload.js
          const expectedSuffix = path.join("dist", "preload", "preload.js");
          expect(resolvedPath).toContain(expectedSuffix);

          // Also verify it does NOT contain dist/preload/preload/preload.js
          const buggyPattern = path.join(
            "dist",
            "preload",
            "preload",
            "preload.js",
          );
          expect(resolvedPath).not.toContain(buggyPattern);
        },
      ),
      { numRuns: 100 },
    );
  });
});

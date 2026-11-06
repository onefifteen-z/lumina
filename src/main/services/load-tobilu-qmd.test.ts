import path from "path";
import { describe, it, expect } from "vitest";
import {
  patchLoadExtensionForAsar,
  resolveTobiluQmdEntryPath,
  toUnpackedAsarPath,
} from "./load-tobilu-qmd";

const resources = path.join("/Applications", "Lumina.app", "Contents", "Resources");
const vecInAsar = path.join(
  resources,
  "app.asar",
  "node_modules",
  "sqlite-vec-darwin-arm64",
  "vec0.dylib",
);
const vecUnpacked = path.join(
  resources,
  "app.asar.unpacked",
  "node_modules",
  "sqlite-vec-darwin-arm64",
  "vec0.dylib",
);

describe("load-tobilu-qmd", () => {
  it("toUnpackedAsarPath rewrites app.asar paths", () => {
    expect(toUnpackedAsarPath(vecInAsar)).toBe(vecUnpacked);
  });

  it("toUnpackedAsarPath leaves non-asar and already-unpacked paths alone", () => {
    expect(toUnpackedAsarPath(vecUnpacked)).toBe(vecUnpacked);
    const dev = path.join("/repo", "node_modules", "sqlite-vec", "vec0.dylib");
    expect(toUnpackedAsarPath(dev)).toBe(dev);
  });

  it("resolveTobiluQmdEntryPath points at dist/index.js without unpacking", () => {
    const entry = resolveTobiluQmdEntryPath();
    expect(entry.endsWith(path.join("@tobilu", "qmd", "dist", "index.js"))).toBe(
      true,
    );
    expect(entry).not.toContain("app.asar.unpacked");
  });

  it("patchLoadExtensionForAsar redirects extension paths out of app.asar once", () => {
    const calls: unknown[][] = [];
    class FakeDatabase {
      loadExtension(...args: unknown[]) {
        calls.push(args);
        return this;
      }
    }
    const Database = FakeDatabase as unknown as Parameters<
      typeof patchLoadExtensionForAsar
    >[0];
    patchLoadExtensionForAsar(Database);
    patchLoadExtensionForAsar(Database);

    const db = new FakeDatabase();
    expect(db.loadExtension(vecInAsar, "sqlite3_vec_init")).toBe(db);
    expect(calls).toEqual([[vecUnpacked, "sqlite3_vec_init"]]);
  });
});

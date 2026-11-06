import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { LuminaBackend } from "./backend";
import { collectVaults, createRuntimeRegistry, resolveVaultRef, VaultResolveError } from "./vault-registry";

let tmp: string;
const mk = (name: string, wiki = true) => {
  const p = path.join(tmp, name);
  fs.mkdirSync(wiki ? path.join(p, "wiki") : p, { recursive: true });
  return p;
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lumina-vaults-")));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("resolveVaultRef", () => {
  it("resolves default, path, and case-insensitive name", () => {
    const a = mk("alpha");
    const b = mk("beta");
    const vaults = collectVaults([{ path: a, name: "Alpha" }, { path: b, name: "Beta" }], a);
    expect(resolveVaultRef(vaults, undefined).path).toBe(a);
    expect(resolveVaultRef(vaults, `${b}/`).path).toBe(b);
    expect(resolveVaultRef(vaults, "beta").path).toBe(b);
  });

  it("rejects ambiguous names, unknown vaults, and unregistered paths", () => {
    const a = mk("one/wiki-a");
    const b = mk("two/wiki-a");
    const vaults = collectVaults([{ path: a }, { path: b }], null);
    expect(() => resolveVaultRef(vaults, "wiki-a")).toThrow(/ambiguous.*one\/wiki-a.*two\/wiki-a/);
    expect(() => resolveVaultRef(vaults, "nope")).toThrow(/list_vaults/);
    expect(() => resolveVaultRef(vaults, mk("other"))).toThrow(VaultResolveError);
    expect(() => resolveVaultRef(vaults, undefined)).toThrow(/No default vault/);
  });

  it("includes the default vault even when it is not in the history", () => {
    const a = mk("alpha");
    const b = mk("beta", false);
    const vaults = collectVaults([{ path: b, name: "Beta" }], a);
    expect(vaults).toEqual([
      { name: "alpha", path: a, default: true, initialized: true },
      { name: "Beta", path: b, default: false, initialized: false },
    ]);
  });
});

describe("createRuntimeRegistry", () => {
  const fakeBackend = (p: string) => ({ tag: p }) as unknown as LuminaBackend;

  it("caches opened backends and evicts the least recently used", async () => {
    const paths = ["a", "b", "c"].map((n) => mk(n));
    const closed: string[] = [];
    const openBackend = vi.fn(async (p: string) => ({
      backend: fakeBackend(p),
      close: async () => {
        closed.push(path.basename(p));
      },
    }));
    const registry = createRuntimeRegistry({
      getEntries: () => paths.map((p) => ({ path: p })),
      getDefaultPath: () => null,
      openBackend,
      maxOpen: 2,
    });
    await registry.resolve("a");
    await registry.resolve("b");
    await registry.resolve("a");
    expect(openBackend).toHaveBeenCalledTimes(2);
    await registry.resolve("c");
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toEqual(["b"]);
    await registry.close();
    expect(closed.sort()).toEqual(["a", "b", "c"]);
  });

  it("prefers the live backend and drops a cached runtime for that vault", async () => {
    const a = mk("a");
    let live: LuminaBackend | null = null;
    const close = vi.fn(async () => {});
    const registry = createRuntimeRegistry({
      getEntries: () => [{ path: a }],
      getDefaultPath: () => a,
      openBackend: async (p) => ({ backend: fakeBackend(p), close }),
      getLiveBackend: () => live,
    });
    expect((await registry.resolve()).backend).toEqual({ tag: a });
    live = fakeBackend("live");
    expect((await registry.resolve("a")).backend).toBe(live);
    await new Promise((r) => setTimeout(r, 0));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("refuses vaults without wiki/", async () => {
    const a = mk("bare", false);
    const registry = createRuntimeRegistry({
      getEntries: () => [{ path: a }],
      getDefaultPath: () => null,
      openBackend: async () => {
        throw new Error("should not open");
      },
    });
    await expect(registry.resolve("bare")).rejects.toThrow(/not a Lumina vault/);
  });
});

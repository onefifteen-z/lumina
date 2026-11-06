import fs from "fs";
import path from "path";
import type { LuminaBackend } from "./backend";

export type VaultEntryLike = { path: string; name?: string };

export type VaultInfo = {
  name: string;
  path: string;
  /** Used when a tool call omits `vault`. */
  default: boolean;
  /** Has a wiki/ folder. */
  initialized: boolean;
};

export class VaultResolveError extends Error {}

export type OpenedBackend = { backend: LuminaBackend; close(): Promise<void> };

export interface VaultRegistry {
  list(): Promise<VaultInfo[]>;
  resolve(vault?: string): Promise<{ info: VaultInfo; backend: LuminaBackend }>;
  close(): Promise<void>;
  /** Backends implement ingestWithLumina (the app); registers that tool. */
  readonly supportsLuminaIngest: boolean;
}

function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, "") : resolved;
}

function entryName(entry: VaultEntryLike): string {
  return entry.name?.trim() || path.basename(normalizePath(entry.path));
}

/** Registered vaults plus the default, de-duplicated by normalized path. */
export function collectVaults(entries: readonly VaultEntryLike[], defaultPath: string | null): VaultInfo[] {
  const byPath = new Map<string, VaultInfo>();
  const add = (entry: VaultEntryLike) => {
    if (!entry.path) return;
    const p = normalizePath(entry.path);
    if (byPath.has(p)) return;
    byPath.set(p, {
      name: entryName(entry),
      path: p,
      default: false,
      initialized: fs.existsSync(path.join(p, "wiki")),
    });
  };
  if (defaultPath) add({ path: defaultPath });
  entries.forEach(add);
  if (defaultPath) byPath.get(normalizePath(defaultPath))!.default = true;
  return [...byPath.values()];
}

/**
 * Resolve a `vault` tool argument: omitted → default; exact path; then
 * case-insensitive name. Only vaults in `vaults` are reachable.
 */
export function resolveVaultRef(vaults: readonly VaultInfo[], ref: string | undefined): VaultInfo {
  const trimmed = ref?.trim();
  if (!trimmed) {
    const def = vaults.find((v) => v.default);
    if (!def) throw new VaultResolveError("No default vault is open; pass `vault` (see list_vaults).");
    return def;
  }
  const looksLikePath = trimmed.includes("/") || trimmed.includes("\\") || trimmed.startsWith("~");
  if (looksLikePath) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, process.env.HOME ?? "~");
    const byPath = vaults.find((v) => v.path === normalizePath(expanded));
    if (byPath) return byPath;
  }
  const lower = trimmed.toLowerCase();
  const byName = vaults.filter((v) => v.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new VaultResolveError(
      `Vault name "${trimmed}" is ambiguous; pass the path instead: ${byName.map((v) => v.path).join(", ")}`,
    );
  }
  throw new VaultResolveError(`Unknown vault "${trimmed}". Call list_vaults for the available vaults.`);
}

export type RuntimeRegistryOptions = {
  getEntries(): readonly VaultEntryLike[];
  getDefaultPath(): string | null;
  /** Opens an isolated backend for a vault (cached, LRU-evicted). */
  openBackend(vaultPath: string): Promise<OpenedBackend>;
  /** A backend already maintained elsewhere (the app's open vault); bypasses the cache. */
  getLiveBackend?(vaultPath: string): LuminaBackend | null;
  maxOpen?: number;
  supportsLuminaIngest?: boolean;
};

export function createRuntimeRegistry(options: RuntimeRegistryOptions): VaultRegistry {
  const maxOpen = Math.max(1, options.maxOpen ?? 3);
  // Map iteration order doubles as LRU order (oldest first).
  const cache = new Map<string, Promise<OpenedBackend>>();

  const release = (vaultPath: string) => {
    const entry = cache.get(vaultPath);
    if (!entry) return;
    cache.delete(vaultPath);
    void entry.then((opened) => opened.close()).catch(() => {});
  };

  const vaults = () => collectVaults(options.getEntries(), options.getDefaultPath());

  return {
    supportsLuminaIngest: options.supportsLuminaIngest ?? false,

    async list() {
      return vaults();
    },

    async resolve(ref) {
      const info = resolveVaultRef(vaults(), ref);
      if (!info.initialized) throw new VaultResolveError(`${info.path} is not a Lumina vault (no wiki/ folder).`);
      const live = options.getLiveBackend?.(info.path) ?? null;
      if (live) {
        release(info.path);
        return { info, backend: live };
      }
      let entry = cache.get(info.path);
      if (entry) {
        cache.delete(info.path);
      } else {
        entry = options.openBackend(info.path);
        entry.catch(() => cache.delete(info.path));
      }
      cache.set(info.path, entry);
      while (cache.size > maxOpen) release(cache.keys().next().value!);
      return { info, backend: (await entry).backend };
    },

    async close() {
      const entries = [...cache.values()];
      cache.clear();
      await Promise.all(entries.map((e) => e.then((o) => o.close()).catch(() => {})));
    },
  };
}

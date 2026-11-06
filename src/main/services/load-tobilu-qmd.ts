import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

export type TobiluQmdModule = typeof import("@tobilu/qmd");
type BetterSqlite3Module = typeof import("better-sqlite3");

/**
 * Native libraries cannot be dlopen()ed from inside app.asar; asarUnpack
 * mirrors them under app.asar.unpacked.
 */
export function toUnpackedAsarPath(resolved: string): string {
  const marker = `${path.sep}app.asar${path.sep}`;
  if (!resolved.includes(marker)) return resolved;
  return resolved.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`);
}

/**
 * Must be the app.asar path, not app.asar.unpacked: qmd's pure-JS deps
 * (picomatch, zod, ...) only exist inside app.asar.
 */
export function resolveTobiluQmdEntryPath(): string {
  const rel = path.join("node_modules", "@tobilu", "qmd", "dist", "index.js");
  const candidates = [
    path.join(__dirname, "..", "..", "..", "..", rel),
    path.join(process.cwd(), rel),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Could not locate @tobilu/qmd in the application bundle. Reinstall the app or run npm install.",
  );
}

const patchedPrototypes = new WeakSet<object>();

/**
 * sqlite-vec resolves vec0.dylib via import.meta.resolve, which yields a path
 * inside app.asar in packaged builds. qmd shares this better-sqlite3 instance
 * (see package.json overrides), so rewriting here covers its loadExtension calls.
 */
export function patchLoadExtensionForAsar(
  Database: BetterSqlite3Module = require("better-sqlite3"),
): void {
  const proto = Database.prototype;
  if (patchedPrototypes.has(proto)) return;
  const original = proto.loadExtension;
  proto.loadExtension = function (
    this: InstanceType<BetterSqlite3Module>,
    file: string,
    ...rest: unknown[]
  ) {
    return (original as (...args: unknown[]) => unknown).call(
      this,
      toUnpackedAsarPath(file),
      ...rest,
    );
  } as typeof original;
  patchedPrototypes.add(proto);
}

function shouldFallbackToEntryFile(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code =
    "code" in err ? String((err as NodeJS.ErrnoException).code) : "";
  return (
    code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
    code === "ERR_REQUIRE_ESM" ||
    err.message.includes('No "exports" main defined')
  );
}

let qmdLoaderOverride: (() => Promise<TobiluQmdModule>) | null = null;

/**
 * @tobilu/qmd is ESM-only. Main compiles to CJS and tsc lowers `import()` to
 * `require()` — use eval so the dynamic import survives compilation (see pdf-rasterize.ts).
 */
async function dynamicImportQmd(specifier: string): Promise<TobiluQmdModule> {
  return (await eval(`import(${JSON.stringify(specifier)})`)) as TobiluQmdModule;
}

/** @internal — for tests only; bypasses the eval()-based ESM loader. */
export function __setQmdLoaderForTesting(
  loader: (() => Promise<TobiluQmdModule>) | null,
): void {
  qmdLoaderOverride = loader;
}

/**
 * Load @tobilu/qmd in Electron main (CJS). Package exports are ESM-only;
 * `require("@tobilu/qmd")` fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
 */
export async function loadTobiluQmdModule(): Promise<TobiluQmdModule> {
  if (qmdLoaderOverride) return qmdLoaderOverride();
  patchLoadExtensionForAsar();
  try {
    return await dynamicImportQmd("@tobilu/qmd");
  } catch (err) {
    if (!shouldFallbackToEntryFile(err)) throw err;
    const entryPath = resolveTobiluQmdEntryPath();
    return dynamicImportQmd(pathToFileURL(entryPath).href);
  }
}

import fs from "fs";
import os from "os";
import path from "path";
import { DEFAULT_QMD_SEARCH_CONFIG, type QmdSearchConfig, type VaultEntry } from "../shared/types";

const CONFIG_FILE = "llm-wiki-config.json";
// Exact casing matters even on case-insensitive disks: qmd keys stored vectors
// by the embed model path string, and Electron builds userData from app name "Lumina".
const USER_DATA_NAMES = ["Lumina", "lumina"];

export type HeadlessConfig = {
  /** Default vault for tool calls that omit `vault`; null when only the history is available. */
  vaultPath: string | null;
  /** Reachable vaults: the app's vault history plus an explicit --vault / LUMINA_VAULT. */
  vaults: VaultEntry[];
  userDataDir: string | null;
  qmdSearch: QmdSearchConfig;
  allowWrite: boolean;
};

export class HeadlessConfigError extends Error {}

type ParsedArgs = { vault?: string; allowWrite: boolean; userData?: string };

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { allowWrite: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.split(/=(.*)/s, 2);
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new HeadlessConfigError(`${flag} requires a value`);
      return next;
    };
    if (flag === "--vault") out.vault = value();
    else if (flag === "--user-data") out.userData = value();
    else if (flag === "--allow-write") out.allowWrite = true;
    else throw new HeadlessConfigError(`Unknown argument: ${arg}`);
  }
  return out;
}

/** Electron's `app.getPath("userData")` for this app, without loading Electron. */
export function defaultUserDataCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string[] {
  const base =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : platform === "win32"
        ? (env.APPDATA ?? path.join(home, "AppData", "Roaming"))
        : (env.XDG_CONFIG_HOME ?? path.join(home, ".config"));
  return USER_DATA_NAMES.map((name) => path.join(base, name));
}

function readAppConfig(userDataDir: string | null): Record<string, unknown> {
  if (!userDataDir) return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(userDataDir, CONFIG_FILE), "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function expandHome(p: string): string {
  return path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
}

function readVaultHistory(appConfig: Record<string, unknown>): VaultEntry[] {
  if (!Array.isArray(appConfig.vaultHistory)) return [];
  return appConfig.vaultHistory
    .filter((e): e is VaultEntry => typeof e?.path === "string" && e.path.length > 0)
    .map((e) => ({ path: expandHome(e.path), name: typeof e.name === "string" && e.name ? e.name : path.basename(e.path) }));
}

/**
 * Resolve the stdio CLI configuration.
 * Default vault: `--vault` > `LUMINA_VAULT` > the vault last opened in the app.
 * Other vaults from the app's history stay reachable via the `vault` tool argument.
 * Writes: `--allow-write` or the app's `mcpServer.allowWrite` setting.
 */
export function resolveHeadlessConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  userDataCandidates: string[] = defaultUserDataCandidates(process.platform, env),
): HeadlessConfig {
  const args = parseCliArgs(argv);
  const explicitUserData = args.userData ?? env.LUMINA_USER_DATA;
  const userDataDir = explicitUserData
    ? path.resolve(explicitUserData)
    : (userDataCandidates.find((dir) => fs.existsSync(path.join(dir, CONFIG_FILE))) ?? null);
  const appConfig = readAppConfig(userDataDir);

  const history = readVaultHistory(appConfig);
  const explicit = args.vault ?? env.LUMINA_VAULT;
  const rawDefault = explicit ?? (typeof appConfig.vaultPath === "string" ? appConfig.vaultPath : "");
  let vaultPath: string | null = rawDefault ? expandHome(rawDefault) : null;
  if (vaultPath && !fs.existsSync(path.join(vaultPath, "wiki"))) {
    if (explicit) throw new HeadlessConfigError(`${vaultPath} is not a Lumina vault (no wiki/ folder).`);
    vaultPath = null;
  }
  if (!vaultPath && history.length === 0) {
    throw new HeadlessConfigError(
      "No vault configured. Pass --vault <path>, set LUMINA_VAULT, or open a vault in the Lumina app first.",
    );
  }
  const vaults =
    vaultPath && !history.some((e) => e.path === vaultPath)
      ? [{ path: vaultPath, name: path.basename(vaultPath) }, ...history]
      : history;

  const mcpServer = (appConfig.mcpServer ?? {}) as { allowWrite?: unknown };
  return {
    vaultPath,
    vaults,
    userDataDir,
    qmdSearch: {
      ...DEFAULT_QMD_SEARCH_CONFIG,
      ...((appConfig.qmdSearch as Partial<QmdSearchConfig> | undefined) ?? {}),
    },
    allowWrite: args.allowWrite || mcpServer.allowWrite === true,
  };
}

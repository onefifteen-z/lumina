/**
 * Manage a shared, cross-vault Python virtualenv at `~/.lumina/venv/` that
 * houses Lumina's auxiliary Python tooling (currently: `markitdown`).
 *
 * Why a shared venv (and not one per vault)?
 *   - markitdown[all] pulls ~200MB of dependencies. Installing it once per
 *     vault would be wasteful and slow.
 *   - The venv is read by `ingest_source` regardless of which vault is open,
 *     so the natural home is the user's home directory, not the vault.
 *   - Users who want to nuke + reinstall can `rm -rf ~/.lumina/venv` and
 *     the next ingest will rebuild it.
 *
 * Module exports two surfaces:
 *
 *   - Pure helpers (`getLuminaVenvDir`, `getLuminaPythonBin`) — no I/O,
 *     trivially testable.
 *   - Side-effecting `ensureLuminaVenv()` — detects python3, creates the
 *     venv and installs markitdown if needed. Memoised per-process so a
 *     burst of concurrent ingests doesn't trigger multiple `pip install`
 *     races. Returns a structured result the caller can format into a
 *     user-facing error string.
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Where the venv lives. Exposed (not just internally derived) because
 * ingest-tool.ts wants to surface this path in error messages so users know
 * where to nuke if they need a clean reinstall.
 */
export function getLuminaVenvDir(): string {
  return path.join(os.homedir(), ".lumina", "venv");
}

/**
 * Path to the venv's python binary. Windows uses `Scripts/python.exe`,
 * everything else uses `bin/python`. We don't currently support Windows
 * (the rest of the app is macOS-first) but isolating the difference here
 * means a future port only has to touch one function.
 */
export function getLuminaPythonBin(venvDir: string = getLuminaVenvDir()): string {
  if (process.platform === "win32") {
    return path.join(venvDir, "Scripts", "python.exe");
  }
  return path.join(venvDir, "bin", "python");
}

/**
 * Path to the venv's pip binary. Same platform split as python.
 */
export function getLuminaPipBin(venvDir: string = getLuminaVenvDir()): string {
  if (process.platform === "win32") {
    return path.join(venvDir, "Scripts", "pip.exe");
  }
  return path.join(venvDir, "bin", "pip");
}

/**
 * Result of `ensureLuminaVenv()`. The caller (`ingest-tool`) translates this
 * into a tool-result string for the model. We deliberately distinguish the
 * three failure modes — they have different remedies and different things to
 * tell the user:
 *
 *   - `no-python`: install python3 (system-level)
 *   - `venv-failed`: rare; usually filesystem permissions
 *   - `install-failed`: pip couldn't install markitdown; surface stderr
 */
export type EnsureVenvResult =
  | { ok: true; pythonBin: string; venvDir: string }
  | { ok: false; reason: "no-python"; message: string }
  | { ok: false; reason: "venv-failed"; message: string }
  | { ok: false; reason: "install-failed"; message: string };

/**
 * Quote a path for safe inclusion in a `/bin/sh -c` command. We POSIX
 * single-quote: wrap in single quotes, replace each embedded ' with '\''
 * (close, escaped quote, reopen). Handles spaces, $, &, etc.
 */
export function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Build the install command. Extracted for testability. */
export function buildPipInstallCommand(pythonBin: string): string {
  // Use `python -m pip` instead of the pip binary directly. On freshly
  // bootstrapped venvs `pip` may not be on PATH yet (and we don't add the
  // venv to PATH) — invoking through python avoids that footgun.
  return `${shQuote(pythonBin)} -m pip install --upgrade --quiet markitdown[all]`;
}

/** Build the venv-creation command. Extracted for testability. */
export function buildVenvCreateCommand(systemPython: string, venvDir: string): string {
  return `${shQuote(systemPython)} -m venv ${shQuote(venvDir)}`;
}

/** Build the markitdown-presence-check command. Extracted for testability. */
export function buildMarkitdownCheckCommand(pythonBin: string): string {
  // Importing the package and printing its version doubles as both a
  // presence and a smoke-test: if the install is corrupt the import will
  // raise long before the model burns tokens on a real conversion.
  return `${shQuote(pythonBin)} -c "import markitdown; print(markitdown.__version__)"`;
}

/**
 * Find a usable system `python3`. We try `python3` first (the modern
 * convention), then `python` (some Linux distros only ship the bare name
 * after the python2-EOL purge).
 *
 * Returns null if neither resolves to python ≥ 3.8 — we need at least 3.8
 * because markitdown's transitive deps (e.g. `azure-ai-document-intelligence`)
 * dropped support for older Pythons.
 */
export async function findSystemPython(): Promise<string | null> {
  for (const candidate of ["python3", "python"]) {
    try {
      const { stdout } = await execAsync(`${candidate} --version`, { timeout: 5_000 });
      const version = stdout.trim();
      // Output looks like "Python 3.11.6". Reject Python 2.x explicitly.
      const m = /^Python\s+(\d+)\.(\d+)/.exec(version);
      if (!m) continue;
      const major = Number(m[1]);
      const minor = Number(m[2]);
      if (major < 3) continue;
      if (major === 3 && minor < 8) continue;
      return candidate;
    } catch {
      // command not found / non-zero exit → try next
    }
  }
  return null;
}

/**
 * True if the path exists. Wraps stat into the boolean we actually want;
 * keeps the rest of the file free of try/catch noise.
 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

let memoised: Promise<EnsureVenvResult> | null = null;

/**
 * Ensure the Lumina venv exists and has markitdown installed. Memoised per
 * process — concurrent callers share a single bootstrap and a single
 * install. Failed attempts are cached too, but in their `ok: false` form
 * the caller already distinguishes "we tried, here's why it failed" from
 * "we never tried", so this is fine.
 *
 * To force a re-attempt within the same process, call
 * `__resetLuminaVenvForTesting()` (or just restart the app — the venv is
 * persistent on disk regardless).
 */
export function ensureLuminaVenv(): Promise<EnsureVenvResult> {
  if (memoised) return memoised;
  memoised = doEnsure();
  return memoised;
}

async function doEnsure(): Promise<EnsureVenvResult> {
  const venvDir = getLuminaVenvDir();
  const venvPython = getLuminaPythonBin(venvDir);

  // Fast path: venv already bootstrapped + markitdown already installed.
  if (await pathExists(venvPython)) {
    const check = await runMarkitdownCheck(venvPython);
    if (check.ok) {
      return { ok: true, pythonBin: venvPython, venvDir };
    }
    // venv exists but markitdown is gone (user tampered, partial install).
    // Fall through to the install branch — no need to recreate the venv.
    const installed = await tryInstallMarkitdown(venvPython);
    if (!installed.ok) return installed;
    return { ok: true, pythonBin: venvPython, venvDir };
  }

  // Cold path: need a system python first.
  const systemPython = await findSystemPython();
  if (!systemPython) {
    return {
      ok: false,
      reason: "no-python",
      message:
        "python3 was not found on PATH. Install Python 3.8+ (e.g. `brew install python3` on macOS) and retry.",
    };
  }

  // Create venv parent dir, then the venv itself.
  try {
    await fs.mkdir(path.dirname(venvDir), { recursive: true });
    await execAsync(buildVenvCreateCommand(systemPython, venvDir), {
      timeout: 60_000,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    return {
      ok: false,
      reason: "venv-failed",
      message: `Failed to create venv at ${venvDir}: ${e.stderr ?? e.message ?? "unknown error"}`,
    };
  }

  // Bootstrap done; install markitdown.
  const installed = await tryInstallMarkitdown(venvPython);
  if (!installed.ok) return installed;
  return { ok: true, pythonBin: venvPython, venvDir };
}

async function runMarkitdownCheck(
  venvPython: string,
): Promise<{ ok: true; version: string } | { ok: false }> {
  try {
    const { stdout } = await execAsync(buildMarkitdownCheckCommand(venvPython), {
      timeout: 10_000,
    });
    const version = stdout.trim();
    if (!version) return { ok: false };
    return { ok: true, version };
  } catch {
    return { ok: false };
  }
}

async function tryInstallMarkitdown(venvPython: string): Promise<EnsureVenvResult> {
  try {
    // pip install can take minutes on a cold cache, especially with [all].
    // 5 minute timeout matches the per-call shell tool ceiling we're giving
    // the model elsewhere — no point going higher; if it stalls past that
    // something's actually wrong (network, permissions).
    await execAsync(buildPipInstallCommand(venvPython), {
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, pythonBin: venvPython, venvDir: getLuminaVenvDir() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    const stderr = (e.stderr ?? "").trim();
    return {
      ok: false,
      reason: "install-failed",
      message:
        `Failed to install markitdown into ${getLuminaVenvDir()}: ` +
        `${stderr || e.message || "unknown error"}`,
    };
  }
}

/**
 * Test-only: clear the memoised result so a follow-up call to
 * `ensureLuminaVenv` re-runs the bootstrap. Production code should never
 * need this — the venv is a singleton per process by design.
 */
export function __resetLuminaVenvForTesting(): void {
  memoised = null;
}

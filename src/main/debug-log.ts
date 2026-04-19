import { BrowserWindow } from "electron";

/**
 * Severity / category tag for a debug log entry. Renderer styles each
 * level with a different ANSI-ish color in the bash-style panel.
 */
export type DebugLogLevel = "info" | "warn" | "error" | "debug" | "stream";

export interface DebugLogEntry {
  /** Unix epoch ms — renderer formats locally. */
  ts: number;
  level: DebugLogLevel;
  /** Short tag identifying the source (e.g. "llm", "ipc", "chat"). */
  tag: string;
  /** Human-readable message body. */
  message: string;
  /** Optional structured payload — printed as pretty JSON. */
  data?: unknown;
}

const RING_BUFFER_LIMIT = 1000;

// Keep a small in-process backlog so a window opening the panel mid-session
// still sees what already happened. We trim to RING_BUFFER_LIMIT entries.
const backlog: DebugLogEntry[] = [];

/**
 * Best-effort broadcast to every renderer window. We intentionally swallow
 * errors here — debug logs must never affect product behaviour.
 */
function broadcast(entry: DebugLogEntry): void {
  // Mirror to the main-process console for tail-able terminal output.
  // Suppressed under test runners (Vitest sets VITEST=true) to keep output clean.
  if (!process.env.VITEST) {
    const printable = entry.data !== undefined
      ? `[${entry.tag}] ${entry.message} ${safeStringify(entry.data)}`
      : `[${entry.tag}] ${entry.message}`;
    switch (entry.level) {
      case "error":
        console.error(printable);
        break;
      case "warn":
        console.warn(printable);
        break;
      default:
        console.log(printable);
    }
  }

  // Skip broadcasting under test runners where Electron is not initialised.
  if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== "function") return;

  let windows: BrowserWindow[] = [];
  try {
    windows = BrowserWindow.getAllWindows();
  } catch {
    return;
  }
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send("wiki:debugLog", entry);
    } catch {
      /* ignore */
    }
  }
}

function safeStringify(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value, replacer, 2);
  } catch {
    return String(value);
  }
}

// Truncate huge strings so the panel stays usable when streaming raw bodies.
function replacer(_key: string, val: unknown): unknown {
  if (typeof val === "string" && val.length > 4096) {
    return `${val.slice(0, 4096)}…[truncated ${val.length - 4096} chars]`;
  }
  return val;
}

/**
 * Append to the backlog and broadcast. Call this from anywhere in the main
 * process to surface debug info into the renderer's debug panel.
 */
export function debugLog(
  level: DebugLogLevel,
  tag: string,
  message: string,
  data?: unknown,
): void {
  const entry: DebugLogEntry = { ts: Date.now(), level, tag, message, data };
  backlog.push(entry);
  if (backlog.length > RING_BUFFER_LIMIT) backlog.shift();
  broadcast(entry);
}

/** Returns a snapshot copy of the current backlog (oldest first). */
export function getDebugLogBacklog(): DebugLogEntry[] {
  return backlog.slice();
}

/** Used by the renderer when it (re)mounts the panel to fetch history. */
export function sendBacklogTo(target: Electron.WebContents): void {
  for (const entry of backlog) {
    try {
      target.send("wiki:debugLog", entry);
    } catch {
      /* ignore */
    }
  }
}

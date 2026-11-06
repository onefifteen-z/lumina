import fs from "fs/promises";
import path from "path";
import type { ChatChunk } from "../../shared/types";
import type { IngestWithLuminaProgress, IngestWithLuminaResult } from "../../mcp/backend";

const WIKI_DIR = "wiki";
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/** The slice of ChatService the runner drives; one fresh instance per ingest. */
export interface IngestChatSession {
  startSession(): Promise<unknown>;
  sendMessage(content: string): AsyncGenerator<ChatChunk>;
  stopGeneration(): void;
}

export type LuminaIngestRunnerDeps = {
  /** Throws when no LLM is configured. */
  createChat(vaultPath: string): IngestChatSession;
  /** Called after an ingest so indexes pick up new pages immediately. */
  onWikiChanged?: (vaultPath: string) => void;
  timeoutMs?: number;
};

type Snapshot = Map<string, string>;

async function snapshotWiki(vault: string): Promise<Snapshot> {
  const out: Snapshot = new Map();
  const walk = async (dir: string): Promise<void> => {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const stat = await fs.stat(full);
        out.set(path.relative(vault, full).split(path.sep).join("/"), `${stat.mtimeMs}:${stat.size}`);
      }
    }
  };
  await walk(path.join(vault, WIKI_DIR));
  return out;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const changed = new Set<string>();
  for (const [file, sig] of after) if (before.get(file) !== sig) changed.add(file);
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return [...changed].sort();
}

export function buildIngestMessage(sourcePath: string, note?: string): string {
  const lines = [`Please ingest \`${sourcePath}\` following CLAUDE.md and INGEST.md.`];
  const trimmed = note?.trim();
  if (trimmed) lines.push("", "Additional guidance from the requesting agent:", trimmed);
  return lines.join("\n");
}

/**
 * Runs `ingest_with_lumina` requests one at a time (across all vaults), each
 * in its own chat session so the user's in-app conversation is untouched.
 */
export class LuminaIngestRunner {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(private readonly deps: LuminaIngestRunnerDeps) {}

  run(
    vaultPath: string,
    sourcePath: string,
    note: string | undefined,
    onProgress: (p: IngestWithLuminaProgress) => void,
  ): Promise<IngestWithLuminaResult> {
    if (this.pending > 0) onProgress({ step: 0, message: "Waiting for a previous ingest to finish…" });
    this.pending += 1;
    const job = this.tail.then(() => this.runNow(vaultPath, sourcePath, note, onProgress));
    this.tail = job.catch(() => {}).finally(() => {
      this.pending -= 1;
    });
    return job;
  }

  private async runNow(
    vault: string,
    sourcePath: string,
    note: string | undefined,
    onProgress: (p: IngestWithLuminaProgress) => void,
  ): Promise<IngestWithLuminaResult> {
    const abs = path.resolve(vault, sourcePath);
    if (!abs.startsWith(path.join(vault, "raw") + path.sep)) throw new Error("path must be a file under raw/");
    try {
      if (!(await fs.stat(abs)).isFile()) throw new Error();
    } catch {
      throw new Error(`${sourcePath} not found`);
    }

    const chat = this.deps.createChat(vault);
    await chat.startSession();
    const before = await snapshotWiki(vault);
    let step = 0;
    let reply = "";
    let toolCalls = 0;
    onProgress({ step, message: `Ingesting ${sourcePath}…` });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      chat.stopGeneration();
    }, this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      for await (const chunk of chat.sendMessage(buildIngestMessage(sourcePath, note))) {
        if (chunk.type === "text") reply += chunk.content;
        else if (chunk.type === "tool_call") {
          toolCalls += 1;
          onProgress({ step: ++step, message: `${chunk.name} ${chunk.args.slice(0, 160)}` });
        }
      }
    } finally {
      clearTimeout(timer);
      this.deps.onWikiChanged?.(vault);
    }
    const changedFiles = diffSnapshots(before, await snapshotWiki(vault));
    if (timedOut) reply = `${reply}\n\n[stopped: ingest exceeded the time limit]`.trim();
    return { reply: reply.trim(), changedFiles, toolCalls };
  }
}

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { ChatChunk } from "../../shared/types";
import { LuminaIngestRunner, buildIngestMessage, type IngestChatSession } from "./lumina-ingest-runner";

let vault: string;

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-ingest-"));
  fs.mkdirSync(path.join(vault, "wiki"));
  fs.mkdirSync(path.join(vault, "raw"));
  fs.writeFileSync(path.join(vault, "raw", "paper.md"), "source");
  fs.writeFileSync(path.join(vault, "wiki", "index.md"), "# Index\n");
});

afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

function fakeChat(script: (messages: string[]) => ChatChunk[], log: string[] = []): (vaultPath: string) => IngestChatSession {
  return (vaultPath) => {
    log.push(`vault:${vaultPath === vault ? "ok" : vaultPath}`);
    const messages: string[] = [];
    return {
      startSession: async () => {
        log.push("start");
      },
      async *sendMessage(content: string) {
        messages.push(content);
        log.push(`send:${content.split("\n")[0]}`);
        await new Promise((r) => setTimeout(r, 10));
        for (const chunk of script(messages)) yield chunk;
        log.push("done");
      },
      stopGeneration: () => {},
    };
  };
}

describe("LuminaIngestRunner", () => {
  it("runs a fresh session, reports tool-call progress and changed wiki files", async () => {
    const runner = new LuminaIngestRunner({
      createChat: fakeChat(() => {
        fs.mkdirSync(path.join(vault, "wiki", "sources"));
        fs.writeFileSync(path.join(vault, "wiki", "sources", "paper.md"), "summary");
        fs.writeFileSync(path.join(vault, "wiki", "index.md"), "# Index\n- [[paper]]\n");
        return [
          { type: "tool_call", id: "1", name: "ingest_source", args: '{"path":"raw/paper.md"}' },
          { type: "tool_call", id: "2", name: "shell", args: "cat > wiki/sources/paper.md" },
          { type: "text", content: "Ingested paper." },
        ];
      }),
    });
    const progress: string[] = [];
    const result = await runner.run(vault, "raw/paper.md", "focus on methods", (p) => progress.push(`${p.step}:${p.message}`));
    expect(result).toEqual({
      reply: "Ingested paper.",
      changedFiles: ["wiki/index.md", "wiki/sources/paper.md"],
      toolCalls: 2,
    });
    expect(progress[0]).toBe("0:Ingesting raw/paper.md…");
    expect(progress[1]).toMatch(/^1:ingest_source/);
  });

  it("serializes concurrent ingests", async () => {
    const log: string[] = [];
    fs.writeFileSync(path.join(vault, "raw", "b.md"), "b");
    const runner = new LuminaIngestRunner({
      createChat: fakeChat(() => [{ type: "text", content: "ok" }], log),
    });
    await Promise.all([runner.run(vault, "raw/paper.md", undefined, () => {}), runner.run(vault, "raw/b.md", undefined, () => {})]);
    expect(log).toEqual([
      "vault:ok",
      "start",
      "send:Please ingest `raw/paper.md` following CLAUDE.md and INGEST.md.",
      "done",
      "vault:ok",
      "start",
      "send:Please ingest `raw/b.md` following CLAUDE.md and INGEST.md.",
      "done",
    ]);
  });

  it("rejects paths outside raw/ and missing files before starting a session", async () => {
    const log: string[] = [];
    const runner = new LuminaIngestRunner({ createChat: fakeChat(() => [], log) });
    await expect(runner.run(vault, "raw/../wiki/index.md", undefined, () => {})).rejects.toThrow(/under raw/);
    await expect(runner.run(vault, "raw/missing.pdf", undefined, () => {})).rejects.toThrow(/not found/);
    expect(log).toEqual([]);
  });

  it("appends the caller's note to the ingest message", () => {
    expect(buildIngestMessage("raw/a.pdf", "  only chapter 2 ")).toBe(
      "Please ingest `raw/a.pdf` following CLAUDE.md and INGEST.md.\n\nAdditional guidance from the requesting agent:\nonly chapter 2",
    );
  });
});

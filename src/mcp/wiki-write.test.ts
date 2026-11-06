import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  appendWikiLog,
  formatWikiLogEntry,
  normalizeWikiPagePath,
  writeWikiPage,
} from "./wiki-write";

describe("normalizeWikiPagePath", () => {
  it("accepts wiki-relative and bare paths", () => {
    expect(normalizeWikiPagePath("wiki/topics/a.md")).toBe("wiki/topics/a.md");
    expect(normalizeWikiPagePath("topics/a.md")).toBe("wiki/topics/a.md");
    expect(normalizeWikiPagePath("wiki\\b.md")).toBe("wiki/b.md");
    expect(normalizeWikiPagePath("./wiki/./c.md")).toBe("wiki/c.md");
  });

  it.each([
    ["../escape.md"],
    ["wiki/../raw/x.md"],
    ["/etc/passwd.md"],
    ["C:/x.md"],
    ["raw/../../x.md"],
    ["wiki/.hidden/x.md"],
    ["wiki/notes.txt"],
    ["wiki"],
    ["raw/x.md"],
    [""],
  ])("rejects %s", (p) => {
    expect(() => normalizeWikiPagePath(p)).toThrow();
  });
});

describe("writeWikiPage / appendWikiLog", () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-wiki-write-"));
    fs.mkdirSync(path.join(vault, "wiki"));
    fs.mkdirSync(path.join(vault, "raw"));
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it("creates nested pages and refuses to overwrite without the flag", async () => {
    const first = await writeWikiPage(vault, "concepts/agent.md", "# Agent");
    expect(first).toMatchObject({ path: "wiki/concepts/agent.md", created: true });
    expect(fs.readFileSync(path.join(vault, "wiki/concepts/agent.md"), "utf-8")).toBe("# Agent\n");

    await expect(writeWikiPage(vault, "concepts/agent.md", "# v2")).rejects.toThrow(/overwrite/);
    const second = await writeWikiPage(vault, "concepts/agent.md", "# v2\n", true);
    expect(second.created).toBe(false);
    expect(fs.readFileSync(path.join(vault, "wiki/concepts/agent.md"), "utf-8")).toBe("# v2\n");
  });

  it("refuses to follow a symlinked folder out of wiki/", async () => {
    fs.symlinkSync(path.join(vault, "raw"), path.join(vault, "wiki", "linked"));
    await expect(writeWikiPage(vault, "wiki/linked/x.md", "x")).rejects.toThrow(/outside wiki/);
    expect(fs.existsSync(path.join(vault, "raw", "x.md"))).toBe(false);
  });

  it("formats and appends log entries", async () => {
    const now = new Date("2026-11-06T12:00:00Z");
    expect(formatWikiLogEntry({ title: "Paper A" }, now)).toBe("## [2026-11-06] ingest | Paper A\n");
    await appendWikiLog(vault, { title: "Paper A", details: "- created wiki/sources/a.md" }, now);
    await appendWikiLog(vault, { operation: "query", title: "Q1" }, now);
    expect(fs.readFileSync(path.join(vault, "wiki/log.md"), "utf-8")).toBe(
      "# Log\n\n## [2026-11-06] ingest | Paper A\n\n- created wiki/sources/a.md\n\n## [2026-11-06] query | Q1\n",
    );
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  FileSystemService,
  extractFrontmatterSources,
} from "./filesystem-service";
import { parseArticleFile } from "../../shared/markdown-parser";
import type { ArticleFile } from "../../shared/types";

let tmpDir: string;
let service: FileSystemService;

function makeArticleRaw(title: string, tags: string[], body: string): string {
  return `---
title: "${title}"
tags:
${tags.map((t) => `  - ${t}`).join("\n")}
created: "2024-01-01T00:00:00Z"
modified: "2024-01-01T00:00:00Z"
---
${body}
`;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fss-test-"));
  service = new FileSystemService(tmpDir);
});

afterEach(async () => {
  service.stopWatching();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── scanVault ──────────────────────────────────────────────────────────────

describe("listEmptyWikiRawFolders", () => {
  it("lists wiki/raw directories that contain no indexed files", async () => {
    await fs.mkdir(path.join(tmpDir, "wiki", "inbox", "nested-empty"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "wiki", "note.md"),
      makeArticleRaw("N", [], "x"),
    );
    const empty = await service.listEmptyWikiRawFolders();
    expect(empty).toContain("wiki/inbox");
    expect(empty).toContain("wiki/inbox/nested-empty");
    expect(empty).not.toContain("wiki");
  });
});

describe("scanVault", () => {
  it("returns empty array for empty vault", async () => {
    const result = await service.scanVault();
    expect(result).toEqual([]);
  });

  it("finds and parses .md files", async () => {
    await fs.writeFile(
      path.join(tmpDir, "hello.md"),
      makeArticleRaw("Hello", ["test"], "Body content here."),
    );
    const result = await service.scanVault();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Hello");
    expect(result[0].filename).toBe("hello.md");
    expect(result[0].tags).toContain("test");
    expect(result[0].excerpt).toContain("Body content");
  });

  it("extracts wikilinks from articles", async () => {
    await fs.writeFile(
      path.join(tmpDir, "links.md"),
      makeArticleRaw("Links", [], "See [[Other Article]] and [[Another]]."),
    );
    const result = await service.scanVault();
    expect(result[0].wikilinks).toEqual(["Other Article", "Another"]);
  });

  it("recursively finds files in subdirectories", async () => {
    const subDir = path.join(tmpDir, "sub");
    await fs.mkdir(subDir);
    await fs.writeFile(
      path.join(subDir, "nested.md"),
      makeArticleRaw("Nested", [], "Nested body."),
    );
    const result = await service.scanVault();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Nested");
  });

  it("skips corrupted files gracefully", async () => {
    await fs.writeFile(
      path.join(tmpDir, "good.md"),
      makeArticleRaw("Good", [], "OK"),
    );
    // Write a binary/corrupted file with .md extension
    await fs.writeFile(
      path.join(tmpDir, "bad.md"),
      Buffer.from([0x00, 0xff, 0xfe]),
    );
    const result = await service.scanVault();
    // Should get at least the good file; bad file is skipped
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((a) => a.title === "Good")).toBe(true);
  });

  it("ignores non-.md files", async () => {
    await fs.writeFile(path.join(tmpDir, "readme.txt"), "not markdown");
    await fs.writeFile(
      path.join(tmpDir, "article.md"),
      makeArticleRaw("Article", [], "Body"),
    );
    const result = await service.scanVault();
    expect(result).toHaveLength(2);
    expect(result.find((a) => a.filename === "article.md")?.title).toBe("Article");
    expect(result.find((a) => a.filename === "readme.txt")?.title).toBe("readme.txt");
  });

  /**
   * Powers the file-tree "Ingested" badge — the renderer reads
   * `meta.sources` for every wiki page and treats any raw/ file referenced
   * there as ingested. Without this, the badge never lights up no matter
   * what's in the YAML.
   */
  it("populates ArticleMeta.sources from frontmatter (array form)", async () => {
    await fs.mkdir(path.join(tmpDir, "wiki", "sources"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "wiki", "sources", "foo.md"),
      `---
title: Foo
sources:
  - raw/foo.pdf
  - raw/bar.pdf
created: "2024-01-01T00:00:00Z"
modified: "2024-01-01T00:00:00Z"
---
Body
`,
    );
    const result = await service.scanVault();
    const meta = result.find((m) => m.filename === "wiki/sources/foo.md");
    expect(meta?.sources).toEqual(["raw/foo.pdf", "raw/bar.pdf"]);
  });

  it("populates ArticleMeta.sources from frontmatter (singular `source` form)", async () => {
    await fs.writeFile(
      path.join(tmpDir, "single.md"),
      `---
title: S
source: raw/only.pdf
created: "2024-01-01T00:00:00Z"
modified: "2024-01-01T00:00:00Z"
---
Body
`,
    );
    const meta = (await service.scanVault()).find((m) => m.filename === "single.md");
    expect(meta?.sources).toEqual(["raw/only.pdf"]);
  });

  it("omits `sources` from ArticleMeta entirely when not declared (no empty arrays)", async () => {
    await fs.writeFile(
      path.join(tmpDir, "plain.md"),
      makeArticleRaw("Plain", [], "no sources here"),
    );
    const meta = (await service.scanVault()).find((m) => m.filename === "plain.md");
    expect(meta?.sources).toBeUndefined();
  });
});

// ─── extractFrontmatterSources (helper) ────────────────────────────────────

describe("extractFrontmatterSources", () => {
  it("returns the array as-is when `sources` is an array of strings", () => {
    expect(
      extractFrontmatterSources({ sources: ["raw/a.pdf", "raw/b.pdf"] }),
    ).toEqual(["raw/a.pdf", "raw/b.pdf"]);
  });

  it("wraps a string `sources` into a single-entry array", () => {
    expect(extractFrontmatterSources({ sources: "raw/foo.pdf" })).toEqual([
      "raw/foo.pdf",
    ]);
  });

  it("accepts the singular `source` key as a convenience", () => {
    expect(extractFrontmatterSources({ source: "raw/foo.pdf" })).toEqual([
      "raw/foo.pdf",
    ]);
  });

  it("merges plural + singular keys (plural first)", () => {
    expect(
      extractFrontmatterSources({
        sources: ["raw/a.pdf"],
        source: "raw/b.pdf",
      }),
    ).toEqual(["raw/a.pdf", "raw/b.pdf"]);
  });

  it("trims whitespace and drops empty entries", () => {
    expect(
      extractFrontmatterSources({ sources: ["  raw/a.pdf  ", "", "   "] }),
    ).toEqual(["raw/a.pdf"]);
  });

  it("drops non-string entries silently (e.g. nested objects)", () => {
    // YAML `sources: [{更新: "..."}]` would parse to an array of objects.
    // Those have no meaningful match key, so we ignore them rather than
    // surface bogus ingest matches.
    expect(
      extractFrontmatterSources({
        sources: ["raw/a.pdf", { 更新: "2024-01-01" }, 42, null],
      }),
    ).toEqual(["raw/a.pdf"]);
  });

  it("returns [] when neither key is present", () => {
    expect(extractFrontmatterSources({})).toEqual([]);
  });

  it("returns [] when both keys are non-string non-array junk", () => {
    expect(
      extractFrontmatterSources({ sources: 42, source: { not: "valid" } }),
    ).toEqual([]);
  });
});

// ─── readArticle ────────────────────────────────────────────────────────────

describe("readArticle", () => {
  it("reads and parses an article file", async () => {
    const raw = makeArticleRaw("Read Me", ["tag1"], "Content here.");
    await fs.writeFile(path.join(tmpDir, "read-me.md"), raw);
    const article = await service.readArticle("read-me.md");
    expect(article.frontmatter.title).toBe("Read Me");
    expect(article.content).toContain("Content here.");
  });

  it("throws for non-existent file", async () => {
    await expect(service.readArticle("nope.md")).rejects.toThrow();
  });
});

// ─── writeArticle ───────────────────────────────────────────────────────────

describe("writeArticle", () => {
  it("writes article to disk with updated modified timestamp", async () => {
    const article: ArticleFile = {
      frontmatter: {
        title: "New Article",
        tags: ["write-test"],
        created: "2024-01-01T00:00:00Z",
        modified: "2024-01-01T00:00:00Z",
      },
      content: "\n# New Article\n\nSome content.\n",
      rawContent: "",
    };

    const before = new Date().toISOString();
    await service.writeArticle(article);

    const written = await fs.readFile(
      path.join(tmpDir, "New-Article.md"),
      "utf-8",
    );
    const parsed = parseArticleFile(written);
    expect(parsed.frontmatter.title).toBe("New Article");
    expect(parsed.frontmatter.modified >= before).toBe(true);
    expect(parsed.content).toContain("Some content.");
  });
});

// ─── deleteArticle ──────────────────────────────────────────────────────────

describe("deleteArticle", () => {
  it("removes a file from the vault", async () => {
    await fs.writeFile(
      path.join(tmpDir, "doomed.md"),
      makeArticleRaw("Doomed", [], "Bye"),
    );
    await service.deleteArticle("doomed.md");
    await expect(fs.access(path.join(tmpDir, "doomed.md"))).rejects.toThrow();
  });

  it("throws for non-existent file", async () => {
    await expect(service.deleteArticle("ghost.md")).rejects.toThrow();
  });
});

// ─── fileExists ─────────────────────────────────────────────────────────────

describe("fileExists", () => {
  it("returns true for existing file", async () => {
    await fs.writeFile(path.join(tmpDir, "exists.md"), "content");
    expect(await service.fileExists("exists.md")).toBe(true);
  });

  it("returns false for non-existent file", async () => {
    expect(await service.fileExists("nope.md")).toBe(false);
  });
});

// ─── bookmarks JSON ─────────────────────────────────────────────────────────

describe("getBookmarks / setBookmarks", () => {
  it("returns empty array when file is missing", async () => {
    expect(await service.getBookmarks()).toEqual([]);
  });

  it("writes and reads bookmarks.json under .lumina", async () => {
    await service.setBookmarks(["a.md", "b/c.md"]);
    const abs = path.join(tmpDir, ".lumina", "bookmarks.json");
    const raw = JSON.parse(await fs.readFile(abs, "utf-8"));
    expect(raw.version).toBe(1);
    expect(raw.filenames).toEqual(["a.md", "b/c.md"]);
    expect(await service.getBookmarks()).toEqual(["a.md", "b/c.md"]);
  });

  it("returns empty array for invalid JSON shape", async () => {
    const luminaDir = path.join(tmpDir, ".lumina");
    await fs.mkdir(luminaDir, { recursive: true });
    await fs.writeFile(
      path.join(luminaDir, "bookmarks.json"),
      JSON.stringify({ foo: 1 }),
      "utf-8",
    );
    expect(await service.getBookmarks()).toEqual([]);
  });
});

// ─── vault config JSON ───────────────────────────────────────────────────────

describe("getVaultConfig / saveVaultConfig", () => {
  it("returns default language when file is missing", async () => {
    expect(await service.getVaultConfig()).toEqual({ language: "en" });
  });

  it("writes and reads vault-config.json under .lumina", async () => {
    await service.saveVaultConfig({ language: "ja" });
    const abs = path.join(tmpDir, ".lumina", "vault-config.json");
    const raw = JSON.parse(await fs.readFile(abs, "utf-8"));
    expect(raw.language).toBe("ja");
    expect(await service.getVaultConfig()).toEqual({ language: "ja" });
  });

  it("merges partial updates with existing values", async () => {
    await service.saveVaultConfig({ language: "zh" });
    await service.saveVaultConfig({});
    expect(await service.getVaultConfig()).toEqual({ language: "zh" });
  });

  it("returns default language for invalid JSON shape", async () => {
    const luminaDir = path.join(tmpDir, ".lumina");
    await fs.mkdir(luminaDir, { recursive: true });
    await fs.writeFile(
      path.join(luminaDir, "vault-config.json"),
      JSON.stringify({ language: "de" }),
      "utf-8",
    );
    expect(await service.getVaultConfig()).toEqual({ language: "en" });
  });

  it("throws when saving an unsupported language", async () => {
    await expect(
      service.saveVaultConfig({ language: "de" as unknown as "en" }),
    ).rejects.toThrow("Invalid vault language");
  });
});

// ─── deleteVaultEntry ───────────────────────────────────────────────────────

describe("deleteVaultEntry", () => {
  it("removes a file by vault-relative path", async () => {
    await fs.mkdir(path.join(tmpDir, "raw"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "raw", "gone.pdf"),
      "pdf",
    );
    await service.deleteVaultEntry("raw/gone.pdf");
    await expect(fs.access(path.join(tmpDir, "raw", "gone.pdf"))).rejects.toThrow();
  });

  it("removes a folder recursively", async () => {
    await fs.mkdir(path.join(tmpDir, "wiki", "trash", "nested"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "wiki", "trash", "nested", "a.md"), "x");
    await service.deleteVaultEntry("wiki/trash");
    await expect(fs.access(path.join(tmpDir, "wiki", "trash"))).rejects.toThrow();
  });

  it("rejects deleting top-level wiki or raw folders", async () => {
    await expect(service.deleteVaultEntry("wiki")).rejects.toThrow(/top-level/);
    await expect(service.deleteVaultEntry("raw")).rejects.toThrow(/top-level/);
  });
});

// ─── moveVaultEntry / importExternalEntries ─────────────────────────────────

describe("moveVaultEntry", () => {
  it("moves a file into a subfolder", async () => {
    await fs.mkdir(path.join(tmpDir, "wiki", "inbox"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "wiki", "Note.md"),
      makeArticleRaw("Note", [], "Hi"),
    );
    await service.moveVaultEntry("wiki/Note.md", "wiki/inbox");
    expect(
      await fs.readFile(path.join(tmpDir, "wiki", "inbox", "Note.md"), "utf-8"),
    ).toContain("Hi");
    await expect(fs.access(path.join(tmpDir, "wiki", "Note.md"))).rejects.toThrow();
  });

  it("moves a folder with contents", async () => {
    await fs.mkdir(path.join(tmpDir, "wiki", "old", "nested"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tmpDir, "wiki", "old", "nested", "a.md"),
      makeArticleRaw("A", [], "x"),
    );
    await service.moveVaultEntry("wiki/old", "wiki");
    expect(
      await fs.readFile(
        path.join(tmpDir, "wiki", "old", "nested", "a.md"),
        "utf-8",
      ),
    ).toContain("x");
  });

  it("rejects moving a folder into its own descendant", async () => {
    await fs.mkdir(path.join(tmpDir, "wiki", "box", "inner"), {
      recursive: true,
    });
    await expect(
      service.moveVaultEntry("wiki/box", "wiki/box/inner"),
    ).rejects.toThrow(/into itself/);
  });

  it("rejects path traversal", async () => {
    await expect(
      service.moveVaultEntry("../../../etc/passwd", "wiki"),
    ).rejects.toThrow();
  });

  it("no-ops when source and destination are the same", async () => {
    await fs.mkdir(path.join(tmpDir, "wiki"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "wiki", "Same.md"),
      makeArticleRaw("Same", [], "ok"),
    );
    await service.moveVaultEntry("wiki/Same.md", "wiki");
    const raw = await fs.readFile(
      path.join(tmpDir, "wiki", "Same.md"),
      "utf-8",
    );
    expect(raw).toContain("ok");
  });
});

describe("importExternalEntries", () => {
  it("copies an external file into the vault", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "lumina-ext-"));
    const extFile = path.join(outside, "external-drop.txt");
    await fs.writeFile(extFile, "hello");
    await fs.mkdir(path.join(tmpDir, "wiki", "in"), { recursive: true });
    await service.importExternalEntries([extFile], "wiki/in");
    const got = await fs.readFile(
      path.join(tmpDir, "wiki", "in", "external-drop.txt"),
      "utf-8",
    );
    expect(got).toBe("hello");
    expect(await fs.readFile(extFile, "utf-8")).toBe("hello");
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("moves a vault path when source is inside the vault", async () => {
    await fs.mkdir(path.join(tmpDir, "wiki", "a"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "wiki", "a", "x.md"),
      makeArticleRaw("X", [], "body"),
    );
    await fs.mkdir(path.join(tmpDir, "wiki", "b"), { recursive: true });
    const absA = path.join(tmpDir, "wiki", "a", "x.md");
    await service.importExternalEntries([absA], "wiki/b");
    expect(
      await fs.readFile(path.join(tmpDir, "wiki", "b", "x.md"), "utf-8"),
    ).toContain("body");
    await expect(fs.access(absA)).rejects.toThrow();
  });
});

// ─── titleToFilename / filenameToTitle ──────────────────────────────────────

describe("titleToFilename / filenameToTitle", () => {
  it("delegates titleToFilename to shared parser", () => {
    expect(service.titleToFilename("Hello World")).toBe("Hello-World");
  });

  it("delegates filenameToTitle to shared parser", () => {
    expect(service.filenameToTitle("hello-world.md")).toBe("hello world");
  });
});

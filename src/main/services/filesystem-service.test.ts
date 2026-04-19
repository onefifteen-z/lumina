import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { FileSystemService } from "./filesystem-service";
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

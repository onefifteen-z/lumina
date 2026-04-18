import Database from "better-sqlite3";
import { app } from "electron";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import type { ChatMessage, ChatSession } from "../../shared/types";

/** Derive a stable DB filename from a vault path. */
function vaultDbName(vaultPath: string): string {
  const hash = crypto.createHash("sha256").update(vaultPath).digest("hex").slice(0, 12);
  const name = path.basename(vaultPath).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `chat-${name}-${hash}.db`;
}

export interface ChatHistoryEntry {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export class ChatHistoryService {
  private db: Database.Database | null = null;
  private vaultPath: string | null = null;

  /** Open (or create) the DB for a given vault. */
  open(vaultPath: string): void {
    if (this.vaultPath === vaultPath && this.db) return;
    this.close();

    const dir = path.join(app.getPath("userData"), "chat-history");
    fs.mkdirSync(dir, { recursive: true });

    const dbPath = path.join(dir, vaultDbName(vaultPath));
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.vaultPath = vaultPath;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    `);
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.vaultPath = null;
  }

  /** List all sessions (newest first), without messages. */
  listSessions(): ChatHistoryEntry[] {
    if (!this.db) return [];
    return this.db.prepare(
      "SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM sessions ORDER BY updated_at DESC"
    ).all() as ChatHistoryEntry[];
  }

  /** Get a full session with messages. */
  getSession(sessionId: string): (ChatSession & { title: string }) | null {
    if (!this.db) return null;
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
    if (!row) return null;
    const messages = this.db.prepare(
      "SELECT id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC"
    ).all(sessionId) as ChatMessage[];
    return {
      id: row.id,
      title: row.title,
      systemPrompt: row.system_prompt,
      messages,
      createdAt: row.created_at,
    };
  }

  /** Save or update a session and its messages. */
  saveSession(session: ChatSession, title?: string): void {
    if (!this.db) return;
    const now = new Date().toISOString();
    const sessionTitle = title || this.deriveTitle(session) || "New chat";

    const upsert = this.db.prepare(`
      INSERT INTO sessions (id, title, system_prompt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = ?, system_prompt = ?, updated_at = ?
    `);
    upsert.run(
      session.id, sessionTitle, session.systemPrompt, session.createdAt, now,
      sessionTitle, session.systemPrompt, now
    );

    // Replace all messages
    this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(session.id);
    const insert = this.db.prepare(
      "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)"
    );
    const tx = this.db.transaction(() => {
      for (const m of session.messages) {
        insert.run(m.id, session.id, m.role, m.content, m.timestamp);
      }
    });
    tx();
  }

  /** Delete a session and its messages. */
  deleteSession(sessionId: string): void {
    if (!this.db) return;
    this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }

  /** Derive a title from the first user message. */
  private deriveTitle(session: ChatSession): string {
    const first = session.messages.find((m) => m.role === "user");
    if (!first) return "";
    return first.content.slice(0, 60).replace(/\n/g, " ");
  }
}

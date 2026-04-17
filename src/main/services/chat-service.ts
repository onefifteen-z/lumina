import { randomUUID } from "crypto";
import { ChatSession, ChatMessage } from "../../shared/types";
import { LLMService } from "./llm-service";
import { FileSystemService } from "./filesystem-service";

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

// Candidate filenames for the vault-level CLAUDE.md system prompt
const CLAUDE_MD_CANDIDATES = [".CLAUDE.md", "CLAUDE.md", ".claude.md", "claude.md"];

const READ_FILE_TOOL = {
  type: "function" as const,
  function: {
    name: "read_vault_file",
    description: "Read the raw contents of a file from the vault by its vault-relative path (e.g. 'wiki/index.md').",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative file path" },
      },
      required: ["path"],
    },
  },
} as const;

export class ChatService {
  private session: ChatSession | null = null;
  private abortController: AbortController | null = null;
  private llm: LLMService | null;
  private fileSystem: FileSystemService | null;

  constructor(llm: LLMService | null, fileSystem: FileSystemService | null) {
    this.llm = llm;
    this.fileSystem = fileSystem;
  }

  /**
   * Create a new session, loading claude.md as system prompt.
   * Clears any existing session and message history.
   * Returns the session and an optional warning if claude.md had I/O issues.
   */
  async startSession(): Promise<{ session: ChatSession; warning?: string }> {
    const { prompt, warning } = await this.loadSystemPrompt();

    this.session = {
      id: randomUUID(),
      systemPrompt: prompt,
      messages: [],
      createdAt: new Date().toISOString(),
    };

    return { session: { ...this.session }, warning };
  }

  /**
   * Send a user message and stream the assistant response.
   * Runs a tool-calling loop first (reads vault files as requested by the LLM),
   * then streams the final text response.
   * Appends both user and assistant messages to session history.
   */
  async *sendMessage(content: string): AsyncGenerator<string> {
    if (!this.session) {
      throw new Error("No active chat session. Call startSession() first.");
    }

    if (!this.llm) {
      throw new Error("LLM service is not available.");
    }

    // Append user message to session
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content,
      timestamp: new Date().toISOString(),
    };
    this.session.messages.push(userMessage);

    // Create abort controller for this generation
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    // ── Tool-calling resolution loop ──────────────────────────────
    // Use non-streaming calls to resolve any read_vault_file tool calls
    // before switching to streaming for the final text response.
    const tools = this.fileSystem ? [READ_FILE_TOOL] : undefined;
    const extraMessages: Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }> = [];

    for (let i = 0; i < 10; i++) {
      if (signal.aborted) break;

      const allMessages = [
        { role: "system", content: this.session.systemPrompt },
        ...this.session.messages.map((m) => ({ role: m.role, content: m.content })),
        ...extraMessages,
      ];

      let result: Awaited<ReturnType<LLMService["callNonStreaming"]>>;
      try {
        result = await this.llm.callNonStreaming(allMessages, tools);
      } catch {
        break; // fall through to streaming attempt
      }

      if (!result.toolCalls || result.toolCalls.length === 0) break;

      // Execute each tool call
      const toolCallRecords = result.toolCalls;
      extraMessages.push({ role: "assistant", content: null, tool_calls: toolCallRecords });

      for (const tc of toolCallRecords) {
        let fileContent: string;
        try {
          const args = JSON.parse(tc.function.arguments) as { path?: string };
          const filePath = args.path ?? "";
          fileContent = await this.fileSystem!.readRawFile(filePath);
        } catch (err) {
          const parsed = (() => { try { return JSON.parse(tc.function.arguments) as { path?: string }; } catch { return {}; } })();
          fileContent = `Error: could not read file "${parsed.path ?? "unknown"}".`;
        }
        extraMessages.push({ role: "tool", tool_call_id: tc.id, content: fileContent });
      }
    }

    // ── Stream final text response ────────────────────────────────
    const finalMessages = [
      { role: "system", content: this.session.systemPrompt },
      ...this.session.messages.map((m) => ({ role: m.role, content: m.content })),
      ...extraMessages,
    ];

    let accumulated = "";

    try {
      for await (const chunk of this.llm.generateChat(finalMessages, signal)) {
        accumulated += chunk;
        yield chunk;
      }
    } catch (err: unknown) {
      if (!signal.aborted) {
        this.appendAssistantMessage(accumulated);
        this.abortController = null;
        throw err;
      }
    }

    this.appendAssistantMessage(accumulated);
    this.abortController = null;
  }

  /**
   * Abort the current streaming generation.
   * The partial response is retained in the session.
   */
  stopGeneration(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /** Get the current session state. */
  getSession(): ChatSession | null {
    return this.session;
  }

  /** Replace the LLM service instance (e.g. after the user updates their API key). */
  setLLMService(llm: LLMService | null): void {
    this.llm = llm;
  }

  /** Replace the FileSystem service instance (e.g. after vault switch). */
  setFileSystemService(fs: FileSystemService | null): void {
    this.fileSystem = fs;
  }

  /**
   * Read CLAUDE.md from vault root (tries several filename variants),
   * returns content or the default prompt.
   */
  private async loadSystemPrompt(): Promise<{
    prompt: string;
    warning?: string;
  }> {
    if (!this.fileSystem) {
      return { prompt: DEFAULT_SYSTEM_PROMPT };
    }

    for (const candidate of CLAUDE_MD_CANDIDATES) {
      try {
        const content = await this.fileSystem.readRawFile(candidate);
        if (content && content.trim().length > 0) {
          return { prompt: content };
        }
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code !== "ENOENT") {
          return {
            prompt: DEFAULT_SYSTEM_PROMPT,
            warning: `Failed to read ${candidate}: ${error.message ?? "Unknown error"}. Using default system prompt.`,
          };
        }
        // ENOENT → try next candidate
      }
    }

    return { prompt: DEFAULT_SYSTEM_PROMPT };
  }

  /** Helper to append an assistant message to the current session. */
  private appendAssistantMessage(content: string): void {
    if (!this.session) return;

    const assistantMessage: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      content,
      timestamp: new Date().toISOString(),
    };
    this.session.messages.push(assistantMessage);
  }
}

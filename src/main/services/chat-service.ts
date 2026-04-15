import { randomUUID } from "crypto";
import { ChatSession, ChatMessage } from "../../shared/types";
import { LLMService } from "./llm-service";
import { FileSystemService } from "./filesystem-service";

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

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
   * Yields content chunks as they arrive.
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

    // Build full message history: system prompt + all session messages
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: this.session.systemPrompt },
      ...this.session.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    ];

    // Create abort controller for this generation
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    let accumulated = "";

    try {
      for await (const chunk of this.llm.generateChat(messages, signal)) {
        accumulated += chunk;
        yield chunk;
      }
    } catch (err: unknown) {
      // If aborted, retain partial response — not an error
      if (signal.aborted) {
        // Partial response is kept as-is below
      } else {
        // Re-throw non-abort errors after saving partial content
        this.appendAssistantMessage(accumulated);
        this.abortController = null;
        throw err;
      }
    }

    // Append the final (or partial) assistant message
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

  /**
   * Read claude.md from vault root, return content or default prompt.
   * Returns a warning string if an I/O error occurs.
   */
  private async loadSystemPrompt(): Promise<{
    prompt: string;
    warning?: string;
  }> {
    if (!this.fileSystem) {
      return { prompt: DEFAULT_SYSTEM_PROMPT };
    }

    try {
      const content = await this.fileSystem.readRawFile("claude.md");
      if (!content || content.trim().length === 0) {
        return { prompt: DEFAULT_SYSTEM_PROMPT };
      }
      return { prompt: content };
    } catch (err: unknown) {
      // File not found — silent fallback
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOENT") {
        return { prompt: DEFAULT_SYSTEM_PROMPT };
      }

      // Other I/O errors — fallback with warning
      return {
        prompt: DEFAULT_SYSTEM_PROMPT,
        warning: `Failed to read claude.md: ${error.message ?? "Unknown error"}. Using default system prompt.`,
      };
    }
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

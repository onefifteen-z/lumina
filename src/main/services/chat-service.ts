import { randomUUID } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import { ChatSession, ChatMessage } from "../../shared/types";
import type { ChatChunk } from "../../shared/types";
import { LLMService } from "./llm-service";
import { FileSystemService } from "./filesystem-service";
import { startSpan } from "../telemetry";
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";

const execAsync = promisify(exec);
const SHELL_TIMEOUT_MS = 10_000;
const SHELL_MAX_BUFFER = 1024 * 1024; // 1 MiB stdout+stderr cap
const SHELL_OUTPUT_CHAR_LIMIT = 100_000;

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

// Candidate filenames for the vault-level CLAUDE.md system prompt
const CLAUDE_MD_CANDIDATES = [".CLAUDE.md", "CLAUDE.md", ".claude.md", "claude.md"];

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated ${text.length - max} chars]`;
}

function formatShellOutput(stdout: string, stderr: string, exitCode: number): string {
  const parts: string[] = [];
  if (stdout) parts.push(truncate(stdout.toString(), SHELL_OUTPUT_CHAR_LIMIT));
  if (stderr) parts.push(`[stderr]\n${truncate(stderr.toString(), 20_000)}`);
  parts.push(`[exit: ${exitCode}]`);
  return parts.join("\n");
}

const SHELL_TOOL = {
  type: "function" as const,
  function: {
    name: "shell",
    description:
      "Run a shell command with the vault root as the working directory. " +
      "Use standard Unix commands — `ls`, `cat`, `grep`, `find`, `head`, `tail`, `wc`, " +
      "`mkdir -p`, pipes/redirects, etc. Returns stdout, stderr and the exit code. " +
      "Commands time out after 10s and output is capped at ~100k chars.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The shell command to execute. Runs via /bin/sh -c with cwd set to the vault root.",
        },
      },
      required: ["command"],
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
  async *sendMessage(content: string): AsyncGenerator<ChatChunk> {
    if (!this.session) {
      throw new Error("No active chat session. Call startSession() first.");
    }
    if (!this.llm) {
      throw new Error("LLM service is not available.");
    }

    const parentSpan = startSpan("chat.message", {
      "openinference.span.kind": "CHAIN",
      "session.id": this.session.id,
      "input.value": content,
    });

    const ctx = parentSpan
      ? trace.setSpan(context.active(), parentSpan)
      : context.active();

    yield* context.with(ctx, () => this.executeMessage(content, parentSpan, ctx));
  }

  private async *executeMessage(
    content: string,
    parentSpan: import("@opentelemetry/api").Span | null,
    parentCtx?: Context,
  ): AsyncGenerator<ChatChunk> {
    // Append user message to session
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content,
      timestamp: new Date().toISOString(),
    };
    this.session!.messages.push(userMessage);

    // Create abort controller for this generation
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    let accumulated = "";

    try {
      // ── Tool-calling resolution loop ────────────────────────────
      const tools = this.fileSystem ? [SHELL_TOOL] : undefined;
      const extraMessages: Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }> = [];

      for (let i = 0; i < 10; i++) {
        if (signal.aborted) break;

        const allMessages = [
          { role: "system", content: this.session!.systemPrompt },
          ...this.session!.messages.map((m) => ({ role: m.role, content: m.content })),
          ...extraMessages,
        ];

        let result: Awaited<ReturnType<LLMService["callNonStreaming"]>>;
        try {
          result = await this.llm!.callNonStreaming(allMessages, tools, parentCtx);
        } catch {
          break;
        }

        if (result.content) {
          yield { type: 'narration', content: result.content };
        }

        if (!result.toolCalls || result.toolCalls.length === 0) break;

        const toolCallRecords = result.toolCalls;
        extraMessages.push({ role: "assistant", content: result.content, tool_calls: toolCallRecords });

        for (const tc of toolCallRecords) {
          yield {
            type: 'tool_call',
            id: tc.id,
            name: tc.function.name,
            args: tc.function.arguments,
          };
          const output = await this.executeTool(tc.function.name, tc.function.arguments);
          yield { type: 'tool_result', id: tc.id, output };
          extraMessages.push({ role: "tool", tool_call_id: tc.id, content: output });
        }
      }

      // ── Stream final text response ──────────────────────────────
      const finalMessages = [
        { role: "system", content: this.session!.systemPrompt },
        ...this.session!.messages.map((m) => ({ role: m.role, content: m.content })),
        ...extraMessages,
      ];

      try {
        const streamTools = extraMessages.length > 0 ? tools : undefined;
        for await (const chunk of this.llm!.generateChat(finalMessages, signal, streamTools, parentCtx)) {
          if (chunk.type === 'text') accumulated += chunk.content;
          yield chunk;
        }
      } catch (streamErr: unknown) {
        if (signal.aborted) {
          this.appendAssistantMessage(accumulated);
          this.abortController = null;
          return;
        }
        try {
          const fallback = await this.llm!.callNonStreaming(finalMessages);
          accumulated = fallback.content ?? "";
          if (accumulated) yield { type: 'text', content: accumulated };
        } catch {
          this.appendAssistantMessage(accumulated);
          this.abortController = null;
          throw streamErr;
        }
      }

      parentSpan?.setAttribute("output.value", accumulated);
      parentSpan?.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      parentSpan?.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      parentSpan?.end();
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
   * Dispatch a tool call. Currently only the `shell` tool is supported —
   * it runs the requested command with the vault root as its cwd.
   */
  private async executeTool(name: string, argsJson: string): Promise<string> {
    if (!this.fileSystem) {
      return "Error: filesystem service is not available.";
    }

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    } catch {
      return "Error: tool arguments were not valid JSON.";
    }

    if (name !== "shell") return `Error: unknown tool "${name}".`;

    const command = typeof args.command === "string" ? args.command : "";
    if (!command) return `Error: "command" is required.`;

    const cwd = this.fileSystem.getVaultPath();

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: SHELL_MAX_BUFFER,
      });
      return formatShellOutput(stdout, stderr, 0);
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        signal?: string;
      };
      if (e.killed && e.signal === "SIGTERM") {
        return `[timed out after ${SHELL_TIMEOUT_MS}ms]`;
      }
      const exitCode = typeof e.code === "number" ? e.code : 1;
      return formatShellOutput(e.stdout ?? "", e.stderr ?? e.message ?? "", exitCode);
    }
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

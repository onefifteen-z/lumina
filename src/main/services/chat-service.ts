import { randomUUID } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import { ChatSession, ChatMessage, ChatContentBlock } from "../../shared/types";
import type { ChatChunk } from "../../shared/types";
import { LLMService } from "./llm-service";
import { FileSystemService } from "./filesystem-service";
import { startSpan } from "../telemetry";
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import { debugLog } from "../debug-log";
import { readClaudeMdTemplate, readIngestMdTemplate } from "./template-service";
import { runIngestTool } from "./ingest-tool";

const execAsync = promisify(exec);
/**
 * Default `shell` timeout when the model omits `timeout_seconds`. 30s
 * covers `ls`, `grep`, `cat`, etc. comfortably while still failing fast
 * for a runaway find.
 */
const SHELL_DEFAULT_TIMEOUT_S = 30;
/**
 * Hard ceiling on the per-call `shell` timeout. The model can request up
 * to this much for slow operations (e.g. `pip install` from inside the
 * venv) but anything past 10 minutes is almost certainly a stalled
 * command we want to surface as an error rather than silently wait on.
 */
const SHELL_MAX_TIMEOUT_S = 600;
const SHELL_MAX_BUFFER = 1024 * 1024; // 1 MiB stdout+stderr cap
const SHELL_OUTPUT_CHAR_LIMIT = 100_000;

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

// Candidate filenames for the vault-level CLAUDE.md system prompt
const CLAUDE_MD_CANDIDATES = [".CLAUDE.md", "CLAUDE.md", ".claude.md", "claude.md"];

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated ${text.length - max} chars]`;
}

/**
 * Replace large `data:*;base64,...` payloads in chat history so follow-up turns
 * do not re-send megabytes of PNG/PDF bytes on every API call. Short URLs
 * (e.g. tiny icons) are kept. Exported for unit tests.
 */
export function stripHeavyDataUrlsFromText(text: string): string {
  if (!text) return text;
  // Only RFC-style base64 characters — do not allow \s here or trailing words
  // like " y" get swallowed as if they were part of the payload.
  return text.replace(
    /data:(?:image\/[\w.+-]+|application\/[\w.+-]+);base64,[A-Za-z0-9+/=]+/gi,
    (match) => {
      if (match.length < 900) return match;
      const approxKiB = (match.length / 1024).toFixed(1);
      return `[omitted ~${approxKiB} KiB base64 data URL from an earlier message]`;
    },
  );
}

/**
 * Clamp a model-supplied `timeout_seconds` value into the allowed range.
 * Non-numeric / missing → SHELL_DEFAULT_TIMEOUT_S. Bounds: [1, max].
 * Exported via test-only re-export below for unit tests.
 */
export function clampShellTimeout(raw: unknown): number {
  // null/undefined/empty-string mean "not specified" → use the default.
  // We special-case them because Number(null) === 0 and Number("") === 0,
  // which would otherwise clamp up to 1 and silently truncate every
  // legitimate "no timeout passed" call.
  if (raw === null || raw === undefined || raw === "") {
    return SHELL_DEFAULT_TIMEOUT_S;
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return SHELL_DEFAULT_TIMEOUT_S;
  if (n < 1) return 1;
  if (n > SHELL_MAX_TIMEOUT_S) return SHELL_MAX_TIMEOUT_S;
  // Round to integer seconds — sub-second precision adds nothing here and
  // surfaces oddly in error messages.
  return Math.round(n);
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
      `Commands default to ${SHELL_DEFAULT_TIMEOUT_S}s timeout (override via timeout_seconds, ` +
      `up to ${SHELL_MAX_TIMEOUT_S}s) and output is capped at ~100k chars.`,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The shell command to execute. Runs via /bin/sh -c with cwd set to the vault root.",
        },
        timeout_seconds: {
          type: "number",
          description:
            `Optional per-call timeout in seconds. Defaults to ${SHELL_DEFAULT_TIMEOUT_S}s; ` +
            `clamped to [1, ${SHELL_MAX_TIMEOUT_S}]. Use a higher value for slow operations ` +
            `(e.g. installs, large grep -r, builds).`,
        },
      },
      required: ["command"],
    },
  },
} as const;

/**
 * `ingest_source` lets the model extract content from a source file in the
 * vault (text / image / PDF / Office docs) without having to drive
 * markitdown / venv bootstrap / PDF rasterization itself via shell. See
 * `INGEST.md` (always appended to the system prompt) for the full
 * decision tree.
 */
const INGEST_TOOL = {
  type: "function" as const,
  function: {
    name: "ingest_source",
    description:
      "Extract content from a source file in the vault. Returns a structured " +
      "string the model can include in subsequent reasoning. Auto-dispatches " +
      "by extension: text files come back as text, images as markdown image " +
      "data URLs, PDFs/PPTX/XLSX/DOCX go through markitdown. Use mode='vision' " +
      "on PDFs for rasterized page images only when the user has enabled " +
      "\"PDF page images\" in Settings; otherwise vision falls back to markitdown. " +
      "See INGEST.md for the full protocol.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Vault-relative path to the source file (e.g. 'raw/foo.pdf').",
        },
        mode: {
          type: "string",
          enum: ["auto", "text", "vision"],
          description:
            "auto (default) dispatches by extension. text forces the markitdown " +
            "path. vision on .pdf: rasterized page images when PDF page images are enabled " +
            "in Settings; otherwise markitdown (same as text for PDFs).",
        },
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
  private pdfImageIngest = false;
  /**
   * Loader for the bundled CLAUDE.md template, used as a system-prompt
   * fallback when the vault has no CLAUDE.md (or the file is empty). Injected
   * so unit tests can stub it without hitting the filesystem.
   */
  private templateLoader: () => Promise<string | null>;
  /**
   * Loader for the bundled INGEST.md template (the model's content-extraction
   * protocol). Always appended to whichever CLAUDE.md ends up in use, so the
   * vault owner can keep their custom CLAUDE.md and still get the up-to-date
   * ingest protocol that ships with the app. Injected so tests can stub it
   * without hitting the filesystem.
   */
  private ingestTemplateLoader: () => Promise<string | null>;

  constructor(
    llm: LLMService | null,
    fileSystem: FileSystemService | null,
    templateLoader: () => Promise<string | null> = readClaudeMdTemplate,
    ingestTemplateLoader: () => Promise<string | null> = readIngestMdTemplate,
  ) {
    this.llm = llm;
    this.fileSystem = fileSystem;
    this.templateLoader = templateLoader;
    this.ingestTemplateLoader = ingestTemplateLoader;
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
   * Replace the in-memory session with one loaded from history. Use this when
   * the user picks a saved conversation in the sidebar — without it, subsequent
   * `sendMessage` calls would append to the wrong (auto-created) session and
   * the history sidebar would grow a new entry per send.
   */
  loadSession(session: ChatSession): ChatSession {
    this.session = {
      id: session.id,
      systemPrompt: session.systemPrompt,
      messages: session.messages.map((m) => ({ ...m })),
      createdAt: session.createdAt,
    };
    return { ...this.session, messages: this.session.messages.map((m) => ({ ...m })) };
  }

  /**
   * Send a user message and stream the assistant response.
   * Runs a tool-calling loop first (reads vault files as requested by the LLM),
   * then streams the final text response.
   * Appends both user and assistant messages to session history.
   */
  async *sendMessage(
    content: string,
    contentBlocks?: ChatContentBlock[],
    options?: { reloadClaudeMd?: boolean },
  ): AsyncGenerator<ChatChunk> {
    if (!this.session) {
      throw new Error("No active chat session. Call startSession() first.");
    }
    if (!this.llm) {
      throw new Error("LLM service is not available.");
    }

    if (options?.reloadClaudeMd) {
      const { prompt } = await this.loadSystemPrompt();
      this.session.systemPrompt = prompt;
    }

    const parentSpan = startSpan("chat.message", {
      "openinference.span.kind": "CHAIN",
      "session.id": this.session.id,
      "input.value": content,
    });

    const ctx = parentSpan
      ? trace.setSpan(context.active(), parentSpan)
      : context.active();

    yield* context.with(ctx, () =>
      this.executeMessage(content, parentSpan, ctx, contentBlocks),
    );
  }

  private async *executeMessage(
    content: string,
    parentSpan: import("@opentelemetry/api").Span | null,
    parentCtx?: Context,
    contentBlocks?: ChatContentBlock[],
  ): AsyncGenerator<ChatChunk> {
    // Append user message to session
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content,
      timestamp: new Date().toISOString(),
    };
    this.session!.messages.push(userMessage);
    const currentUserMessageId = userMessage.id;

    // Create abort controller for this generation
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    let accumulated = "";

    const toLlmMessageContent = (
      m: ChatMessage,
    ): string | ChatContentBlock[] => {
      const isCurrentMultimodal =
        m.id === currentUserMessageId &&
        m.role === "user" &&
        contentBlocks &&
        contentBlocks.length > 0;
      if (isCurrentMultimodal) {
        return contentBlocks;
      }
      if (m.role === "user" || m.role === "assistant") {
        return stripHeavyDataUrlsFromText(m.content);
      }
      return m.content;
    };

    try {
      // ── Tool-calling resolution loop ────────────────────────────
      // Both tools require a vault (shell needs a cwd; ingest_source needs
      // a vault root to resolve relative paths). When no vault is open we
      // pass undefined and the model is in chat-only mode.
      const tools = this.fileSystem ? [SHELL_TOOL, INGEST_TOOL] : undefined;
      const extraMessages: Array<{
        role: string;
        content: string | null | ChatContentBlock[];
        tool_calls?: unknown[];
        tool_call_id?: string;
      }> = [];

      // Bumped from 10 → 30 because a real ingest needs O(15-25) shell
      // calls (mkdir, install markitdown, convert, cat, then one cat-EOF
      // per wiki page, then index/log/glossary updates, then verify ls).
      // The loop is also bounded by the model's own decision to stop, so
      // 30 is a safety ceiling, not a typical count.
      for (let i = 0; i < 30; i++) {
        if (signal.aborted) break;
        debugLog("debug", "chat", `tool-loop iter ${i}`, {
          extraMessages: extraMessages.length,
        });

        const allMessages = [
          { role: "system", content: this.session!.systemPrompt },
          ...this.session!.messages.map((m) => ({
            role: m.role,
            content: toLlmMessageContent(m),
          })),
          ...extraMessages,
        ];

        let result: Awaited<ReturnType<LLMService["callNonStreaming"]>>;
        try {
          result = await this.llm!.callNonStreaming(allMessages, tools, parentCtx);
        } catch (err) {
          // Single retry on timeout: the heavy first-shot ingest call
          // (vision input + post-tool 43k-char prompts) can occasionally
          // exceed even the 120s ceiling. Without a retry we'd silently
          // drop into the streaming fallback (which can't issue more tool
          // calls), and the user would see "model promised to create
          // files but never did". One retry preserves that intent.
          const msg = (err as Error)?.message ?? "";
          const isTimeout = msg.toLowerCase().includes("timed out");
          if (isTimeout && !signal.aborted) {
            debugLog("warn", "chat", "tool-loop callNonStreaming timed out — retrying once", {
              message: msg,
            });
            try {
              result = await this.llm!.callNonStreaming(allMessages, tools, parentCtx);
            } catch (retryErr) {
              debugLog("warn", "chat", "tool-loop retry also failed — breaking loop", {
                message: (retryErr as Error)?.message,
              });
              // Surface the failure as narration so the sidebar doesn't
              // just silently deliver a stale-looking final answer.
              yield {
                type: 'narration',
                content: `\n\n⚠️ The model timed out twice in a row while planning the next step (likely too much context). The conversation may be incomplete — try sending a shorter follow-up message to continue.`,
              };
              break;
            }
          } else {
            debugLog("warn", "chat", "tool-loop callNonStreaming threw — breaking loop", {
              message: msg,
            });
            break;
          }
        }

        const toolCallRecords = result.toolCalls && result.toolCalls.length > 0
          ? result.toolCalls
          : null;

        if (result.content) {
          if (toolCallRecords) {
            // Intermediate "thinking aloud" before issuing more tool calls —
            // belongs in the thinking sidebar, not the final answer.
            yield { type: 'narration', content: result.content };
          } else {
            // The model has finished and returned the final answer in the
            // tool-loop reply itself. Emit it as text so it shows in the
            // chat bubble, accumulate it locally, and short-circuit out of
            // the loop *without* re-issuing a streaming request that would
            // otherwise regenerate the same answer (wasted ~5s TTFB +
            // duplicate tokens billed + duplicated content in the sidebar).
            debugLog("info", "chat", "tool-loop produced final answer — short-circuiting stream", {
              contentChars: result.content.length,
            });
            accumulated += result.content;
            yield { type: 'text', content: result.content };
          }
        }

        if (!toolCallRecords) break;
        extraMessages.push({ role: "assistant", content: result.content, tool_calls: toolCallRecords });

        // 1) Announce all tool calls up-front so the thinking sidebar
        //    populates immediately — without this users see a blank
        //    sidebar for the entire duration of the slowest call.
        for (const tc of toolCallRecords) {
          yield {
            type: 'tool_call',
            id: tc.id,
            name: tc.function.name,
            args: tc.function.arguments,
          };
        }

        // 2) Execute the calls concurrently and yield each result as it
        //    completes (rather than serialising on the slowest one).
        //    Note: we still append `role:'tool'` messages to extraMessages
        //    in the original tool_call order, since most providers expect
        //    tool replies to appear in the same order as the tool_calls
        //    on the preceding assistant turn.
        const outputs: string[] = new Array(toolCallRecords.length).fill("");
        for (const tc of toolCallRecords) {
          debugLog("info", "tool", `▶ ${tc.function.name}`, {
            id: tc.id,
            args: tc.function.arguments.slice(0, 300),
          });
        }
        const toolStarts = toolCallRecords.map(() => Date.now());
        const tracked = toolCallRecords.map((tc, i) =>
          this.executeTool(tc.function.name, tc.function.arguments).then(
            (output) => {
              debugLog("info", "tool", `■ ${tc.function.name} (${Date.now() - toolStarts[i]}ms)`, {
                id: tc.id,
                outputLen: output.length,
                outputPreview: output.slice(0, 200),
              });
              return { index: i, id: tc.id, output };
            },
          ),
        );
        const live: Array<Promise<{ index: number; id: string; output: string }> | null> = tracked.slice();
        for (let done = 0; done < tracked.length; done++) {
          if (signal.aborted) break;
          const stillLive = live.filter(
            (p): p is Promise<{ index: number; id: string; output: string }> => p !== null,
          );
          const winner = await Promise.race(stillLive);
          live[winner.index] = null;
          outputs[winner.index] = winner.output;
          yield { type: 'tool_result', id: winner.id, output: winner.output };
        }
        for (let i = 0; i < toolCallRecords.length; i++) {
          extraMessages.push({
            role: "tool",
            tool_call_id: toolCallRecords[i].id,
            content: outputs[i],
          });
        }
      }

      // ── Stream final text response ──────────────────────────────
      // Skip the streaming round-trip entirely if the tool-loop already
      // produced the final answer in its terminating non-streaming reply.
      if (accumulated) {
        debugLog("info", "chat", "skipping generateChat — final answer already emitted in tool loop", {
          accumulatedChars: accumulated.length,
        });
        parentSpan?.setAttribute("output.value", accumulated);
        parentSpan?.setStatus({ code: SpanStatusCode.OK });
        this.appendAssistantMessage(accumulated);
        this.abortController = null;
        return;
      }

      const finalMessages = [
        { role: "system", content: this.session!.systemPrompt },
        ...this.session!.messages.map((m) => ({
          role: m.role,
          content: toLlmMessageContent(m),
        })),
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

  /** Mirrors Settings → PDF page images; drives ingest_source vision behaviour. */
  setPdfImageIngest(enabled: boolean): void {
    this.pdfImageIngest = enabled;
  }

  /**
   * Dispatch a tool call. Two tools are exposed:
   *   - `shell` — run a shell command with vault root as cwd, with optional
   *     `timeout_seconds` clamped to [1, SHELL_MAX_TIMEOUT_S].
   *   - `ingest_source` — extract content from a vault source file via the
   *     ingest-tool module (handles markitdown, vision rasterize, etc.).
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

    if (name === "shell") {
      return this.executeShell(args);
    }
    if (name === "ingest_source") {
      // ingest-tool always returns a string and never throws — it formats
      // every failure into a `[ingest_source error kind=...]` body the
      // model can act on (matching INGEST.md's contract).
      return runIngestTool(args, {
        vaultRoot: this.fileSystem.getVaultPath(),
        pdfImageIngest: this.pdfImageIngest,
      });
    }
    return `Error: unknown tool "${name}".`;
  }

  /**
   * Run the `shell` tool with per-call timeout support.
   * `timeout_seconds` is clamped to [1, SHELL_MAX_TIMEOUT_S]; defaults to
   * SHELL_DEFAULT_TIMEOUT_S when omitted or non-numeric. We always echo
   * back the effective timeout in the timeout-error message so the model
   * can self-correct (e.g. retry with a higher value).
   */
  private async executeShell(args: Record<string, unknown>): Promise<string> {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command) return `Error: "command" is required.`;

    const timeoutS = clampShellTimeout(args.timeout_seconds);
    const cwd = this.fileSystem!.getVaultPath();

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: timeoutS * 1000,
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
        return `[timed out after ${timeoutS}s — retry with a higher timeout_seconds if the command genuinely needs longer]`;
      }
      const exitCode = typeof e.code === "number" ? e.code : 1;
      return formatShellOutput(e.stdout ?? "", e.stderr ?? e.message ?? "", exitCode);
    }
  }

  /**
   * Resolve the system prompt for a new chat session, with this priority:
   *   1. Vault-level CLAUDE.md (any of CLAUDE_MD_CANDIDATES) — non-empty wins.
   *   2. Bundled template at `assets/templates/CLAUDE.md` — used when the
   *      vault has no CLAUDE.md or the file is empty/whitespace-only.
   *   3. Hardcoded `DEFAULT_SYSTEM_PROMPT` — last-resort fallback if even
   *      the bundled template is missing (shouldn't happen in practice).
   *
   * The bundled INGEST.md is force-appended to (1) and (2) — never to (3).
   * This is a deliberate product contract: the user owns CLAUDE.md and can
   * rewrite it freely, but they cannot opt out of the ingest protocol. The
   * vault owner customising CLAUDE.md still benefits from the latest ingest
   * protocol shipped with the app version they're running, and shouldn't
   * have to copy-paste it. We don't append to the trivial default because
   * that path means everything else broke; muddling it with ingest
   * instructions would be confusing.
   *
   * Note: vault CLAUDE.md content is never trimmed or summarised before
   * appending INGEST.md — even a one-line vault CLAUDE.md gets the full
   * ingest protocol concatenated. If you ever want to add an "opt out of
   * INGEST.md" knob (e.g. a vault config flag), do it as an intentional
   * change here, not by adding a length/threshold heuristic.
   *
   * Read errors other than ENOENT are surfaced as a warning so the renderer
   * can show a banner; the session still proceeds with the next-best prompt.
   */
  private async loadSystemPrompt(): Promise<{
    prompt: string;
    warning?: string;
  }> {
    let warning: string | undefined;
    const base = await this.resolveBasePrompt((w) => {
      warning = warning ?? w;
    });
    if (base.kind === "default") return { prompt: base.prompt, warning };
    const ingest = await this.loadIngestTemplateSafe();
    return {
      prompt: ingest ? `${base.prompt}\n\n${ingest}` : base.prompt,
      warning,
    };
  }

  /**
   * Pick the base CLAUDE.md prompt (vault override, bundled template, or
   * trivial default). Returns the discriminator so the caller knows whether
   * to append INGEST.md.
   */
  private async resolveBasePrompt(
    reportWarning: (w: string) => void,
  ): Promise<{ kind: "vault" | "bundled" | "default"; prompt: string }> {
    if (this.fileSystem) {
      for (const candidate of CLAUDE_MD_CANDIDATES) {
        try {
          const content = await this.fileSystem.readRawFile(candidate);
          if (content && content.trim().length > 0) {
            return { kind: "vault", prompt: content };
          }
        } catch (err: unknown) {
          const error = err as NodeJS.ErrnoException;
          if (error.code !== "ENOENT") {
            reportWarning(
              `Failed to read ${candidate}: ${error.message ?? "Unknown error"}. Falling back to bundled template.`,
            );
          }
        }
      }
    }

    try {
      const tmpl = await this.templateLoader();
      if (tmpl && tmpl.trim().length > 0) {
        return { kind: "bundled", prompt: tmpl };
      }
    } catch {
      // fall through
    }

    return { kind: "default", prompt: DEFAULT_SYSTEM_PROMPT };
  }

  /** Load INGEST.md, swallowing any error — it's an enhancement, not a hard requirement. */
  private async loadIngestTemplateSafe(): Promise<string | null> {
    try {
      const tmpl = await this.ingestTemplateLoader();
      return tmpl && tmpl.trim().length > 0 ? tmpl : null;
    } catch {
      return null;
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

import { randomUUID } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import { ChatSession, ChatMessage, ChatContentBlock } from "../../shared/types";
import type { ChatChunk, VaultConfig, VaultLanguage } from "../../shared/types";
import { LLMService } from "./llm-service";
import { FileSystemService } from "./filesystem-service";
import { startSpan } from "../telemetry";
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import { debugLog } from "../debug-log";
import { readClaudeMdTemplate, readIngestMdTemplate } from "./template-service";
import {
  CLAUDE_MD_CANDIDATES,
  INGEST_MD_CANDIDATES,
} from "../../shared/vault-prompt-files";
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

/**
 * Tighter stdout cap applied only when the model does a *full* read (e.g.
 * `cat`) of a known large catalog file. These hub files grow unbounded as
 * the wiki expands, and re-reading them whole on every ingest is the main
 * driver of tool-loop context blowup / timeouts. We cap low and nudge the
 * model toward `grep`/`head` for targeted reads.
 */
const CATALOG_OUTPUT_CHAR_LIMIT = 12_000;
const CATALOG_FILE_RE = /\bwiki\/(?:index|glossary|overview|log)\.md\b/i;
const NARROWING_CMD_RE = /\b(?:grep|egrep|fgrep|rg|head|tail|wc|sed|awk)\b/i;

/**
 * Tool-loop context compaction. The loop re-sends every prior tool result
 * on each `callNonStreaming`, so large outputs (ingest extraction, `cat` of
 * catalog files) accumulate O(n²) and eventually blow the planning timeout.
 * We keep the most recent results full (the model is likely still acting on
 * them) and elide older oversized ones to a short placeholder.
 */
const TOOL_RESULT_KEEP_FULL = 2;
const TOOL_RESULT_ELIDE_OVER = 4_000;

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
const DEFAULT_VAULT_LANGUAGE: VaultLanguage = "en";
const VAULT_LANGUAGE_PROMPT: Record<VaultLanguage, string> = {
  en: "English",
  ja: "Japanese",
  zh: "Chinese",
};


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
 * Strip heavy inline base64 from a content-block array (the `image_url` blocks
 * we inject after an image/PDF ingest). The bytes only need to reach the model
 * once — on the turn right after the ingest — so on older turns we swap each
 * heavy `image_url` block for a tiny text placeholder and run the text blocks
 * through `stripHeavyDataUrlsFromText`. `file_id`-referenced images carry no
 * inline bytes, so they're left untouched. Returns the same array reference
 * when nothing changed. Exported for unit tests.
 */
export function stripHeavyDataUrlsFromBlocks(
  blocks: ChatContentBlock[],
): ChatContentBlock[] {
  let changed = false;
  const out = blocks.map((b): ChatContentBlock => {
    if (
      b.type === "image_url" &&
      typeof b.image_url?.url === "string" &&
      /^data:[^;]+;base64,/.test(b.image_url.url) &&
      b.image_url.url.length >= 900
    ) {
      changed = true;
      const approxKiB = (b.image_url.url.length / 1024).toFixed(1);
      return {
        type: "text",
        text: `[omitted ~${approxKiB} KiB base64 image from an earlier ingest — already processed]`,
      };
    }
    if (b.type === "text" && typeof b.text === "string") {
      const stripped = stripHeavyDataUrlsFromText(b.text);
      if (stripped !== b.text) {
        changed = true;
        return { ...b, text: stripped };
      }
    }
    return b;
  });
  return changed ? out : blocks;
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

function formatShellOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
  stdoutLimit: number = SHELL_OUTPUT_CHAR_LIMIT,
  truncationHint?: string,
): string {
  const parts: string[] = [];
  if (stdout) {
    const s = stdout.toString();
    if (s.length > stdoutLimit) {
      const hint = truncationHint ? ` ${truncationHint}` : "";
      parts.push(
        `${s.slice(0, stdoutLimit)}\n…[truncated ${s.length - stdoutLimit} chars]${hint}`,
      );
    } else {
      parts.push(s);
    }
  }
  if (stderr) parts.push(`[stderr]\n${truncate(stderr.toString(), 20_000)}`);
  parts.push(`[exit: ${exitCode}]`);
  return parts.join("\n");
}

/**
 * True when `command` does a full read (not grep/head/tail/wc/sed/awk) of a
 * known large catalog file. Used to apply a tighter stdout cap. Exported
 * for unit tests.
 */
export function isCatalogFullRead(command: string): boolean {
  return CATALOG_FILE_RE.test(command) && !NARROWING_CMD_RE.test(command);
}

type LlmMessage = {
  role: string;
  content: string | null | ChatContentBlock[];
  tool_calls?: unknown[];
  tool_call_id?: string;
};

/**
 * Tool result is an `ingest_source` extraction (text/image/office/file
 * upload). Detected by the status header the tool always emits as its first
 * line (see `header()` in ingest-tool.ts). These carry the *only* copy of a
 * source's content the model has to write wiki pages from, so they are
 * exempt from elision — losing them mid-ingest silently drops document
 * content from the wiki pages the model writes afterwards.
 */
function isIngestToolResult(content: string): boolean {
  return /^\[ingest_source (?:ok|error) /.test(content);
}

/**
 * Compact a tool-loop message list before sending. The loop re-sends every
 * prior message on each planning call, so without compaction large outputs
 * (and inline base64 image/PDF bytes) accumulate O(n²) and blow the context
 * window / planning timeout.
 *
 * We define a "recent window" = every message at or after the earliest of the
 * last `TOOL_RESULT_KEEP_FULL` tool results. Messages in that window are left
 * fully intact (including base64) so the model can still see whatever it's
 * actively acting on. For everything *older* than the window:
 *
 *   - non-`ingest_source` tool results over `TOOL_RESULT_ELIDE_OVER` chars are
 *     elided to a one-line placeholder (re-runnable shell/search output);
 *   - `ingest_source` results keep their extracted text (it's the only copy of
 *     the source the model writes wiki pages from) but have heavy inline base64
 *     stripped — the image/PDF bytes only need to reach the model once;
 *   - any message's inline base64 (tool text, assistant/user text, or injected
 *     `image_url` content blocks) is stripped so it isn't re-sent every turn.
 *
 * Returns a new array; does not mutate the input. Exported for unit tests.
 */
export function compactExtraMessages(msgs: LlmMessage[]): LlmMessage[] {
  const toolIdxs: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "tool" && typeof msgs[i].content === "string") {
      toolIdxs.push(i);
    }
  }
  if (toolIdxs.length <= TOOL_RESULT_KEEP_FULL) return msgs;
  // Earliest index still considered "recent" — kept fully intact.
  const keepFromIdx = toolIdxs[toolIdxs.length - TOOL_RESULT_KEEP_FULL];
  return msgs.map((m, i) => {
    if (i >= keepFromIdx) return m;

    // Older tool result: elide non-ingest output, otherwise strip its base64.
    if (m.role === "tool" && typeof m.content === "string") {
      const content = m.content;
      if (
        !isIngestToolResult(content) &&
        content.length > TOOL_RESULT_ELIDE_OVER
      ) {
        const firstLine = (content.split("\n", 1)[0] ?? "").slice(0, 200);
        return {
          ...m,
          content:
            `${firstLine}\n[earlier tool result elided to save context — ` +
            `${content.length} chars. Re-run the command if you need it again.]`,
        };
      }
      const stripped = stripHeavyDataUrlsFromText(content);
      return stripped === content ? m : { ...m, content: stripped };
    }

    // Older content-block message (e.g. the injected image attachments).
    if (Array.isArray(m.content)) {
      const stripped = stripHeavyDataUrlsFromBlocks(m.content);
      return stripped === m.content ? m : { ...m, content: stripped };
    }

    // Older plain-text message (assistant narration / user text).
    if (typeof m.content === "string") {
      const stripped = stripHeavyDataUrlsFromText(m.content);
      return stripped === m.content ? m : { ...m, content: stripped };
    }

    return m;
  });
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

/**
 * `request_user_confirmation` pops a confirm/cancel prompt above the chat
 * input and returns the user's choice. Meant for *anything* that would
 * mutate the user's vault or system in a way they might not want — e.g.
 * "about to overwrite wiki/index.md", "about to delete 3 files", etc.
 *
 * The tool returns one of two strings; see CLAUDE.md for the protocol.
 * We explicitly don't include a free-form "reason" separate from the
 * title/description because the model's only job after calling this is
 * to wait for the reply and branch.
 */
const CONFIRM_TOOL = {
  type: "function" as const,
  function: {
    name: "request_user_confirmation",
    description:
      "Show the user a confirm/cancel prompt directly above the chat input and " +
      "wait for their response. Returns \"[confirm ok]\" on approval or " +
      "\"[confirm cancelled]\" on decline. Use before any destructive or " +
      "user-visible change: overwriting a wiki page, deleting files, running " +
      "a non-trivial migration. DO NOT use for routine reads or small edits " +
      "the user already asked for — it wastes a round-trip and annoys them.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Short headline shown at the top of the prompt (≤ ~60 chars). " +
            "Phrase it as a yes/no question, e.g. \"Update wiki/index.md with 4 new entries?\".",
        },
        description: {
          type: "string",
          description:
            "Optional supporting text (plain text, no markdown). Use it to list " +
            "specifics — filenames, counts, anything the user needs to decide.",
        },
        confirm_label: {
          type: "string",
          description:
            "Optional label for the confirm button. Defaults to \"Continue\". " +
            "Prefer a verb that names the action: \"Update\", \"Delete\", \"Overwrite\".",
        },
        cancel_label: {
          type: "string",
          description:
            "Optional label for the cancel button. Defaults to \"Cancel\".",
        },
        tone: {
          type: "string",
          enum: ["default", "warning", "danger"],
          description:
            "Visual tone. Use \"danger\" for destructive actions (delete, overwrite " +
            "without backup), \"warning\" for changes that alter shape but not lose " +
            "data, and \"default\" otherwise.",
        },
      },
      required: ["title"],
    },
  },
} as const;

/**
 * `search_wiki` lets the model locate relevant wiki pages by keyword using
 * the app's FlexSearch index (title + excerpt + tags), instead of `cat`-ing
 * large catalog files like `wiki/index.md`. Returns a compact list of
 * `title | filename | excerpt` lines the model can use to decide which
 * specific pages to read in full.
 */
const SEARCH_WIKI_TOOL = {
  type: "function" as const,
  function: {
    name: "search_wiki",
    description:
      "Search the wiki by keyword and get back matching pages (title, " +
      "filename, short excerpt). Prefer this over `cat wiki/index.md` to " +
      "find relevant pages — then read only the specific pages you need. " +
      "Returns the top matches ranked by relevance.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords to search for (matches title, excerpt, tags).",
        },
        limit: {
          type: "number",
          description: "Max results to return. Defaults to 8, capped at 20.",
        },
      },
      required: ["query"],
    },
  },
} as const;

export class ChatService {
  private session: ChatSession | null = null;
  private abortController: AbortController | null = null;
  private llm: LLMService | null;
  private fileSystem: FileSystemService | null;
  private pdfImageIngest = false;
  private fileIngest = false;
  /**
   * Optional wiki search provider (the app's FlexSearch index). When set,
   * the `search_wiki` tool is advertised to the model. Structural type keeps
   * this module decoupled from SearchIndexService for testability.
   */
  private searchIndex:
    | {
        search(
          query: string,
        ): Promise<
          Array<{ title: string; filename: string; excerpt: string }>
        >;
      }
    | null = null;
  /**
   * Generic user-confirmation channel (renderer-backed yes/no prompt).
   * Injected by the IPC layer. `null` means "don't prompt" — matches the
   * legacy silent behaviour used by unit tests that don't run a renderer.
   *
   * Used for:
   *   - the one-time Python venv + markitdown install consent gate,
   *   - the model-callable `request_user_confirmation` tool.
   */
  private confirmations: {
    request: (opts: {
      title: string;
      description?: string;
      confirmLabel?: string;
      cancelLabel?: string;
      tone?: "default" | "warning" | "danger";
    }) => Promise<boolean>;
  } | null = null;
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
      // `request_user_confirmation` needs the renderer-backed prompt
      // channel. Without it the tool couldn't actually display anything,
      // so we only advertise it to the model when a confirmation service
      // has been wired (i.e. when running in the real app, not in unit
      // tests that stand up a ChatService directly).
      const tools = this.fileSystem
        ? [
            SHELL_TOOL,
            INGEST_TOOL,
            ...(this.confirmations ? [CONFIRM_TOOL] : []),
            ...(this.searchIndex ? [SEARCH_WIKI_TOOL] : []),
          ]
        : undefined;
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
          ...compactExtraMessages(extraMessages),
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
        const allContentBlocks: ChatContentBlock[] = [];
        for (const tc of toolCallRecords) {
          debugLog("info", "tool", `▶ ${tc.function.name}`, {
            id: tc.id,
            args: tc.function.arguments.slice(0, 300),
          });
        }
        const toolStarts = toolCallRecords.map(() => Date.now());
        const tracked = toolCallRecords.map((tc, i) =>
          this.executeTool(tc.function.name, tc.function.arguments).then(
            (result) => {
              debugLog("info", "tool", `■ ${tc.function.name} (${Date.now() - toolStarts[i]}ms)`, {
                id: tc.id,
                outputLen: result.output.length,
                outputPreview: result.output.slice(0, 200),
              });
              return { index: i, id: tc.id, ...result };
            },
          ),
        );
        const live: Array<Promise<{ index: number; id: string; output: string; contentBlocks?: ChatContentBlock[] }> | null> = tracked.slice();
        for (let done = 0; done < tracked.length; done++) {
          if (signal.aborted) break;
          const stillLive = live.filter(
            (p): p is Promise<{ index: number; id: string; output: string; contentBlocks?: ChatContentBlock[] }> => p !== null,
          );
          const winner = await Promise.race(stillLive);
          live[winner.index] = null;
          outputs[winner.index] = winner.output;
          if (winner.contentBlocks?.length) {
            allContentBlocks.push(...winner.contentBlocks);
          }
          yield { type: 'tool_result', id: winner.id, output: winner.output };
        }
        for (let i = 0; i < toolCallRecords.length; i++) {
          extraMessages.push({
            role: "tool",
            tool_call_id: toolCallRecords[i].id,
            content: outputs[i],
          });
        }
        // Inject uploaded file content blocks so the model can "see" them
        if (allContentBlocks.length > 0) {
          extraMessages.push({
            role: "user",
            content: [
              { type: "text", text: "The following files have been uploaded and are attached for your reference:" } as ChatContentBlock,
              ...allContentBlocks,
            ],
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
        ...compactExtraMessages(extraMessages),
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
    // Re-apply the current fileIngest setting so a freshly-built LLMService
    // (e.g. after the user switches provider) lands with the right transport
    // selection. Without this, the new instance defaults to Chat Completions
    // until the next setFileIngest call.
    llm?.setFileIngest(this.fileIngest);
  }

  /** Replace the FileSystem service instance (e.g. after vault switch). */
  setFileSystemService(fs: FileSystemService | null): void {
    this.fileSystem = fs;
  }

  /**
   * Register (or clear) the wiki search provider. When set, the model gets
   * a `search_wiki` tool so it can find pages by keyword instead of reading
   * the whole index. Re-set after a vault switch (the index is rebuilt).
   */
  setSearchIndex(
    index:
      | {
          search(
            query: string,
          ): Promise<
            Array<{ title: string; filename: string; excerpt: string }>
          >;
        }
      | null,
  ): void {
    this.searchIndex = index;
  }

  /** Mirrors Settings → PDF page images; drives ingest_source vision behaviour. */
  setPdfImageIngest(enabled: boolean): void {
    this.pdfImageIngest = enabled;
  }

  /**
   * Mirrors Settings → OpenAI File Upload; drives ingest_source file-upload
   * behaviour. Also forwards to the LLMService so it can flip the chat
   * transport to the OpenAI Responses API on the next call — without this,
   * the toggle would loosen ingest dispatch but the wire format would still
   * be Chat Completions, which rejects file_id for non-PDF MIME types.
   */
  setFileIngest(enabled: boolean): void {
    this.fileIngest = enabled;
    this.llm?.setFileIngest(enabled);
  }

  /**
   * Register (or clear) the confirmation service used for user yes/no
   * prompts. When `null`, ingest skips the venv-install consent prompt
   * and the `request_user_confirmation` tool returns an error explaining
   * it's unavailable. We take a structural type rather than importing
   * `ConfirmationService` directly to keep this module test-friendly.
   */
  setConfirmationService(
    service: {
      request: (opts: {
        title: string;
        description?: string;
        confirmLabel?: string;
        cancelLabel?: string;
        tone?: "default" | "warning" | "danger";
      }) => Promise<boolean>;
    } | null,
  ): void {
    this.confirmations = service;
  }

  /**
   * Dispatch a tool call. Two tools are exposed:
   *   - `shell` — run a shell command with vault root as cwd, with optional
   *     `timeout_seconds` clamped to [1, SHELL_MAX_TIMEOUT_S].
   *   - `ingest_source` — extract content from a vault source file via the
   *     ingest-tool module (handles markitdown, vision rasterize, etc.).
   */
  private async executeTool(name: string, argsJson: string): Promise<{ output: string; contentBlocks?: ChatContentBlock[] }> {
    if (!this.fileSystem) {
      return { output: "Error: filesystem service is not available." };
    }

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    } catch {
      return { output: "Error: tool arguments were not valid JSON." };
    }

    if (name === "shell") {
      return { output: await this.executeShell(args) };
    }
    if (name === "request_user_confirmation") {
      return { output: await this.executeConfirmation(args) };
    }
    if (name === "search_wiki") {
      return { output: await this.executeSearchWiki(args) };
    }
    if (name === "ingest_source") {
      // ingest-tool always returns a string and never throws — it formats
      // every failure into a `[ingest_source error kind=...]` body the
      // model can act on (matching INGEST.md's contract).
      return runIngestTool(args, {
        vaultRoot: this.fileSystem.getVaultPath(),
        pdfImageIngest: this.pdfImageIngest,
        fileIngest: this.fileIngest,
        // Loosen file-upload dispatch to all OFFICE_EXTENSIONS when the
        // chat transport is the OpenAI Responses API (its `input_file`
        // content part accepts pptx/xlsx/docx/etc., unlike Chat
        // Completions). Mirrored exactly from LLMService so the toggle
        // and the wire format stay in lockstep.
        responsesApi:
          this.fileIngest && (this.llm?.isOpenAiEndpoint() ?? false),
        uploadFile: this.llm
          ? (filePath: string, purpose?: string) =>
              this.llm!.uploadFile(filePath, purpose)
          : undefined,
        requestVenvConsent: this.confirmations
          ? () =>
              this.confirmations!.request({
                title: "Install Python tools for document ingestion?",
                description:
                  "Lumina needs to create a Python virtual environment at ~/.lumina/venv and install markitdown to read PDFs, Office files, and similar formats. This downloads ~200 MB and only happens once.",
                confirmLabel: "Install",
                cancelLabel: "Cancel",
                tone: "default",
              })
          : undefined,
      });
    }
    return { output: `Error: unknown tool "${name}".` };
  }

  /**
   * Run the `search_wiki` tool: keyword search over the FlexSearch index,
   * returning a compact `title | filename | excerpt` list. Keeps output
   * small so the model can pick specific pages to read without pulling the
   * whole catalog into context.
   */
  private async executeSearchWiki(args: Record<string, unknown>): Promise<string> {
    if (!this.searchIndex) {
      return "[search_wiki error]\nWiki search is unavailable. Fall back to `grep -i '<term>' wiki/index.md`.";
    }
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return "[search_wiki error]\nA non-empty `query` is required.";
    }
    const rawLimit =
      typeof args.limit === "number" ? args.limit : Number(args.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(20, Math.max(1, Math.round(rawLimit)))
      : 8;

    let results: Array<{ title: string; filename: string; excerpt: string }>;
    try {
      results = await this.searchIndex.search(query);
    } catch (err) {
      return `[search_wiki error]\nSearch failed: ${(err as Error).message ?? "unknown error"}`;
    }
    if (results.length === 0) {
      return `[search_wiki ok]\nNo pages matched "${query}".`;
    }
    const lines = results.slice(0, limit).map((r) => {
      const excerpt = (r.excerpt ?? "").replace(/\s+/g, " ").slice(0, 200);
      return `- ${r.title} | ${r.filename} | ${excerpt}`;
    });
    return `[search_wiki ok]\n${lines.length} of ${results.length} matches for "${query}":\n${lines.join("\n")}`;
  }

  /**
   * Run the `request_user_confirmation` tool. Returns a short status line
   * the model can branch on, keeping the contract symmetrical with the
   * other tools (first line = machine-readable header, rest = detail).
   */
  private async executeConfirmation(args: Record<string, unknown>): Promise<string> {
    if (!this.confirmations) {
      return (
        `[confirm error no-channel]\nThis build of Lumina has no UI channel ` +
        `for confirmations — proceed without asking, or surface the decision ` +
        `to the user as a chat message.`
      );
    }

    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) {
      return `[confirm error bad-args]\n"title" is required and must be a non-empty string.`;
    }

    const description =
      typeof args.description === "string" ? args.description : undefined;
    const confirmLabel =
      typeof args.confirm_label === "string" ? args.confirm_label : undefined;
    const cancelLabel =
      typeof args.cancel_label === "string" ? args.cancel_label : undefined;
    let tone: "default" | "warning" | "danger" | undefined;
    if (args.tone === "default" || args.tone === "warning" || args.tone === "danger") {
      tone = args.tone;
    }

    let approved = false;
    try {
      approved = await this.confirmations.request({
        title,
        description,
        confirmLabel,
        cancelLabel,
        tone,
      });
    } catch (err) {
      // The confirmation service is designed not to throw, but belt-and-
      // suspenders: a failed prompt should never crash the tool loop. We
      // treat failures as "cancel" so the model doesn't accidentally
      // proceed with a destructive action on error.
      return (
        `[confirm error dispatch-failed]\nFailed to show confirmation prompt: ` +
        `${(err as Error).message ?? "unknown error"}. Treating as cancel.`
      );
    }

    return approved
      ? `[confirm ok]\nThe user approved the action. Proceed.`
      : `[confirm cancelled]\nThe user declined the action. Do NOT proceed; explain what was not done and ask what they'd like instead.`;
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

    const catalogRead = isCatalogFullRead(command);
    const stdoutLimit = catalogRead
      ? CATALOG_OUTPUT_CHAR_LIMIT
      : SHELL_OUTPUT_CHAR_LIMIT;
    const truncationHint = catalogRead
      ? "This is a large catalog file — prefer `grep -i '<term>' <file>` or `head` for targeted reads instead of cat."
      : undefined;

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: timeoutS * 1000,
        maxBuffer: SHELL_MAX_BUFFER,
      });
      return formatShellOutput(stdout, stderr, 0, stdoutLimit, truncationHint);
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
   * INGEST.md is resolved independently with the same vault-first rule:
   *   1. Vault-level INGEST.md (any of INGEST_MD_CANDIDATES) — non-empty wins.
   *   2. Bundled template at `assets/templates/INGEST.md` — when the vault
   *      has no INGEST.md or the file is empty/whitespace-only.
   *
   * The resolved CLAUDE and INGEST parts are concatenated for (1)/(2) CLAUDE
   * paths — never for the trivial CLAUDE default (3), because that path means
   * everything else broke.
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
    const language = await this.loadVaultLanguage();
    if (base.kind === "default") {
      return { prompt: this.withVaultLanguagePolicy(base.prompt, language), warning };
    }
    const ingest = await this.resolveIngestPrompt((w) => {
      warning = warning ?? w;
    });
    const promptWithIngest = ingest ? `${base.prompt}\n\n${ingest}` : base.prompt;
    return {
      prompt: this.withVaultLanguagePolicy(promptWithIngest, language),
      warning,
    };
  }

  private withVaultLanguagePolicy(
    prompt: string,
    language: VaultLanguage | null,
  ): string {
    if (!language) return prompt;
    const languageLabel = VAULT_LANGUAGE_PROMPT[language];
    const policy = [
      "## Vault language policy",
      `- The wiki language for this vault is ${languageLabel}.`,
      `- Write wiki page titles, file names, summaries, and body text in ${languageLabel}.`,
      "- Keep folder names in English/romaji unless the user explicitly asks otherwise.",
    ].join("\n");
    return `${prompt}\n\n${policy}`;
  }

  private async loadVaultLanguage(): Promise<VaultLanguage | null> {
    if (!this.fileSystem) return DEFAULT_VAULT_LANGUAGE;
    const fsWithVaultConfig = this.fileSystem as FileSystemService & {
      getVaultConfig?: () => Promise<VaultConfig>;
    };
    if (typeof fsWithVaultConfig.getVaultConfig !== "function") {
      return null;
    }
    try {
      const cfg = await fsWithVaultConfig.getVaultConfig();
      if (cfg.language === "en" || cfg.language === "ja" || cfg.language === "zh") {
        return cfg.language;
      }
      return DEFAULT_VAULT_LANGUAGE;
    } catch {
      return DEFAULT_VAULT_LANGUAGE;
    }
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

  /**
   * Pick the INGEST.md prompt (vault override or bundled template).
   */
  private async resolveIngestPrompt(
    reportWarning: (w: string) => void,
  ): Promise<string | null> {
    if (this.fileSystem) {
      for (const candidate of INGEST_MD_CANDIDATES) {
        try {
          const content = await this.fileSystem.readRawFile(candidate);
          if (content && content.trim().length > 0) {
            return content;
          }
        } catch (err: unknown) {
          const error = err as NodeJS.ErrnoException;
          if (error.code !== "ENOENT") {
            reportWarning(
              `Failed to read ${candidate}: ${error.message ?? "Unknown error"}. Falling back to bundled INGEST.md.`,
            );
          }
        }
      }
    }

    return this.loadIngestTemplateSafe();
  }

  /** Load bundled INGEST.md, swallowing any error. */
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

import { LLMProviderConfig } from "../../shared/types";
import type { ChatChunk } from "../../shared/types";
import type { ChatContentBlock } from "../../shared/types";
import { startSpan } from "../telemetry";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import { debugLog } from "../debug-log";
import fs from "fs/promises";
import path from "path";

/** Error thrown for LLM-specific failures with categorized error types. */
export class LLMError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "network"
      | "auth"
      | "rate_limit"
      | "timeout"
      | "malformed_response"
      | "unknown",
    public readonly statusCode?: number,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

/**
 * Connection / non-streaming-completion timeout. Set high enough to cover
 * worst-case calls from the chat tool-loop:
 *   - large vision-input prompts (e.g. 36-page PDF rasterized to PNGs)
 *     stuffed into the prompt take 15–25s to upload + process;
 *   - on top of that the model thinks for another 10–30s when the tool
 *     output it just received is itself huge (e.g. a 43k-char `cat`).
 *
 * The previous 30s budget was tripping `tool-loop callNonStreaming threw`
 * mid-flow, which dropped the loop into the streaming fallback path —
 * and that fallback path forces `tool_choice: 'none'`, so the model
 * could no longer call shell to actually create the files it had just
 * decided to create. The user-visible symptom was "model says it will
 * create wiki pages but never does".
 */
const DEFAULT_TIMEOUT_MS = 120_000;
const TIMEOUT_SECONDS = DEFAULT_TIMEOUT_MS / 1000;

export class LLMService {
  private config: LLMProviderConfig;
  private apiKey: string;
  private available: boolean;
  /**
   * When true AND the configured endpoint looks like an OpenAI host, the
   * chat session is routed through the OpenAI Responses API (`/v1/responses`)
   * instead of Chat Completions. Enables `.pptx` / `.xlsx` / `.docx` to ride
   * native `input_file` content blocks (Chat Completions only accepts
   * `file_id` for PDFs). Mirrored from the `fileIngest` user setting.
   */
  private fileIngest = false;

  constructor(config: LLMProviderConfig, apiKey: string) {
    this.config = config;
    this.apiKey = apiKey;
    this.available = !!config.endpointUrl && !!config.model && !!apiKey;
  }

  /** Check whether the service has valid config and is reachable. */
  isAvailable(): boolean {
    return this.available;
  }

  /** Update availability flag (e.g. after a successful or failed call). */
  private setAvailable(value: boolean): void {
    this.available = value;
  }

  /** Mirrors Settings → OpenAI File Upload. Flips chat transport to Responses API. */
  setFileIngest(enabled: boolean): void {
    this.fileIngest = enabled;
  }

  /**
   * True iff the configured endpoint looks like an OpenAI host. Uses the
   * same `includes("openai")` heuristic as the renderer toggle in
   * SettingsPanel.tsx so the two stay in lockstep — if a user can toggle
   * the setting on, the wire-format switch will also engage.
   */
  isOpenAiEndpoint(): boolean {
    return this.config.endpointUrl.toLowerCase().includes("openai");
  }

  /**
   * True when chat requests should use the OpenAI Responses API. Toggled
   * on by the user (`fileIngest`) and gated to OpenAI endpoints — other
   * providers (Anthropic-proxy, local LiteLLM, etc.) don't speak this
   * wire format, so flipping the toggle there is a no-op.
   */
  private useResponsesApi(): boolean {
    return this.fileIngest && this.isOpenAiEndpoint();
  }

  /**
   * Stable per-process routing hint for OpenAI's automatic prompt cache.
   * Requests sharing this key (and our large, constant system-prompt prefix)
   * are steered to the same cache backend, lifting the hit rate across the
   * 15–25 tool-loop rounds of a single ingest. Free and side-effect-free.
   */
  private readonly promptCacheKey = "lumina-wiki";

  /**
   * Apply provider-appropriate prompt caching to an outgoing chat-completions
   * request. The system prompt (CLAUDE.md + INGEST.md) is re-sent verbatim on
   * every tool-loop round, so caching its KV state is the single biggest
   * latency/cost win for ingest. Two regimes, selected by endpoint:
   *
   *  - OpenAI hosts cache automatically for ≥1024-token prefixes — we only add
   *    `prompt_cache_key` for routing stickiness and must NOT inject
   *    `cache_control`, which the native API rejects as an unknown field.
   *  - Anthropic / LiteLLM / other gateways use Anthropic-style
   *    `cache_control: {type:"ephemeral"}` breakpoints. We mark the system
   *    prompt (the largest stable prefix). LiteLLM translates this to each
   *    backing provider's native caching and silently ignores it where
   *    unsupported, so it is always safe to send to non-OpenAI hosts.
   */

  /**
   * Generate a wiki article from a prompt via streaming.
   * Yields content chunks as they arrive from the LLM endpoint.
   */
  async *generateArticle(prompt: string): AsyncGenerator<string> {
    const body = JSON.stringify({
      model: this.config.model,
      messages: [
        {
          role: "system",
          content:
            "You are a knowledgeable wiki author. Generate a well-structured Markdown article with headings and paragraphs on the given topic.",
        },
        { role: "user", content: prompt },
      ],
      stream: true,
    });

    const response = await this.fetchWithTimeout(body, true);
    this.setAvailable(true);

    if (!response.body) {
      throw new LLMError("Response body is empty", "malformed_response");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) yield content;
          } catch {
            // Skip malformed SSE chunks — non-fatal for streaming
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Non-streaming chat call. Returns the assistant message content and any
   * tool calls requested by the model. Used for the tool-resolution loop
   * before streaming the final response.
   */
  async callNonStreaming(
    messages: Array<{ role: string; content: string | null | ChatContentBlock[]; tool_calls?: unknown[]; tool_call_id?: string }>,
    tools?: unknown[],
    parentCtx?: Context,
  ): Promise<{ content: string | null; toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> | null }> {
    const span = startSpan("llm.call", undefined, parentCtx);
    span?.setAttributes({
      "openinference.span.kind": "LLM",
      "llm.model_name": this.config.model,
      "input.value": JSON.stringify(messages),
    });

    const useResponses = this.useResponsesApi();
    const t0 = Date.now();
    const endpointTag = useResponses ? "/responses" : "/chat/completions";
    debugLog("info", "llm", `→ POST ${endpointTag} (non-stream)`, {
      model: this.config.model,
      messages: summariseMessages(messages),
      tools: tools?.length ?? 0,
    });

    try {
      const { messages: cachedMessages, bodyParams } = applyChatPromptCaching(
        messages as CanonicalMessage[],
        this.isOpenAiEndpoint(),
        this.promptCacheKey,
      );
      const body = useResponses
        ? JSON.stringify({
            model: this.config.model,
            input: messagesToResponsesInput(
              messages as CanonicalMessage[],
            ),
            ...(tools && tools.length > 0
              ? { tools: toolsToResponsesTools(tools), tool_choice: "auto" }
              : {}),
            store: false,
            prompt_cache_key: this.promptCacheKey,
          })
        : JSON.stringify({
            model: this.config.model,
            messages: cachedMessages,
            ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
            ...bodyParams,
          });

      const response = await this.fetchWithTimeout(body, false, useResponses);
      this.setAvailable(true);

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        debugLog("error", "llm", "non-stream: response was not JSON");
        throw new LLMError("Failed to parse LLM response as JSON", "malformed_response");
      }

      let assistantContent: string | null;
      let toolCalls: Array<{
        id: string;
        function: { name: string; arguments: string };
      }> | null;
      let usage: unknown;
      if (useResponses) {
        const parsed = parseResponsesOutput(json);
        assistantContent = parsed.content;
        toolCalls = parsed.toolCalls;
        usage = (json as any)?.usage;
        debugLog("info", "llm", `← non-stream ${response.status} (${Date.now() - t0}ms)`, {
          contentPreview: assistantContent ? assistantContent.slice(0, 200) : null,
          toolCalls: toolCalls
            ? toolCalls.map((tc) => ({
                id: tc.id,
                name: tc.function.name,
                args: tc.function.arguments.slice(0, 300),
              }))
            : null,
          usage,
        });
        if (span && usage) {
          const u = usage as any;
          span.setAttributes({
            "llm.token_count.prompt": u.input_tokens ?? u.prompt_tokens ?? 0,
            "llm.token_count.completion": u.output_tokens ?? u.completion_tokens ?? 0,
            "llm.token_count.total": u.total_tokens ?? 0,
          });
        }
      } else {
        const message = (json as any)?.choices?.[0]?.message;
        assistantContent = normaliseAssistantContent(message?.content);
        toolCalls = message?.tool_calls ?? null;
        usage = (json as any)?.usage;
        debugLog("info", "llm", `← non-stream ${response.status} (${Date.now() - t0}ms)`, {
          contentPreview: assistantContent
            ? assistantContent.slice(0, 200)
            : message?.content,
          toolCalls: Array.isArray(message?.tool_calls)
            ? message.tool_calls.map((tc: any) => ({
                id: tc?.id,
                name: tc?.function?.name,
                args: typeof tc?.function?.arguments === "string"
                  ? tc.function.arguments.slice(0, 300)
                  : tc?.function?.arguments,
              }))
            : null,
          usage,
        });
        if (span && usage) {
          const u = usage as any;
          span.setAttributes({
            "llm.token_count.prompt": u.prompt_tokens ?? 0,
            "llm.token_count.completion": u.completion_tokens ?? 0,
            "llm.token_count.total": u.total_tokens ?? 0,
          });
        }
      }

      if (assistantContent) span?.setAttribute("output.value", assistantContent);
      span?.setStatus({ code: SpanStatusCode.OK });
      return { content: assistantContent, toolCalls };
    } catch (err) {
      span?.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span?.end();
    }
  }

  /**
   * Generate a chat response from a full messages array via streaming.
   * Yields content chunks as they arrive from the LLM endpoint.
   * Accepts an optional AbortSignal for external cancellation support.
   */
  async *generateChat(
    messages: Array<{ role: string; content: string | null | ChatContentBlock[]; tool_calls?: unknown[]; tool_call_id?: string }>,
    signal?: AbortSignal,
    tools?: unknown[],
    parentCtx?: Context,
  ): AsyncGenerator<ChatChunk> {
    const span = startSpan("llm.stream", undefined, parentCtx);
    span?.setAttributes({
      "openinference.span.kind": "LLM",
      "llm.model_name": this.config.model,
      "input.value": JSON.stringify(messages),
    });

    let accumulated = "";
    const t0 = Date.now();
    let firstByteAt = 0;
    let firstDeltaAt = 0;
    let textDeltas = 0;
    let thinkingDeltas = 0;
    const useResponses = this.useResponsesApi();
    const endpointTag = useResponses ? "/responses" : "/chat/completions";
    debugLog("info", "llm", `→ POST ${endpointTag} (stream)`, {
      model: this.config.model,
      messages: summariseMessages(messages),
      tools: tools?.length ?? 0,
    });

    try {
      const { messages: cachedMessages, bodyParams } = applyChatPromptCaching(
        messages as CanonicalMessage[],
        this.isOpenAiEndpoint(),
        this.promptCacheKey,
      );
      const body = useResponses
        ? JSON.stringify({
            model: this.config.model,
            input: messagesToResponsesInput(
              messages as CanonicalMessage[],
            ),
            stream: true,
            store: false,
            prompt_cache_key: this.promptCacheKey,
            ...(tools && tools.length > 0
              ? {
                  tools: toolsToResponsesTools(tools),
                  tool_choice: "none",
                }
              : {}),
          })
        : JSON.stringify({
            model: this.config.model,
            messages: cachedMessages,
            stream: true,
            ...(tools && tools.length > 0 ? { tools, tool_choice: "none" } : {}),
            ...bodyParams,
          });

      const response = await this.fetchWithSignal(body, signal, useResponses);
      this.setAvailable(true);
      firstByteAt = Date.now();
      debugLog("info", "llm", `← stream connected ${response.status} (${firstByteAt - t0}ms TTFB)`);

      if (!response.body) {
        throw new LLMError("Response body is empty", "malformed_response");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          // Keep the last potentially incomplete line in the buffer
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") {
              debugLog("info", "llm", `← stream [DONE] (${Date.now() - t0}ms)`, {
                textDeltas,
                thinkingDeltas,
                accumulatedChars: accumulated.length,
              });
              return;
            }

            try {
              const parsed = JSON.parse(data);
              if (useResponses) {
                // Responses API uses typed SSE events; the `response.completed`
                // event is the terminal marker (no equivalent of `[DONE]` —
                // the stream just ends).
                if (parsed?.type === "response.completed") {
                  debugLog("info", "llm", `← stream completed (${Date.now() - t0}ms)`, {
                    textDeltas,
                    thinkingDeltas,
                    accumulatedChars: accumulated.length,
                  });
                  return;
                }
                if (
                  parsed?.type === "response.failed" ||
                  parsed?.type === "response.error"
                ) {
                  const msg =
                    parsed?.response?.error?.message ??
                    parsed?.error?.message ??
                    "Responses API reported failure";
                  throw new LLMError(msg, "unknown");
                }
                const event = parseResponsesStreamEvent(parsed);
                if (!event) continue;
                if (event.type === "thinking") {
                  if (!firstDeltaAt) {
                    firstDeltaAt = Date.now();
                    debugLog("debug", "llm", `first thinking delta (+${firstDeltaAt - firstByteAt}ms)`);
                  }
                  thinkingDeltas++;
                  yield { type: "thinking" as const, content: event.content };
                } else {
                  if (!firstDeltaAt) {
                    firstDeltaAt = Date.now();
                    debugLog("debug", "llm", `first text delta (+${firstDeltaAt - firstByteAt}ms)`);
                  }
                  textDeltas++;
                  accumulated += event.content;
                  yield { type: "text" as const, content: event.content };
                }
                continue;
              }
              const delta = parsed.choices?.[0]?.delta;
              const reasoning =
                delta?.reasoning_content ??
                delta?.reasoning ??
                delta?.thinking ??
                (typeof delta?.reasoning === "object" ? delta.reasoning?.content : undefined);
              if (reasoning) {
                if (!firstDeltaAt) {
                  firstDeltaAt = Date.now();
                  debugLog("debug", "llm", `first thinking delta (+${firstDeltaAt - firstByteAt}ms)`);
                }
                thinkingDeltas++;
                yield { type: 'thinking' as const, content: reasoning };
              }
              const content = delta?.content;
              if (content) {
                if (!firstDeltaAt) {
                  firstDeltaAt = Date.now();
                  debugLog("debug", "llm", `first text delta (+${firstDeltaAt - firstByteAt}ms)`);
                }
                textDeltas++;
                accumulated += content;
                yield { type: 'text' as const, content };
              }
            } catch {
              // Skip malformed SSE chunks — non-fatal for streaming
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (accumulated) span?.setAttribute("output.value", accumulated);
      span?.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      debugLog("error", "llm", `stream error after ${Date.now() - t0}ms`, {
        textDeltas,
        thinkingDeltas,
        message: (err as Error)?.message,
      });
      span?.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span?.end();
    }
  }

  /** Return a concise summary of the provided text. */
  async summarize(text: string): Promise<string> {
    return this.singleResponse(
      "Summarize the following text concisely while preserving key information.",
      text,
    );
  }

  /** Return an expanded version of the provided text with additional detail. */
  async expand(text: string): Promise<string> {
    return this.singleResponse(
      "Expand the following text with additional detail, examples, and context.",
      text,
    );
  }

  /** Return a refined version of the provided text with improved clarity and grammar. */
  async refine(text: string): Promise<string> {
    return this.singleResponse(
      "Rewrite the following text with improved clarity, grammar, and readability. Keep the same meaning.",
      text,
    );
  }

  /** Lightweight API call to verify credentials and connectivity. */
  async testConnection(): Promise<boolean> {
    try {
      const body = JSON.stringify({
        model: this.config.model,
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      });

      await this.fetchWithTimeout(body, false);
      this.setAvailable(true);
      return true;
    } catch (err) {
      this.setAvailable(false);
      if (err instanceof LLMError) throw err;
      throw new LLMError(
        `Connection test failed: ${(err as Error).message}`,
        "unknown",
      );
    }
  }

  /**
   * Upload a file to a LiteLLM-compatible `/v1/files` endpoint and return
   * the provider-issued file id.
   */
  async uploadFile(
    filePath: string,
    purpose: string = "user_data",
  ): Promise<{ id: string }> {
    const data = await fs.readFile(filePath);
    const form = new FormData();
    form.set("purpose", purpose);
    form.set(
      "file",
      new Blob([data], { type: detectMimeType(filePath) }),
      path.basename(filePath),
    );

    const response = await fetch(this.buildFilesUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: form,
    });
    if (!response.ok) {
      await this.handleHttpError(response);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new LLMError("Failed to parse file upload response as JSON", "malformed_response");
    }
    const fileId = (json as any)?.id ?? (json as any)?.file?.id;
    if (typeof fileId !== "string" || fileId.length === 0) {
      throw new LLMError("File upload response missing file id", "malformed_response");
    }
    this.setAvailable(true);
    return { id: fileId };
  }

  // ── Private helpers ──────────────────────────────────────────────

  /** Make a single non-streaming LLM call and return the assistant message. */
  private async singleResponse(
    systemPrompt: string,
    userText: string,
  ): Promise<string> {
    const body = JSON.stringify({
      model: this.config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
    });

    const response = await this.fetchWithTimeout(body, false);
    this.setAvailable(true);

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new LLMError(
        "Failed to parse LLM response as JSON",
        "malformed_response",
      );
    }

    const content = (json as any)?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new LLMError(
        "LLM response missing expected content field",
        "malformed_response",
      );
    }

    return content;
  }

  /**
   * Core fetch wrapper with timeout, error classification, and retry-after
   * header extraction.
   *
   * `useResponses` selects `/v1/responses` instead of the default
   * `/v1/chat/completions`. Kept as a per-call argument rather than a
   * class field so the same instance can mix Chat-Completions (utility
   * helpers like `singleResponse`, `testConnection`) and Responses
   * (interactive chat) traffic on the same call site.
   */
  private async fetchWithTimeout(
    body: string,
    stream: boolean,
    useResponses: boolean = false,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(useResponses ? this.buildResponsesUrl() : this.buildUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      this.setAvailable(false);

      if (err instanceof DOMException && err.name === "AbortError") {
        throw new LLMError(
          `LLM request timed out after ${TIMEOUT_SECONDS} seconds`,
          "timeout",
        );
      }
      throw new LLMError(`Network error: ${(err as Error).message}`, "network");
    }

    // Only clear the timer for non-streaming responses;
    // streaming responses need the body to keep reading.
    if (!stream) clearTimeout(timer);
    else clearTimeout(timer); // timeout only covers the initial connection

    if (!response.ok) {
      await this.handleHttpError(response);
    }

    return response;
  }

  /**
   * Fetch wrapper that supports an external AbortSignal combined with a timeout.
   * Used by generateChat to allow external cancellation (e.g. user stop button).
   *
   * `useResponses` selects `/v1/responses` instead of `/v1/chat/completions`.
   */
  private async fetchWithSignal(
    body: string,
    externalSignal?: AbortSignal,
    useResponses: boolean = false,
  ): Promise<Response> {
    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController.abort(),
      DEFAULT_TIMEOUT_MS,
    );

    // Abort if either the timeout or the external signal fires
    const onExternalAbort = () => timeoutController.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer);
        throw new LLMError("Request was aborted", "network");
      }
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(useResponses ? this.buildResponsesUrl() : this.buildUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: timeoutController.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
      this.setAvailable(false);

      if (err instanceof DOMException && err.name === "AbortError") {
        // Distinguish between external abort and timeout
        if (externalSignal?.aborted) {
          throw new LLMError("Request was aborted", "network");
        }
        throw new LLMError(
          `LLM request timed out after ${TIMEOUT_SECONDS} seconds`,
          "timeout",
        );
      }
      throw new LLMError(`Network error: ${(err as Error).message}`, "network");
    }

    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }

    if (!response.ok) {
      await this.handleHttpError(response);
    }

    return response;
  }

  /** Classify HTTP error status codes into typed LLMErrors (reads body for detail). */
  private async handleHttpError(response: Response): Promise<never> {
    const status = response.status;
    let detail = "";
    try {
      const body = await response.text();
      // Extract the innermost "message" field if JSON, otherwise use raw text
      const parsed = JSON.parse(body);
      detail = parsed?.error?.message ?? parsed?.message ?? body;
    } catch {
      // non-JSON body — ignore
    }
    const suffix = detail ? `: ${detail}` : "";

    if (status === 401 || status === 403) {
      this.setAvailable(false);
      throw new LLMError(
        `Authentication failed (${status})${suffix}`,
        "auth",
        status,
      );
    }

    if (status === 429) {
      const retryAfter = parseInt(
        response.headers.get("retry-after") ?? "",
        10,
      );
      throw new LLMError(
        `Rate limit exceeded${suffix}`,
        "rate_limit",
        status,
        Number.isNaN(retryAfter) ? undefined : retryAfter,
      );
    }

    throw new LLMError(
      `LLM request failed with status ${status}${suffix}`,
      "unknown",
      status,
    );
  }

  /** Build the chat completions URL from the configured endpoint. */
  private buildUrl(): string {
    const base = this.config.endpointUrl.replace(/\/+$/, "");
    if (base.includes("/chat/completions")) return base;
    if (base.endsWith("/v1")) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  }

  /**
   * Build the OpenAI Responses API URL (`/v1/responses`) from the same
   * endpoint base used for chat completions. If the user pasted a full
   * `/chat/completions` URL into Settings, we swap the suffix; otherwise
   * we append `/v1/responses` like `buildUrl` does for chat.
   */
  private buildResponsesUrl(): string {
    const base = this.config.endpointUrl.replace(/\/+$/, "");
    if (base.includes("/responses")) return base;
    if (base.includes("/chat/completions")) {
      return base.replace(/\/chat\/completions(?:\/)?$/, "/responses");
    }
    if (base.endsWith("/v1")) return `${base}/responses`;
    return `${base}/v1/responses`;
  }

  /** Build the files URL from the configured endpoint. */
  private buildFilesUrl(): string {
    const base = this.config.endpointUrl.replace(/\/+$/, "");
    if (base.includes("/chat/completions")) {
      return base.replace(/\/chat\/completions(?:\/)?$/, "/files");
    }
    if (base.includes("/responses")) {
      return base.replace(/\/responses(?:\/)?$/, "/files");
    }
    if (base.endsWith("/v1")) return `${base}/files`;
    return `${base}/v1/files`;
  }
}

/**
 * Render a compact one-line-per-message summary suitable for the debug log.
 * Drops nothing structural but truncates long string content so the panel
 * stays readable.
 */
function summariseMessages(
  messages: Array<{
    role: string;
    content: string | null | ChatContentBlock[];
    tool_calls?: unknown[];
    tool_call_id?: string;
  }>,
): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role };
    if (typeof m.content === "string") {
      out.content =
        m.content.length > 240 ? `${m.content.slice(0, 240)}…(${m.content.length})` : m.content;
    } else if (Array.isArray(m.content)) {
      out.content = m.content.map((block) => {
        if (block.type === "text") {
          return {
            type: "text",
            text:
              block.text.length > 120
                ? `${block.text.slice(0, 120)}…(${block.text.length})`
                : block.text,
          };
        }
        if (block.type === "file") {
          return {
            type: "file",
            file_id: block.file.file_id,
            format: block.file.format,
            filename: block.file.filename,
          };
        }
        return {
          type: "image_url",
          ...(block.image_url.file_id
            ? { file_id: block.image_url.file_id }
            : {
                urlPreview:
                  (block.image_url.url ?? "").length > 80
                    ? `${(block.image_url.url ?? "").slice(0, 80)}…`
                    : block.image_url.url,
              }),
          detail: block.image_url.detail,
        };
      });
    } else if (m.content === null) {
      out.content = null;
    }
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.tool_calls) {
      out.tool_calls = (m.tool_calls as Array<{ id?: string; function?: { name?: string; arguments?: string } }>).map(
        (tc) => ({
          id: tc?.id,
          name: tc?.function?.name,
          args:
            typeof tc?.function?.arguments === "string" && tc.function.arguments.length > 200
              ? `${tc.function.arguments.slice(0, 200)}…`
              : tc?.function?.arguments,
        }),
      );
    }
    return out;
  });
}

function normaliseAssistantContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (part && typeof part === "object") {
      const text = (part as any).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  if (parts.length === 0) return null;
  return parts.join("\n");
}

function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".txt":
      return "text/plain";
    // Office formats — needed when uploading via /v1/files with
    // `purpose: "user_data"` for the Responses API path. The Files API
    // honours the Content-Type we set on the multipart blob.
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".doc":
      return "application/msword";
    case ".epub":
      return "application/epub+zip";
    case ".rtf":
      return "application/rtf";
    case ".csv":
      return "text/csv";
    case ".tsv":
      return "text/tab-separated-values";
    default:
      return "application/octet-stream";
  }
}

// ── Responses API translators ────────────────────────────────────
//
// These pure functions translate between our canonical Chat-Completions-
// shaped message format (used by ChatService and the rest of the
// codebase) and the OpenAI Responses API wire format. Kept at module
// scope (not class methods) so unit tests can import them directly.

/** Canonical (Chat-Completions-shaped) message used internally. */
export type CanonicalMessage = {
  role: string;
  content: string | null | ChatContentBlock[];
  tool_calls?: Array<{
    id: string;
    type?: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

/**
 * Provider-appropriate prompt caching for an outgoing chat-completions
 * request. See the calling method `LLMService.applyChatPromptCaching` for the
 * rationale; this is the pure, testable core.
 *
 *  - `isOpenAi`: rely on OpenAI's automatic prefix cache; attach
 *    `prompt_cache_key` for routing stickiness and leave messages untouched
 *    (the native API rejects `cache_control` as an unknown content field).
 *  - otherwise: mark the first system message with an Anthropic-style
 *    `cache_control: {type:"ephemeral"}` breakpoint. LiteLLM translates this
 *    per backing provider and ignores it where unsupported.
 */
export function applyChatPromptCaching(
  messages: CanonicalMessage[],
  isOpenAi: boolean,
  promptCacheKey: string,
): { messages: CanonicalMessage[]; bodyParams: Record<string, unknown> } {
  if (isOpenAi) {
    return { messages, bodyParams: { prompt_cache_key: promptCacheKey } };
  }
  let marked = false;
  const out = messages.map((m) => {
    if (marked || m.role !== "system" || typeof m.content !== "string") {
      return m;
    }
    marked = true;
    return {
      ...m,
      content: [
        { type: "text", text: m.content, cache_control: { type: "ephemeral" } },
      ] as ChatContentBlock[],
    };
  });
  return { messages: out, bodyParams: {} };
}

/**
 * Translate canonical messages into a Responses API `input[]` array.
 *
 * Mapping highlights:
 *   - `role: "tool"` messages become top-level `function_call_output`
 *     items (NOT a message with a tool role — the Responses API does not
 *     have a `tool` role).
 *   - Assistant messages that carry `tool_calls[]` emit any text content
 *     first (as an `assistant` message with `output_text`), then one
 *     `function_call` item per call, preserving chronological order.
 *   - Content blocks: `text` → `input_text` / `output_text` (role-dependent),
 *     `image_url` → `input_image`, `file` → `input_file`.
 */
export function messagesToResponsesInput(
  messages: CanonicalMessage[],
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: m.tool_call_id ?? "",
        output:
          typeof m.content === "string"
            ? m.content
            : m.content === null
              ? ""
              : JSON.stringify(m.content),
      });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      if (typeof m.content === "string" && m.content.length > 0) {
        items.push({
          role: "assistant",
          content: [{ type: "output_text", text: m.content }],
        });
      } else if (Array.isArray(m.content) && m.content.length > 0) {
        items.push({
          role: "assistant",
          content: canonicalContentToResponses(m.content, "assistant"),
        });
      }
      for (const tc of m.tool_calls) {
        items.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
      continue;
    }
    const role = m.role;
    items.push({
      role,
      content: canonicalContentToResponses(m.content, role),
    });
  }
  return items;
}

/**
 * Convert a canonical content payload into Responses-API content parts.
 * Assistant text becomes `output_text`; everything else uses the `input_*`
 * family. Image and file blocks are renamed structurally to match the
 * Responses schema (`image_url` flattened to a string, `file_id`
 * promoted to a top-level field).
 */
function canonicalContentToResponses(
  content: string | null | ChatContentBlock[],
  role: string,
): Array<Record<string, unknown>> {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (content === null) return [];
  if (typeof content === "string") {
    if (content.length === 0) return [];
    return [{ type: textType, text: content }];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type === "text") {
      out.push({ type: textType, text: block.text });
    } else if (block.type === "image_url") {
      const part: Record<string, unknown> = { type: "input_image" };
      // An uploaded image is referenced by file_id; an inline image by URL.
      if (block.image_url.file_id) {
        part.file_id = block.image_url.file_id;
      } else if (block.image_url.url) {
        part.image_url = block.image_url.url;
      }
      if (block.image_url.detail) part.detail = block.image_url.detail;
      out.push(part);
    } else if (block.type === "file") {
      const part: Record<string, unknown> = { type: "input_file" };
      if (block.file.file_id) part.file_id = block.file.file_id;
      if (block.file.filename) part.filename = block.file.filename;
      out.push(part);
    }
  }
  return out;
}

/**
 * Flatten Chat-Completions tool definitions
 * (`{ type: "function", function: { name, description, parameters } }`)
 * into the Responses API shape (`{ type: "function", name, description,
 * parameters }`). Anything we don't recognise is passed through verbatim
 * so future tool types (e.g. `file_search`) keep working without code
 * changes here.
 */
export function toolsToResponsesTools(tools: unknown[]): unknown[] {
  return tools.map((t) => {
    if (!t || typeof t !== "object") return t;
    const tool = t as {
      type?: string;
      function?: {
        name: string;
        description?: string;
        parameters?: unknown;
        strict?: boolean;
      };
    };
    if (tool.type === "function" && tool.function) {
      const out: Record<string, unknown> = {
        type: "function",
        name: tool.function.name,
      };
      if (tool.function.description !== undefined) {
        out.description = tool.function.description;
      }
      if (tool.function.parameters !== undefined) {
        out.parameters = tool.function.parameters;
      }
      if (tool.function.strict !== undefined) {
        out.strict = tool.function.strict;
      }
      return out;
    }
    return t;
  });
}

/**
 * Parse a non-streaming Responses API JSON body into the same
 * `{ content, toolCalls }` shape `callNonStreaming` returns for Chat
 * Completions. Concatenates every `output_text` chunk into a single
 * string (matching the Chat-Completions assistant message) and lifts
 * every `function_call` output item into a `tool_calls` entry keyed by
 * `call_id`.
 */
export function parseResponsesOutput(json: unknown): {
  content: string | null;
  toolCalls: Array<{
    id: string;
    function: { name: string; arguments: string };
  }> | null;
} {
  const obj = json as { output?: unknown } | null;
  const output = Array.isArray(obj?.output) ? obj!.output : [];
  const textParts: string[] = [];
  const toolCalls: Array<{
    id: string;
    function: { name: string; arguments: string };
  }> = [];
  for (const itemRaw of output) {
    const item = itemRaw as Record<string, unknown> | null;
    if (!item) continue;
    if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const cRaw of content) {
        const c = cRaw as Record<string, unknown> | null;
        if (!c) continue;
        if (c.type === "output_text" && typeof c.text === "string") {
          textParts.push(c.text);
        }
      }
    } else if (item.type === "function_call") {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      const name = typeof item.name === "string" ? item.name : "";
      const args =
        typeof item.arguments === "string" ? item.arguments : "";
      toolCalls.push({ id: callId, function: { name, arguments: args } });
    }
  }
  return {
    content: textParts.length > 0 ? textParts.join("") : null,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
  };
}

/**
 * Decode a single SSE event JSON payload from the Responses API stream.
 * Returns the canonical `ChatChunk`-like value (or `null` to skip).
 *
 * Event types of interest:
 *   - `response.output_text.delta`     → text delta
 *   - `response.reasoning_summary_text.delta` → thinking delta (o1/o3)
 *   - `response.reasoning.delta`       → thinking delta (alt naming)
 *   - `response.completed` / `response.failed` → terminal (handled by caller)
 *
 * Function-call argument deltas are intentionally ignored here — our
 * streaming-final path is invoked with `tool_choice: 'none'` and does not
 * expect new tool calls.
 */
export function parseResponsesStreamEvent(
  parsed: unknown,
): { type: "text" | "thinking"; content: string } | null {
  const obj = parsed as { type?: unknown; delta?: unknown } | null;
  if (!obj || typeof obj.type !== "string") return null;
  const evt = obj.type;
  if (evt === "response.output_text.delta") {
    const delta = typeof obj.delta === "string" ? obj.delta : "";
    if (!delta) return null;
    return { type: "text", content: delta };
  }
  if (
    evt === "response.reasoning_summary_text.delta" ||
    evt === "response.reasoning.delta" ||
    evt === "response.reasoning_text.delta"
  ) {
    const delta = typeof obj.delta === "string" ? obj.delta : "";
    if (!delta) return null;
    return { type: "thinking", content: delta };
  }
  return null;
}

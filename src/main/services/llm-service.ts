import { LLMProviderConfig } from "../../shared/types";

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

const DEFAULT_TIMEOUT_MS = 30_000;

export class LLMService {
  private config: LLMProviderConfig;
  private apiKey: string;
  private available: boolean;

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
   * Generate a chat response from a full messages array via streaming.
   * Yields content chunks as they arrive from the LLM endpoint.
   * Accepts an optional AbortSignal for external cancellation support.
   */
  async *generateChat(
    messages: Array<{ role: string; content: string }>,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const body = JSON.stringify({
      model: this.config.model,
      messages,
      stream: true,
    });

    const response = await this.fetchWithSignal(body, signal);
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
        max_tokens: 1,
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
   */
  private async fetchWithTimeout(
    body: string,
    stream: boolean,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(this.buildUrl(), {
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
        throw new LLMError("LLM request timed out after 30 seconds", "timeout");
      }
      throw new LLMError(`Network error: ${(err as Error).message}`, "network");
    }

    // Only clear the timer for non-streaming responses;
    // streaming responses need the body to keep reading.
    if (!stream) clearTimeout(timer);
    else clearTimeout(timer); // timeout only covers the initial connection

    if (!response.ok) {
      this.handleHttpError(response);
    }

    return response;
  }

  /**
   * Fetch wrapper that supports an external AbortSignal combined with a timeout.
   * Used by generateChat to allow external cancellation (e.g. user stop button).
   */
  private async fetchWithSignal(
    body: string,
    externalSignal?: AbortSignal,
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
      response = await fetch(this.buildUrl(), {
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
        throw new LLMError("LLM request timed out after 30 seconds", "timeout");
      }
      throw new LLMError(`Network error: ${(err as Error).message}`, "network");
    }

    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }

    if (!response.ok) {
      this.handleHttpError(response);
    }

    return response;
  }

  /** Classify HTTP error status codes into typed LLMErrors. */
  private handleHttpError(response: Response): never {
    const status = response.status;

    if (status === 401 || status === 403) {
      this.setAvailable(false);
      throw new LLMError(
        `Authentication failed (${status}). Check your API key.`,
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
        "Rate limit exceeded. Please try again later.",
        "rate_limit",
        status,
        Number.isNaN(retryAfter) ? undefined : retryAfter,
      );
    }

    throw new LLMError(
      `LLM request failed with status ${status}`,
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
}

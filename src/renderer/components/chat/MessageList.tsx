import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Sparkles, Copy, RefreshCw, ThumbsUp, ThumbsDown, ChevronDown } from 'lucide-react';
import type { ChatMessage } from '../../../shared/types';
import { FoxThinkingIndicator } from './FoxThinkingIndicator';

export interface MessageListProps {
  messages: ChatMessage[];
  streamingContent?: string;
  isGenerating?: boolean;
  /** Optional custom renderer for assistant message content (e.g. Markdown). Falls back to plain text. */
  renderAssistantContent?: (content: string) => React.ReactNode;
  /** Called when the user clicks the Regenerate button on an assistant message action bar. */
  onRegenerate?: () => void;
}

/**
 * Format an ISO 8601 timestamp string to HH:mm (local time).
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Determine whether the scroll position is past the threshold (200px from bottom).
 * Exported for property-based testing.
 */
export function isScrolledPastThreshold(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight > 200;
}

export interface ScrollToBottomButtonProps {
  visible: boolean;
  onClick: () => void;
}

const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = ({ visible, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-10 w-8 h-8 rounded-full bg-[rgba(124,58,237,0.25)] hover:bg-[rgba(124,58,237,0.4)] flex items-center justify-center transition-opacity duration-200 cursor-pointer ${visible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
    aria-label="Scroll to bottom"
    data-testid="scroll-to-bottom"
  >
    <ChevronDown className="w-4 h-4 text-purple-300" />
  </button>
);

export const MessageList: React.FC<MessageListProps> = ({ messages, streamingContent, isGenerating, renderAssistantContent, onRegenerate }) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Auto-scroll to bottom when messages change or streaming content updates
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setShowScrollButton(isScrolledPastThreshold(el.scrollHeight, el.scrollTop, el.clientHeight));
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Filter out system messages — they aren't displayed in the chat
  const visibleMessages = messages.filter((m) => m.role !== 'system');

  return (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      className="relative flex-1 min-h-0 overflow-y-auto px-4 py-6"
      role="log"
      aria-label="Chat messages"
    >
      <style>{`
        @keyframes pulse-cursor {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        .streaming-cursor {
          animation: pulse-cursor 1s ease-in-out infinite;
        }
      `}</style>
      <div className="mx-auto max-w-[720px] px-5 flex flex-col gap-4">
        {visibleMessages.map((message) => (
          <MessageBubble key={message.id} message={message} renderAssistantContent={renderAssistantContent} onRegenerate={onRegenerate} />
        ))}

        {/* Fox thinking indicator — shown when generating but no streaming content yet */}
        {isGenerating && (!streamingContent || streamingContent.length === 0) && (
          <div className="flex justify-start" data-testid="fox-thinking-container">
            <FoxThinkingIndicator size="large" />
          </div>
        )}

        {/* Streaming partial assistant response */}
        {streamingContent != null && streamingContent.length > 0 && (
          <div className="group flex items-start gap-3 w-full" data-testid="streaming-message">
            <div className="flex-shrink-0 w-6 h-6 rounded-full bg-[rgba(124,58,237,0.15)] flex items-center justify-center mt-0.5">
              <Sparkles className="w-3.5 h-3.5 text-purple-400" />
            </div>
            <div className="flex-1 min-w-0">
              <span className="block text-[11px] text-text-secondary mb-1 select-none">Lumina</span>
              <div className="text-text-primary">
                <p className="text-sm whitespace-pre-wrap break-words">{streamingContent}<span className="streaming-cursor" data-testid="streaming-cursor">▍</span></p>
              </div>
            </div>
          </div>
        )}

        {/* Scroll anchor */}
        <div ref={bottomRef} />
      </div>

      <ScrollToBottomButton visible={showScrollButton} onClick={scrollToBottom} />
    </div>
  );
};

const MessageBubble: React.FC<{ message: ChatMessage; renderAssistantContent?: (content: string) => React.ReactNode; onRegenerate?: () => void }> = ({ message, renderAssistantContent, onRegenerate }) => {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  if (isAssistant) {
    return (
      <div className="group flex items-start gap-3 w-full" data-testid="assistant-message">
        {/* Avatar */}
        <div className="flex-shrink-0 w-6 h-6 rounded-full bg-[rgba(124,58,237,0.15)] flex items-center justify-center mt-0.5">
          <Sparkles className="w-3.5 h-3.5 text-purple-400" />
        </div>
        {/* Content */}
        <div className="flex-1 min-w-0">
          <span className="block text-[11px] text-text-secondary mb-1 select-none">Lumina</span>
          <div className="text-text-primary">
            {renderAssistantContent ? (
              renderAssistantContent(message.content)
            ) : (
              <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
            )}
          </div>
          <time
            className="block mt-1 text-[10px] text-text-secondary select-none"
            dateTime={message.timestamp}
          >
            {formatTimestamp(message.timestamp)}
          </time>
          <ActionBar content={message.content} onRegenerate={onRegenerate} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-end">
      <div className="max-w-[75%] rounded-[12px_12px_2px_12px] bg-[rgba(124,58,237,0.15)] text-text-primary px-4 py-2.5">
        <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
        <time
          className="block mt-1 text-[10px] text-text-secondary text-right select-none"
          dateTime={message.timestamp}
        >
          {formatTimestamp(message.timestamp)}
        </time>
      </div>
    </div>
  );
};

export interface ActionBarProps {
  content: string;
  onRegenerate?: () => void;
}

const ActionBar: React.FC<ActionBarProps> = ({ content, onRegenerate }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silently fail — matches existing clipboard error handling
    }
  };

  return (
    <div
      className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
      data-testid="action-bar"
    >
      <button
        type="button"
        onClick={handleCopy}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-text-secondary bg-transparent hover:text-text-primary transition-colors cursor-pointer"
        aria-label={copied ? 'Copied' : 'Copy All'}
      >
        <Copy className="w-3.5 h-3.5" />
        {copied ? 'Copied' : 'Copy All'}
      </button>
      {onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-text-secondary bg-transparent hover:text-text-primary transition-colors cursor-pointer"
          aria-label="Regenerate"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Regenerate
        </button>
      )}
      <button
        type="button"
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-text-secondary bg-transparent hover:text-text-primary transition-colors cursor-pointer"
        aria-label="Thumbs up"
      >
        <ThumbsUp className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-text-secondary bg-transparent hover:text-text-primary transition-colors cursor-pointer"
        aria-label="Thumbs down"
      >
        <ThumbsDown className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

export default MessageList;

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Sparkles, Copy, RefreshCw, ThumbsUp, ThumbsDown, ChevronDown } from 'lucide-react';
import type { ChatMessage } from '../../../shared/types';
import { FoxThinkingIndicator } from './FoxThinkingIndicator';
import { ThinkingChip } from './ThinkingChip';
import type { ThinkingEntry } from '../ChatView';

export interface MessageListProps {
  messages: ChatMessage[];
  streamingContent?: string;
  isGenerating?: boolean;
  renderAssistantContent?: (content: string) => React.ReactNode;
  renderUserContent?: (content: string) => React.ReactNode;
  onRegenerate?: () => void;
  thinkingMap?: Record<string, ThinkingEntry>;
  activeThinkingMsgId?: string | null;
  onThinkingChipClick?: (msgId: string) => void;
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
    className={`absolute bottom-5 left-1/2 -translate-x-1/2 z-10 w-8 h-8 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer shadow-lg ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'}`}
    style={{ background: 'var(--color-primary, #7c3aed)', boxShadow: '0 2px 12px rgba(124,58,237,0.4)' }}
    aria-label="Scroll to bottom"
    data-testid="scroll-to-bottom"
  >
    <ChevronDown className="w-4 h-4 text-white" />
  </button>
);

export const MessageList: React.FC<MessageListProps> = ({ messages, streamingContent, isGenerating, renderAssistantContent, renderUserContent, onRegenerate, thinkingMap, activeThinkingMsgId, onThinkingChipClick }) => {
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

  const colStyle: React.CSSProperties = {
    paddingLeft: 'max(1rem, calc(50% - 360px))',
    paddingRight: 'max(1rem, calc(50% - 360px))',
  };

  return (
    <div className="relative flex-1 min-h-0">
      <style>{`
        @keyframes pulse-cursor {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        .streaming-cursor {
          animation: pulse-cursor 1s ease-in-out infinite;
        }
      `}</style>

      {/* Scrollable message area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto pb-6"
        style={{
          ...colStyle,
          paddingTop: '3.5rem',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0px, black 56px)',
          maskImage: 'linear-gradient(to bottom, transparent 0px, black 56px)',
        }}
        role="log"
        aria-label="Chat messages"
      >
        <div className="flex flex-col gap-6">
          {visibleMessages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              renderAssistantContent={renderAssistantContent}
              renderUserContent={renderUserContent}
              onRegenerate={onRegenerate}
              thinking={thinkingMap?.[message.id]}
              isThinkingActive={activeThinkingMsgId === message.id}
              onThinkingChipClick={onThinkingChipClick ? () => onThinkingChipClick(message.id) : undefined}
            />
          ))}

          {/* Fox thinking indicator — shown when generating but no streaming content yet and no thinking */}
          {isGenerating && (!streamingContent || streamingContent.length === 0) && !thinkingMap?.__streaming__ && (
            <div className="flex justify-start" data-testid="fox-thinking-container">
              <FoxThinkingIndicator size="large" />
            </div>
          )}

          {/* Streaming partial assistant response (with optional thinking chip) */}
          {(streamingContent != null && streamingContent.length > 0 || thinkingMap?.__streaming__) && (
            <div className="w-full text-text-primary" data-testid="streaming-message">
              {thinkingMap?.__streaming__ && onThinkingChipClick && (
                <ThinkingChip
                  isStreaming={thinkingMap.__streaming__.isStreaming}
                  durationMs={thinkingMap.__streaming__.durationMs}
                  isActive={activeThinkingMsgId === '__streaming__'}
                  onClick={() => onThinkingChipClick('__streaming__')}
                />
              )}
              {streamingContent != null && streamingContent.length > 0 && (
                renderAssistantContent ? (
                  <div className="text-sm">{renderAssistantContent(streamingContent)}<span className="streaming-cursor inline" data-testid="streaming-cursor">▍</span></div>
                ) : (
                  <p className="text-sm whitespace-pre-wrap break-words">{streamingContent}<span className="streaming-cursor" data-testid="streaming-cursor">▍</span></p>
                )
              )}
            </div>
          )}

          {/* Scroll anchor */}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Scroll-to-bottom button — overlaid on wrapper so it stays at visual bottom */}
      <ScrollToBottomButton visible={showScrollButton} onClick={scrollToBottom} />
    </div>
  );
};

const MessageBubble: React.FC<{
  message: ChatMessage;
  renderAssistantContent?: (content: string) => React.ReactNode;
  renderUserContent?: (content: string) => React.ReactNode;
  onRegenerate?: () => void;
  thinking?: ThinkingEntry;
  isThinkingActive?: boolean;
  onThinkingChipClick?: () => void;
}> = ({ message, renderAssistantContent, renderUserContent, onRegenerate, thinking, isThinkingActive, onThinkingChipClick }) => {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  if (isAssistant) {
    return (
      <div className="group w-full" data-testid="assistant-message">
        <div className="flex-1 min-w-0">
          {thinking && (thinking.content || (thinking.trace && thinking.trace.length > 0)) && onThinkingChipClick && (
            <ThinkingChip
              isStreaming={thinking.isStreaming}
              durationMs={thinking.durationMs}
              isActive={!!isThinkingActive}
              onClick={onThinkingChipClick}
            />
          )}
          <div className="text-text-primary">
            {renderAssistantContent ? (
              renderAssistantContent(message.content)
            ) : (
              <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
            )}
          </div>
          <ActionBar content={message.content} onRegenerate={onRegenerate} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-end">
      <div className="max-w-[75%] rounded-[12px_12px_2px_12px] bg-[rgba(124,58,237,0.15)] text-text-primary" style={{ padding: '10px 16px' }}>
        {renderUserContent ? (
          <div className="text-sm whitespace-pre-wrap break-words">{renderUserContent(message.content)}</div>
        ) : (
          <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
        )}
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
        className="flex items-center justify-center w-7 h-7 rounded text-text-secondary bg-transparent hover:text-text-primary transition-colors cursor-pointer"
        aria-label={copied ? 'Copied' : 'Copy'}
      >
        <Copy className="w-3.5 h-3.5" />
      </button>
      {onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          className="flex items-center justify-center w-7 h-7 rounded text-text-secondary bg-transparent hover:text-text-primary transition-colors cursor-pointer"
          aria-label="Regenerate"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      )}
      <button
        type="button"
        className="flex items-center justify-center w-7 h-7 rounded text-text-secondary bg-transparent hover:text-text-primary transition-colors cursor-pointer"
        aria-label="Thumbs up"
      >
        <ThumbsUp className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        className="flex items-center justify-center w-7 h-7 rounded text-text-secondary bg-transparent hover:text-text-primary transition-colors cursor-pointer"
        aria-label="Thumbs down"
      >
        <ThumbsDown className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

export default MessageList;

import React, { useRef, useEffect } from 'react';
import type { ChatMessage } from '../../../shared/types';

export interface MessageListProps {
  messages: ChatMessage[];
  streamingContent?: string;
  /** Optional custom renderer for assistant message content (e.g. Markdown). Falls back to plain text. */
  renderAssistantContent?: (content: string) => React.ReactNode;
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

export const MessageList: React.FC<MessageListProps> = ({ messages, streamingContent, renderAssistantContent }) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change or streaming content updates
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // Filter out system messages — they aren't displayed in the chat
  const visibleMessages = messages.filter((m) => m.role !== 'system');

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-6" role="log" aria-label="Chat messages">
      <div className="mx-auto max-w-3xl flex flex-col gap-4">
        {visibleMessages.map((message) => (
          <MessageBubble key={message.id} message={message} renderAssistantContent={renderAssistantContent} />
        ))}

        {/* Streaming partial assistant response */}
        {streamingContent != null && streamingContent.length > 0 && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl rounded-bl-sm px-4 py-2.5 bg-surface-hover text-text-primary">
              <p className="text-sm whitespace-pre-wrap break-words">{streamingContent}</p>
              <span className="block mt-1 text-[10px] text-text-secondary select-none">…</span>
            </div>
          </div>
        )}

        {/* Scroll anchor */}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};

const MessageBubble: React.FC<{ message: ChatMessage; renderAssistantContent?: (content: string) => React.ReactNode }> = ({ message, renderAssistantContent }) => {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${isUser
          ? 'rounded-br-sm bg-accent text-white'
          : 'rounded-bl-sm bg-surface-hover text-text-primary'
          }`}
      >
        {isAssistant && renderAssistantContent ? (
          renderAssistantContent(message.content)
        ) : (
          <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
        )}
        <time
          className={`block mt-1 text-[10px] select-none ${isUser ? 'text-white/70 text-right' : 'text-text-secondary'
            }`}
          dateTime={message.timestamp}
        >
          {formatTimestamp(message.timestamp)}
        </time>
      </div>
    </div>
  );
};

export default MessageList;

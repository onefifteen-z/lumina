import React, { useRef, useCallback, useState } from 'react';
import { Send, Square } from 'lucide-react';

export interface ChatInputProps {
  onSend: (content: string) => void;
  onStop: () => void;
  isGenerating: boolean;
  isOffline: boolean;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  onSend,
  onStop,
  isGenerating,
  isOffline,
}) => {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resetHeight = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setValue(e.target.value);
      resetHeight();
    },
    [resetHeight],
  );

  const send = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isGenerating || isOffline) return;
    onSend(trimmed);
    setValue('');
    // Reset textarea height after clearing
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.style.height = 'auto';
      }
    });
  }, [value, isGenerating, isOffline, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send],
  );

  const disabled = isOffline || isGenerating;

  return (
    <div className="border-t border-border px-4 py-2 shrink-0">
      <div className="mx-auto max-w-[720px] px-5 flex items-center gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={
            isOffline
              ? 'Chat unavailable while offline'
              : isGenerating
                ? 'Waiting for response…'
                : 'Type a message…'
          }
          rows={1}
          aria-label="Chat message input"
          className="flex-1 resize-none rounded-lg border border-border bg-sidebar-bg px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-border disabled:cursor-not-allowed disabled:opacity-50"
          style={{ maxHeight: '120px', minHeight: '22px', overflowY: 'auto' }}
        />

        {isGenerating ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generation"
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors cursor-pointer shrink-0 focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none"
          >
            <Square size={16} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={!value.trim() || isOffline}
            aria-label="Send message"
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none"
          >
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  );
};

export default ChatInput;

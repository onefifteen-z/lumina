import React, { useRef, useCallback, useState } from 'react';
import { Send, Square, SquarePen } from 'lucide-react';

export interface ChatInputProps {
  onSend: (content: string) => void;
  onStop: () => void;
  onNewSession: () => void;
  isGenerating: boolean;
  isOffline: boolean;
  colStyle?: React.CSSProperties;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  onSend,
  onStop,
  onNewSession,
  isGenerating,
  isOffline,
  colStyle,
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
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) ta.style.height = 'auto';
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

  return (
    <div className="shrink-0 pb-4 pt-2" style={colStyle}>
      {/* Input box */}
      <div className="rounded-xl border border-border bg-sidebar-bg focus-within:border-primary-border transition-colors" style={{ padding: '20px 20px 16px 20px' }}>
        {/* Text area */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={isOffline || isGenerating}
          placeholder={
            isOffline
              ? 'Chat unavailable while offline'
              : isGenerating
                ? 'Generating…'
                : 'Message Lumina…'
          }
          rows={1}
          aria-label="Chat message input"
          className="w-full resize-none bg-transparent text-sm text-text-primary placeholder:text-text-secondary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 leading-relaxed pb-3"
          style={{ maxHeight: '200px', minHeight: '52px', overflowY: 'auto', display: 'block' }}
        />

        {/* Bottom action row */}
        <div className="flex items-center justify-end gap-1.5">
          {/* New Chat */}
          <button
            type="button"
            onClick={onNewSession}
            aria-label="New session"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none"
          >
            <SquarePen size={16} />
          </button>

          {/* Send / Stop */}
          {isGenerating ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generation"
              className="flex items-center justify-center w-8 h-8 rounded-lg bg-text-primary text-main-bg hover:opacity-80 transition-colors cursor-pointer shrink-0 focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none"
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!value.trim() || isOffline}
              aria-label="Send message"
              className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors cursor-pointer shrink-0 disabled:opacity-30 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none"
            >
              <Send size={15} />
            </button>
          )}
        </div>
      </div>

      <p className="mt-1.5 text-center text-[11px] text-text-secondary opacity-60">
        Enter to send · Shift+Enter for newline
      </p>
    </div>
  );
};

export default ChatInput;

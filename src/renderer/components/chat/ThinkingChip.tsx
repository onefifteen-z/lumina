import React, { useState, useEffect } from 'react';
import { FoxChipIcon } from './FoxThinkingIndicator';

export interface ThinkingChipProps {
  isStreaming: boolean;
  durationMs: number;
  isActive: boolean;
  onClick: () => void;
}

export const ThinkingChip: React.FC<ThinkingChipProps> = ({ isStreaming, durationMs, isActive, onClick }) => {
  const [elapsed, setElapsed] = useState(0);

  // Live timer while streaming
  useEffect(() => {
    if (!isStreaming) return;
    const start = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - start), 200);
    return () => clearInterval(id);
  }, [isStreaming]);

  const seconds = Math.round((isStreaming ? elapsed : durationMs) / 1000);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition-colors cursor-pointer mb-1.5 ${
        isActive
          ? 'bg-primary-bg border border-primary-border text-primary-text'
          : 'text-text-secondary hover:bg-surface-hover border border-transparent'
      } ${isStreaming ? 'thinking-chip-pulse' : ''}`}
    >
      <FoxChipIcon size={10} className="shrink-0" />
      {isStreaming ? (
        <span>Thinking… {seconds}s</span>
      ) : (
        <span>Thought for {seconds}s →</span>
      )}
    </button>
  );
};

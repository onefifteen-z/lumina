import React, { useState, useCallback } from 'react';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import type { LLMAssistParams } from '../../shared/types';

export interface LLMAssistPanelProps {
  /** The currently selected text from the editor */
  selectedText: string;
  /** Position for the floating panel (relative to editor container) */
  position: { top: number; left: number } | null;
  /** Called when user accepts the suggestion — replaces selection */
  onAccept: (replacement: string) => void;
  /** Called when user dismisses the panel */
  onDismiss: () => void;
}

type AssistAction = LLMAssistParams['action'];
type AssistState = 'idle' | 'loading' | 'done' | 'error';

const ACTIONS: { action: AssistAction; label: string; icon: string }[] = [
  { action: 'summarize', label: 'Summarize', icon: '📝' },
  { action: 'expand', label: 'Expand', icon: '📖' },
  { action: 'refine', label: 'Refine', icon: '✨' },
];

const LLMAssistPanel: React.FC<LLMAssistPanelProps> = ({
  selectedText,
  position,
  onAccept,
  onDismiss,
}) => {
  const { isOffline } = useNetworkStatus();
  const [state, setState] = useState<AssistState>('idle');
  const [result, setResult] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [activeAction, setActiveAction] = useState<AssistAction | null>(null);

  const handleAction = useCallback(async (action: AssistAction) => {
    setActiveAction(action);
    setResult('');
    setErrorMsg('');
    setState('loading');

    try {
      const response = await window.api.assistContent({ text: selectedText, action });
      setResult(response);
      setState('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Assist request failed');
      setState('error');
    }
  }, [selectedText]);

  const handleAccept = useCallback(() => {
    onAccept(result);
    setState('idle');
    setResult('');
    setActiveAction(null);
  }, [result, onAccept]);

  const handleDismiss = useCallback(() => {
    setState('idle');
    setResult('');
    setActiveAction(null);
    setErrorMsg('');
    onDismiss();
  }, [onDismiss]);

  if (!position || !selectedText) return null;

  return (
    <div
      className="llm-assist-panel"
      style={{ top: position.top, left: position.left }}
      role="dialog"
      aria-label="AI Content Assistance"
    >
      {/* Action buttons row */}
      {state === 'idle' && (
        <div className="llm-assist-panel__actions">
          {ACTIONS.map(({ action, label, icon }) => (
            <button
              key={action}
              className="llm-assist-panel__action-btn"
              onClick={() => handleAction(action)}
              disabled={isOffline}
              title={isOffline ? 'Unavailable offline' : label}
            >
              <span aria-hidden="true">{icon}</span> {label}
            </button>
          ))}
          <button
            className="llm-assist-panel__close-btn"
            onClick={handleDismiss}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Loading state */}
      {state === 'loading' && (
        <div className="llm-assist-panel__loading">
          <span className="llm-assist-panel__spinner" aria-hidden="true">⏳</span>
          {activeAction === 'summarize' && 'Summarizing…'}
          {activeAction === 'expand' && 'Expanding…'}
          {activeAction === 'refine' && 'Refining…'}
          <button className="llm-assist-panel__close-btn" onClick={handleDismiss} aria-label="Cancel">×</button>
        </div>
      )}

      {/* Result with accept/reject */}
      {state === 'done' && (
        <div className="llm-assist-panel__result">
          <div className="llm-assist-panel__diff">
            <div className="llm-assist-panel__diff-label llm-assist-panel__diff-label--old">Original</div>
            <pre className="llm-assist-panel__diff-content llm-assist-panel__diff-content--old">{selectedText}</pre>
            <div className="llm-assist-panel__diff-label llm-assist-panel__diff-label--new">Suggestion</div>
            <pre className="llm-assist-panel__diff-content llm-assist-panel__diff-content--new">{result}</pre>
          </div>
          <div className="llm-assist-panel__result-actions">
            <button className="llm-assist-panel__btn llm-assist-panel__btn--accept" onClick={handleAccept}>
              Accept
            </button>
            <button className="llm-assist-panel__btn llm-assist-panel__btn--reject" onClick={handleDismiss}>
              Reject
            </button>
          </div>
        </div>
      )}

      {/* Error state */}
      {state === 'error' && (
        <div className="llm-assist-panel__error-state">
          <p className="llm-assist-panel__error-msg">{errorMsg}</p>
          <div className="llm-assist-panel__result-actions">
            <button className="llm-assist-panel__btn" onClick={() => activeAction && handleAction(activeAction)}>
              Retry
            </button>
            <button className="llm-assist-panel__btn llm-assist-panel__btn--reject" onClick={handleDismiss}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default LLMAssistPanel;

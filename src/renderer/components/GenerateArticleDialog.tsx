import React, { useState, useRef, useCallback } from 'react';
import { useNetworkStatus } from '../hooks/useNetworkStatus';

export interface GenerateArticleDialogProps {
  open: boolean;
  onClose: () => void;
  onAccept: (content: string) => void;
}

type GenerateState = 'idle' | 'generating' | 'done' | 'error';

const GenerateArticleDialog: React.FC<GenerateArticleDialogProps> = ({ open, onClose, onAccept }) => {
  const { isOffline, isLLMAvailable } = useNetworkStatus();
  const [prompt, setPrompt] = useState('');
  const [preview, setPreview] = useState('');
  const [state, setState] = useState<GenerateState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const abortRef = useRef(false);
  const llmDisabled = isOffline || !isLLMAvailable;

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) return;
    abortRef.current = false;
    setPreview('');
    setErrorMsg('');
    setState('generating');

    try {
      const stream = await window.api.generateArticle(prompt.trim());
      let accumulated = '';
      for await (const chunk of stream) {
        if (abortRef.current) break;
        accumulated += chunk;
        setPreview(accumulated);
      }
      if (!abortRef.current) {
        setState('done');
      }
    } catch (err) {
      if (!abortRef.current) {
        const msg = err instanceof Error ? err.message : 'Generation failed';
        // Classify error messages for user-friendly display
        if (msg.includes('Authentication') || msg.includes('401') || msg.includes('403')) {
          setErrorMsg('Authentication failed. Check your API key in Settings.');
        } else if (msg.includes('Rate limit') || msg.includes('429')) {
          setErrorMsg('Rate limit exceeded. Please wait a moment and try again.');
        } else if (msg.includes('timed out') || msg.includes('timeout')) {
          setErrorMsg('Request timed out. The LLM service may be slow or unreachable.');
        } else if (msg.includes('not configured')) {
          setErrorMsg('LLM service is not configured. Set up your provider in Settings.');
        } else {
          setErrorMsg(msg);
        }
        setState('error');
      }
    }
  }, [prompt]);

  const handleCancel = useCallback(() => {
    abortRef.current = true;
    setState('idle');
    setPreview('');
    setErrorMsg('');
  }, []);

  const handleAccept = useCallback(() => {
    onAccept(preview);
    // Reset state
    setPrompt('');
    setPreview('');
    setState('idle');
    setErrorMsg('');
  }, [preview, onAccept]);

  const handleClose = useCallback(() => {
    abortRef.current = true;
    setPrompt('');
    setPreview('');
    setState('idle');
    setErrorMsg('');
    onClose();
  }, [onClose]);

  if (!open) return null;

  return (
    <div className="generate-dialog__overlay" onClick={handleClose}>
      <div className="generate-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Generate Article with AI">
        <div className="generate-dialog__header">
          <h2 className="generate-dialog__title">Generate Article with AI</h2>
          <button className="generate-dialog__close" onClick={handleClose} aria-label="Close">×</button>
        </div>

        <div className="generate-dialog__body">
          {/* Prompt input */}
          <label className="generate-dialog__label" htmlFor="generate-prompt">Topic or prompt</label>
          <textarea
            id="generate-prompt"
            className="generate-dialog__textarea"
            placeholder="Describe the article topic…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={state === 'generating'}
            rows={3}
          />

          {isOffline && (
            <p className="generate-dialog__warning">You are offline. LLM features are unavailable.</p>
          )}
          {!isOffline && !isLLMAvailable && (
            <p className="generate-dialog__warning">LLM service is unavailable. Check your provider settings.</p>
          )}

          {/* Action buttons */}
          <div className="generate-dialog__actions">
            {state === 'idle' && (
              <button
                className="generate-dialog__btn generate-dialog__btn--primary"
                onClick={handleGenerate}
                disabled={!prompt.trim() || llmDisabled}
              >
                Generate
              </button>
            )}
            {state === 'generating' && (
              <button className="generate-dialog__btn generate-dialog__btn--cancel" onClick={handleCancel}>
                Cancel
              </button>
            )}
            {state === 'done' && (
              <>
                <button className="generate-dialog__btn generate-dialog__btn--primary" onClick={handleAccept}>
                  Edit in Editor
                </button>
                <button className="generate-dialog__btn" onClick={handleGenerate}>
                  Regenerate
                </button>
              </>
            )}
            {state === 'error' && (
              <button className="generate-dialog__btn" onClick={handleGenerate} disabled={llmDisabled}>
                Retry
              </button>
            )}
          </div>

          {/* Progress indicator */}
          {state === 'generating' && (
            <div className="generate-dialog__progress">
              <span className="generate-dialog__spinner" aria-hidden="true">⏳</span>
              Generating…
            </div>
          )}

          {/* Error message */}
          {state === 'error' && errorMsg && (
            <p className="generate-dialog__error" role="alert">{errorMsg}</p>
          )}

          {/* Preview area */}
          {preview && (
            <div className="generate-dialog__preview">
              <div className="generate-dialog__preview-label">Preview</div>
              <pre className="generate-dialog__preview-content">{preview}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default GenerateArticleDialog;

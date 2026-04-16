import React, { useState, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';

export interface CodeBlockProps {
  code: string;
  language?: string;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ code, language }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: silently fail if clipboard API is unavailable
    }
  }, [code]);

  const displayLanguage = language || 'text';

  return (
    <div className="my-3 rounded-lg overflow-hidden border border-border">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-surface-active text-text-secondary text-xs select-none">
        <span className="font-medium">{displayLanguage}</span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none"
        >
          {copied ? (
            <>
              <Check size={14} className="text-green-500" />
              <span className="text-green-500">Copied!</span>
            </>
          ) : (
            <>
              <Copy size={14} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Code content */}
      <pre className="overflow-x-auto px-4 py-3 bg-[--color-bg-secondary] m-0">
        <code
          className={`text-sm leading-relaxed text-text-primary font-mono ${language ? `language-${language}` : ''}`}
        >
          {code}
        </code>
      </pre>
    </div>
  );
};

export default CodeBlock;

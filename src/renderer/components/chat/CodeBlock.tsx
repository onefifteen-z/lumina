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
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: silently fail if clipboard API is unavailable
    }
  }, [code]);

  const displayLanguage = language || 'text';

  return (
    <div
      className="rounded-lg overflow-hidden text-sm"
      style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.1)' }}
    >
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-4 py-2.5 select-none"
        style={{ background: '#2a2a2a', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <span className="text-[11px] font-medium" style={{ color: '#888' }}>
          {displayLanguage}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          className="flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer hover:bg-white/10"
          style={{ color: copied ? '#4ade80' : '#888' }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      {/* Code content */}
      <pre className="overflow-x-auto px-4 py-4 m-0" style={{ background: '#1e1e1e' }}>
        <code
          className={`text-[0.8125rem] leading-[1.6] font-mono ${language ? `language-${language}` : ''}`}
          style={{ color: '#d4d4d4' }}
        >
          {code}
        </code>
      </pre>
    </div>
  );
};

export default CodeBlock;

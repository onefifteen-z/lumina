import React, { useState, useEffect, useRef, useCallback } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { basicSetup } from 'codemirror';
import { useNavigation } from './AppShell';
import { serializeArticleFile } from '../../shared/markdown-parser';
import type { ArticleFile, FrontmatterData } from '../../shared/types';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const ArticleEditor: React.FC = () => {
  const { editingTitle, navigate } = useNavigation();

  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveHandlerRef = useRef<() => void>(() => { });

  const [title, setTitle] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [originalFrontmatter, setOriginalFrontmatter] = useState<FrontmatterData | null>(null);

  // Save handler
  const handleSave = useCallback(async () => {
    const editorContent = viewRef.current?.state.doc.toString() ?? '';
    const trimmedTitle = title.trim();

    if (!trimmedTitle) {
      setSaveStatus('error');
      return;
    }

    setSaveStatus('saving');

    try {
      const now = new Date().toISOString();
      const frontmatter: FrontmatterData = {
        ...(originalFrontmatter ?? {}),
        title: trimmedTitle,
        tags: originalFrontmatter?.tags ?? [],
        created: originalFrontmatter?.created ?? now,
        modified: now,
      };

      const article: ArticleFile = {
        frontmatter,
        content: editorContent,
        rawContent: '',
      };

      article.rawContent = serializeArticleFile(article);

      await window.api.saveArticle(article);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err) {
      console.error('Failed to save article:', err);
      setSaveStatus('error');
    }
  }, [title, originalFrontmatter]);

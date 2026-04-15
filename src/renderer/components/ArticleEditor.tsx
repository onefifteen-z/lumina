import React, { useState, useEffect, useRef, useCallback } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { basicSetup } from 'codemirror';
import { useNavigation } from './AppShell';
import { serializeArticleFile } from '../../shared/markdown-parser';
import { obsidianSyntaxExtensions } from '../extensions/obsidian-syntax';
import { wikilinkAutocomplete } from '../extensions/wikilink-autocomplete';
import type { ArticleFile, FrontmatterData } from '../../shared/types';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const ArticleEditor: React.FC = () => {
  const { editingTitle, navigate, generatedContent, clearGeneratedContent } = useNavigation();

  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveHandlerRef = useRef<() => void>(() => { });

  const [title, setTitle] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [originalFrontmatter, setOriginalFrontmatter] = useState<FrontmatterData | null>(null);
  const [loading, setLoading] = useState(false);

  // Track last-saved state for dirty detection
  const savedTitleRef = useRef('');
  const savedContentRef = useRef('');
  const titleRef = useRef('');
  const [isDirty, setIsDirty] = useState(false);

  // Keep titleRef in sync with title state
  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  // Recompute dirty state whenever title changes
  const checkDirty = useCallback(() => {
    const currentContent = viewRef.current?.state.doc.toString() ?? '';
    const dirty = title !== savedTitleRef.current || currentContent !== savedContentRef.current;
    setIsDirty(dirty);
  }, [title]);

  useEffect(() => {
    checkDirty();
  }, [checkDirty]);

  // Notify main process whenever dirty state changes
  useEffect(() => {
    window.api.notifyUnsavedChanges(isDirty);
  }, [isDirty]);

  // beforeunload handler — prevent window close when dirty
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // Save handler
  const handleSave = useCallback(async () => {
    const editorContent = viewRef.current?.state.doc.toString() ?? '';
    const trimmedTitle = title.trim();

    if (!trimmedTitle) {
      setSaveStatus('error');
      return;
    }

    // Check for duplicate title when creating a new article (editingTitle is null)
    const isNewArticle = editingTitle === null;
    if (isNewArticle) {
      try {
        const exists = await window.api.articleExists(trimmedTitle);
        if (exists) {
          const overwrite = window.confirm(
            `An article titled "${trimmedTitle}" already exists. Do you want to overwrite it?`
          );
          if (!overwrite) return;
        }
      } catch (err) {
        console.error('Failed to check article existence:', err);
      }
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

      // Update saved state so isDirty resets to false
      savedTitleRef.current = trimmedTitle;
      savedContentRef.current = editorContent;
      setIsDirty(false);

      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err) {
      console.error('Failed to save article:', err);
      setSaveStatus('error');
    }
  }, [title, originalFrontmatter, editingTitle]);

  // Keep saveHandlerRef in sync so the keymap closure always calls the latest save
  useEffect(() => {
    saveHandlerRef.current = handleSave;
  }, [handleSave]);

  // Initialize CodeMirror editor
  useEffect(() => {
    if (!editorRef.current) return;

    const saveKeymap = keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          saveHandlerRef.current();
          return true;
        },
      },
    ]);

    // Update listener to detect document changes for dirty tracking
    const changeListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const currentContent = update.state.doc.toString();
        const dirty = titleRef.current !== savedTitleRef.current || currentContent !== savedContentRef.current;
        setIsDirty(dirty);
      }
    });

    const state = EditorState.create({
      doc: '',
      extensions: [
        basicSetup,
        markdown(),
        saveKeymap,
        EditorView.lineWrapping,
        ...obsidianSyntaxExtensions(),
        wikilinkAutocomplete(),
        changeListener,
      ],
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Load existing article when editingTitle changes
  useEffect(() => {
    if (!editingTitle) {
      // New article — reset state
      setTitle('');
      setOriginalFrontmatter(null);
      savedTitleRef.current = '';
      savedContentRef.current = '';
      setIsDirty(false);
      if (viewRef.current) {
        viewRef.current.dispatch({
          changes: {
            from: 0,
            to: viewRef.current.state.doc.length,
            insert: '',
          },
        });
      }
      return;
    }

    let cancelled = false;

    const loadArticle = async () => {
      setLoading(true);
      try {
        const article = await window.api.getArticle(editingTitle);
        if (cancelled) return;

        setTitle(article.frontmatter.title);
        setOriginalFrontmatter(article.frontmatter);

        // Set saved state baselines
        savedTitleRef.current = article.frontmatter.title;
        savedContentRef.current = article.content;
        setIsDirty(false);

        if (viewRef.current) {
          viewRef.current.dispatch({
            changes: {
              from: 0,
              to: viewRef.current.state.doc.length,
              insert: article.content,
            },
          });
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load article:', err);
          setSaveStatus('error');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadArticle();
    return () => { cancelled = true; };
  }, [editingTitle]);

  // Load generated content from LLM into the editor (new article flow)
  useEffect(() => {
    if (!generatedContent || editingTitle) return;
    if (viewRef.current) {
      viewRef.current.dispatch({
        changes: {
          from: 0,
          to: viewRef.current.state.doc.length,
          insert: generatedContent,
        },
      });
      // Mark dirty since we have unsaved generated content
      savedContentRef.current = '';
      setIsDirty(true);
    }
    clearGeneratedContent();
  }, [generatedContent, editingTitle, clearGeneratedContent]);

  // Clean up dirty notification on unmount
  useEffect(() => {
    return () => {
      window.api.notifyUnsavedChanges(false);
    };
  }, []);

  const handleBack = useCallback(() => {
    if (isDirty) {
      const discard = window.confirm('You have unsaved changes. Discard them and go back?');
      if (!discard) return;
    }
    navigate('browse');
  }, [navigate, isDirty]);

  const statusLabel =
    saveStatus === 'saving' ? 'Saving…' :
      saveStatus === 'saved' ? 'Saved' :
        saveStatus === 'error' ? (title.trim() ? 'Error saving' : 'Title is required') :
          '';

  const statusClass =
    saveStatus === 'idle' ? '' :
      `article-editor__status--${saveStatus}`;

  return (
    <div className="article-editor">
      {/* Toolbar */}
      <div className="article-editor__toolbar">
        <button
          className="article-editor__back-btn"
          onClick={handleBack}
          aria-label="Back to articles"
        >
          ← Back
        </button>
        <div className="article-editor__toolbar-right">
          {statusLabel && (
            <span className={`article-editor__status ${statusClass}`}>
              {statusLabel}
            </span>
          )}
          <button
            className="article-editor__save-btn"
            onClick={handleSave}
            disabled={saveStatus === 'saving'}
          >
            Save
          </button>
        </div>
      </div>

      {/* Title input */}
      <input
        className="article-editor__title"
        type="text"
        placeholder="Article title…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        aria-label="Article title"
      />

      {/* CodeMirror container */}
      {loading ? (
        <div className="article-editor__loading">Loading article…</div>
      ) : (
        <div className="article-editor__cm" ref={editorRef} />
      )}
    </div>
  );
};

export default ArticleEditor;

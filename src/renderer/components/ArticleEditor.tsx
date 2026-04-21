import React, { useState, useEffect, useRef, useCallback } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { basicSetup } from 'codemirror';
import { useNavigation } from './AppShell';
import { serializeArticleFile } from '../../shared/markdown-parser';
import { obsidianSyntaxExtensions } from '../extensions/obsidian-syntax';
import { wikilinkAutocomplete } from '../extensions/wikilink-autocomplete';
import { luminaMarkdownSyntaxHighlightExtensions } from '../extensions/cm-syntax-heading-no-underline';
import type { ArticleFile, FrontmatterData } from '../../shared/types';
import LLMAssistPanel from './LLMAssistPanel';
import { useCodeMirrorFindBackend } from '../find/use-codemirror-find-backend';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface ArticleEditorProps {
  /**
   * When true, render a compact editor for embedding under the article reader
   * (same tab, Obsidian-style) instead of the full-page layout.
   */
  embedded?: boolean;
  /** Called after a successful save (e.g. to refresh the reader preview). */
  onAfterSave?: () => void;
}

const ArticleEditor: React.FC<ArticleEditorProps> = ({ embedded = false, onAfterSave }) => {
  const { editingFilename, navigate, generatedContent, clearGeneratedContent, prefilledTitle, clearPrefilledTitle } = useNavigation();

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

  // LLM Assist panel state
  const [assistSelection, setAssistSelection] = useState('');
  const [assistPosition, setAssistPosition] = useState<{ top: number; left: number } | null>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);

  // Register a CodeMirror-backed find backend for the global Cmd+F FindBar.
  // Re-binds whenever the editor instance changes (handled via editingFilename
  // as a versioning hint).
  useCodeMirrorFindBackend(viewRef, true, embedded && editingFilename ? `${editingFilename}:embedded` : editingFilename);

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

    // Check for duplicate title when creating a new article (editingFilename is null)
    const isNewArticle = editingFilename === null;
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

      onAfterSave?.();

      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err) {
      console.error('Failed to save article:', err);
      setSaveStatus('error');
    }
  }, [title, originalFrontmatter, editingFilename, onAfterSave]);

  // Keep saveHandlerRef in sync so the keymap closure always calls the latest save
  useEffect(() => {
    saveHandlerRef.current = handleSave;
  }, [handleSave]);

  // Cmd/Ctrl+S — capture phase so Electron doesn't treat it as "Save Page".
  // Full-page: only when focus is inside this editor (incl. title). Inline: only
  // when focus is inside the embedded editor chrome / CodeMirror.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 's') return;
      if (!viewRef.current) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('[data-no-global-save]')) return;

      const insideThisEditor = !!el?.closest('.article-editor');
      if (!insideThisEditor) return;

      if (embedded) {
        const cmFocused = viewRef.current.hasFocus();
        if (!cmFocused && !el?.closest('.article-editor__toolbar')) return;
      } else {
        const inTitle = !!el?.closest('.article-editor__title');
        const cmFocused = viewRef.current.hasFocus();
        if (!cmFocused && !inTitle) return;
      }

      e.preventDefault();
      saveHandlerRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [embedded]);

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
      // Track text selection for LLM assist panel
      if (update.selectionSet || update.docChanged) {
        const sel = update.state.selection.main;
        const selectedText = update.state.sliceDoc(sel.from, sel.to);
        if (selectedText.trim().length > 0) {
          // Compute position relative to the editor container
          const coords = update.view.coordsAtPos(sel.from);
          if (coords && editorContainerRef.current) {
            const containerRect = editorContainerRef.current.getBoundingClientRect();
            setAssistSelection(selectedText);
            setAssistPosition({
              top: coords.bottom - containerRect.top + 4,
              left: Math.min(coords.left - containerRect.left, containerRect.width - 320),
            });
          }
        } else {
          setAssistSelection('');
          setAssistPosition(null);
        }
      }
    });

    const state = EditorState.create({
      doc: '',
      extensions: [
        basicSetup,
        ...luminaMarkdownSyntaxHighlightExtensions,
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

  // Load existing article when editingFilename changes
  useEffect(() => {
    if (!editingFilename) {
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
        const article = await window.api.getArticle(editingFilename);
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
  }, [editingFilename]);

  // Load generated content from LLM into the editor (new article flow)
  useEffect(() => {
    if (!generatedContent || editingFilename) return;
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
  }, [generatedContent, editingFilename, clearGeneratedContent]);

  // Seed the title input when the host requested a specific filename for the
  // new article (e.g. the "Create CLAUDE.md from template" flow). Runs once
  // per prefill: we clear it immediately so subsequent edits aren't clobbered.
  useEffect(() => {
    if (!prefilledTitle || editingFilename) return;
    setTitle(prefilledTitle);
    titleRef.current = prefilledTitle;
    // Don't update savedTitleRef — the file doesn't exist yet, so the editor
    // should show as dirty until the user saves.
    setIsDirty(true);
    clearPrefilledTitle();
  }, [prefilledTitle, editingFilename, clearPrefilledTitle]);

  // Clean up dirty notification on unmount
  useEffect(() => {
    return () => {
      window.api.notifyUnsavedChanges(false);
    };
  }, []);

  // Listen for external vault changes affecting the current article
  useEffect(() => {
    if (!editingFilename) return;

    const handler = (event: import('../../shared/types').VaultChangeEvent) => {
      // Only care about the file we're editing (compare vault-relative paths)
      if (event.filename.toLowerCase() !== editingFilename.toLowerCase()) return;

      if (event.type === 'unlink') {
        // File deleted externally
        const resave = window.confirm(
          `"${title}" was deleted externally. Save your current edits to recreate it, or close the editor?`
        );
        if (resave) {
          handleSave();
        } else {
          navigate('browse');
        }
      } else if (event.type === 'change') {
        // File modified externally
        if (isDirty) {
          const reload = window.confirm(
            `"${title}" was modified externally. Reload and lose your unsaved changes?`
          );
          if (!reload) return;
        }
        // Reload the article content
        window.api.getArticle(editingFilename).then((article) => {
          setTitle(article.frontmatter.title);
          setOriginalFrontmatter(article.frontmatter);
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
        }).catch((err) => {
          console.error('Failed to reload externally modified article:', err);
        });
      }
    };

    window.api.onVaultChange(handler);
    return () => {
      window.api.removeVaultChangeListener();
    };
  }, [editingFilename, isDirty, handleSave, navigate, title]);

  const handleAssistAccept = useCallback((replacement: string) => {
    if (!viewRef.current) return;
    const sel = viewRef.current.state.selection.main;
    viewRef.current.dispatch({
      changes: { from: sel.from, to: sel.to, insert: replacement },
    });
    setAssistSelection('');
    setAssistPosition(null);
  }, []);

  const handleAssistDismiss = useCallback(() => {
    setAssistSelection('');
    setAssistPosition(null);
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
    <div
      className={
        embedded
          ? 'article-editor article-editor--embedded article-editor--inline-surface'
          : 'article-editor'
      }
    >
      {/* Toolbar */}
      <div className="article-editor__toolbar">
        <div className="article-editor__toolbar-left">
          <button
            type="button"
            className="article-editor__back-btn"
            onClick={handleBack}
            aria-label={embedded ? 'Cancel editing and return to preview' : 'Back to articles'}
          >
            {embedded ? 'Cancel' : '← Back'}
          </button>
        </div>
        <div className="article-editor__toolbar-right">
          {embedded && (
            <span className="article-editor__kbd-hint" aria-hidden="true">
              ⌘S save
            </span>
          )}
          {statusLabel && (
            <span className={`article-editor__status ${statusClass}`}>
              {statusLabel}
            </span>
          )}
          <button
            type="button"
            className="article-editor__save-btn"
            onClick={handleSave}
            disabled={saveStatus === 'saving'}
          >
            Save
          </button>
        </div>
      </div>

      {/* Title input — full-page editor only (inline uses front-matter title from file). */}
      {!embedded && (
        <input
          className="article-editor__title"
          type="text"
          placeholder="Article title…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Article title"
        />
      )}

      {/* CodeMirror: mount the host node immediately so init effect ([]) can run;
          async load overlays a spinner without destroying the editor. */}
      <div className="article-editor__cm-wrapper" ref={editorContainerRef}>
        {loading && (
          <div className="article-editor__loading-overlay" aria-busy="true">
            Loading…
          </div>
        )}
        <div className="article-editor__cm" ref={editorRef} />
        <LLMAssistPanel
          selectedText={assistSelection}
          position={assistPosition}
          onAccept={handleAssistAccept}
          onDismiss={handleAssistDismiss}
        />
      </div>
    </div>
  );
};

export default ArticleEditor;

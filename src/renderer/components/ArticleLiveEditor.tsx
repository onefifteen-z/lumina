import React, { useCallback, useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { basicSetup } from "codemirror";
import { serializeArticleFile } from "../../shared/markdown-parser";
import type { ArticleFile, FrontmatterData } from "../../shared/types";
import { useNavigation } from "./AppShell";
import { normalizeLiveMarkdownForVault } from "../lib/live-editor-markdown";
import { obsidianSyntaxExtensions } from "../extensions/obsidian-syntax";
import { wikilinkAutocomplete } from "../extensions/wikilink-autocomplete";
import { markdownLivePreview } from "../extensions/markdown-live-preview";

type SaveStatus = "idle" | "saving" | "saved" | "error";

const FIND_BUMP_DEBOUNCE_MS = 200;

export interface ArticleLiveEditorProps {
  filename: string;
  article: ArticleFile;
  findRootRef: React.RefObject<HTMLDivElement | null>;
  onLiveFindVersionBump?: () => void;
  onAfterSave?: () => void;
}

const sameNormalized = (a: string, b: string): boolean =>
  normalizeLiveMarkdownForVault(a) === normalizeLiveMarkdownForVault(b);

const ArticleLiveEditor: React.FC<ArticleLiveEditorProps> = ({
  filename,
  article,
  findRootRef,
  onLiveFindVersionBump,
  onAfterSave,
}) => {
  const { navigate } = useNavigation();
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveHandlerRef = useRef<() => void>(() => {});

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [isDirty, setIsDirty] = useState(false);
  const savedMarkdownRef = useRef(article.content);
  const [liveBody, setLiveBody] = useState(article.content);
  const prevFilenameRef = useRef<string | null>(null);

  const bumpFindRef = useRef(onLiveFindVersionBump);
  bumpFindRef.current = onLiveFindVersionBump;
  const findBumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleFindBump = useCallback(() => {
    if (findBumpTimerRef.current) clearTimeout(findBumpTimerRef.current);
    findBumpTimerRef.current = setTimeout(() => {
      findBumpTimerRef.current = null;
      bumpFindRef.current?.();
    }, FIND_BUMP_DEBOUNCE_MS);
  }, []);

  const docLabel =
    filename.split("/").pop()?.replace(/\.md$/i, "") ?? filename;

  const bodyFromParent = article.content;
  useEffect(() => {
    const switchedFile = prevFilenameRef.current !== filename;
    prevFilenameRef.current = filename;
    if (switchedFile) {
      savedMarkdownRef.current = bodyFromParent;
      setLiveBody(bodyFromParent);
      setIsDirty(false);
      return;
    }
    if (sameNormalized(bodyFromParent, savedMarkdownRef.current)) return;
    savedMarkdownRef.current = bodyFromParent;
    setLiveBody(bodyFromParent);
    setIsDirty(false);
  }, [filename, bodyFromParent]);

  useEffect(() => {
    if (!editorRef.current) return;

    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        run: () => {
          saveHandlerRef.current();
          return true;
        },
      },
    ]);

    const changeListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const currentContent = update.state.doc.toString();
        setIsDirty(!sameNormalized(currentContent, savedMarkdownRef.current));
        scheduleFindBump();
      }
    });

    const state = EditorState.create({
      doc: savedMarkdownRef.current,
      extensions: [
        basicSetup,
        markdown(),
        saveKeymap,
        EditorView.lineWrapping,
        ...obsidianSyntaxExtensions(),
        wikilinkAutocomplete(),
        markdownLivePreview(),
        changeListener,
      ],
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });
    viewRef.current = view;

    return () => {
      if (findBumpTimerRef.current) clearTimeout(findBumpTimerRef.current);
      view.destroy();
      viewRef.current = null;
    };
  }, [scheduleFindBump]);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const doc = v.state.doc.toString();
    if (doc === liveBody) return;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: liveBody },
    });
    setIsDirty(!sameNormalized(liveBody, savedMarkdownRef.current));
    scheduleFindBump();
  }, [liveBody, scheduleFindBump]);

  useEffect(() => {
    bumpFindRef.current?.();
  }, []);

  const handleSave = useCallback(async () => {
    const raw = viewRef.current?.state.doc.toString() ?? "";
    const editorContent = normalizeLiveMarkdownForVault(raw);
    const trimmedTitle = (article.frontmatter.title ?? "").trim();
    if (!trimmedTitle) {
      setSaveStatus("error");
      return;
    }

    setSaveStatus("saving");
    try {
      const now = new Date().toISOString();
      const frontmatter: FrontmatterData = {
        ...article.frontmatter,
        title: trimmedTitle,
        tags: article.frontmatter.tags ?? [],
        created: article.frontmatter.created || now,
        modified: now,
      };

      const toSave: ArticleFile = {
        frontmatter,
        content: editorContent,
        rawContent: "",
      };
      toSave.rawContent = serializeArticleFile(toSave);

      await window.api.saveArticle(toSave);
      savedMarkdownRef.current = editorContent;
      setLiveBody(editorContent);
      setIsDirty(false);
      onAfterSave?.();
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
      bumpFindRef.current?.();
    } catch (err) {
      console.error("Failed to save article:", err);
      setSaveStatus("error");
    }
  }, [article.frontmatter, onAfterSave]);

  useEffect(() => {
    saveHandlerRef.current = handleSave;
  }, [handleSave]);

  useEffect(() => {
    window.api.notifyUnsavedChanges(isDirty);
  }, [isDirty]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  useEffect(() => {
    return () => {
      window.api.notifyUnsavedChanges(false);
    };
  }, []);

  useEffect(() => {
    const handler = (event: import("../../shared/types").VaultChangeEvent) => {
      if (event.filename.toLowerCase() !== filename.toLowerCase()) return;
      if (event.type === "unlink") {
        const resave = window.confirm(
          `"${article.frontmatter.title}" was deleted externally. Save your current edits to recreate it, or leave the reader?`,
        );
        if (resave) {
          saveHandlerRef.current();
        } else {
          navigate("browse");
        }
      } else if (event.type === "change") {
        if (isDirty) {
          const reload = window.confirm(
            `"${article.frontmatter.title}" was modified externally. Reload and lose your unsaved changes?`,
          );
          if (!reload) return;
        }
        void window.api.getArticle(filename).then((next) => {
          savedMarkdownRef.current = next.content;
          setLiveBody(next.content);
          setIsDirty(false);
        });
      }
    };
    window.api.onVaultChange(handler);
    return () => {
      window.api.removeVaultChangeListener();
    };
  }, [filename, isDirty, navigate, article.frontmatter.title]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "s") return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("[data-no-global-save]")) return;
      if (!el?.closest(".article-live-editor")) return;

      const inToolbar = !!el?.closest(".article-editor__toolbar");
      const inCm =
        !!el?.closest(".cm-editor") ||
        !!el?.closest(".cm-content") ||
        !!el?.closest(".cm-scroller");
      if (!inToolbar && !inCm) return;

      e.preventDefault();
      saveHandlerRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const handleBack = useCallback(() => {
    if (isDirty) {
      const discard = window.confirm(
        "You have unsaved changes. Discard them and go back?",
      );
      if (!discard) return;
    }
    navigate("browse");
  }, [navigate, isDirty]);

  const statusLabel =
    saveStatus === "saving"
      ? "Saving…"
      : saveStatus === "saved"
        ? "Saved"
        : saveStatus === "error"
          ? article.frontmatter.title?.trim()
            ? "Error saving"
            : "Title is required"
          : "";

  const statusClass =
    saveStatus === "idle" ? "" : `article-editor__status--${saveStatus}`;

  return (
    <div
      ref={findRootRef}
      className="article-live-editor article-editor article-editor--embedded article-editor--inline-surface"
    >
      <div className="article-editor__toolbar">
        <div className="article-editor__toolbar-left">
          <button
            type="button"
            className="article-editor__back-btn"
            onClick={handleBack}
            aria-label="Back to preview"
          >
            Done
          </button>
          <span className="article-editor__doc-label" title={filename}>
            {docLabel}
          </span>
        </div>
        <div className="article-editor__toolbar-right">
          <span className="article-editor__kbd-hint" aria-hidden="true">
            ⌘S save
          </span>
          {statusLabel && (
            <span className={`article-editor__status ${statusClass}`}>
              {statusLabel}
            </span>
          )}
          <button
            type="button"
            className="article-editor__save-btn"
            onClick={handleSave}
            disabled={saveStatus === "saving"}
          >
            Save
          </button>
        </div>
      </div>

      <div className="article-live-editor__surface article-editor__cm-wrapper">
        <div className="article-editor__cm article-live-editor__cm" ref={editorRef} />
      </div>
    </div>
  );
};

export default ArticleLiveEditor;

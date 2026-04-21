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
import { luminaMarkdownSyntaxHighlightExtensions } from "../extensions/cm-syntax-heading-no-underline";
import {
  ArticleFrontmatterFields,
  FM_SNAPSHOT_SKIP,
  cloneFrontmatter,
} from "./ArticleFrontmatterFields";

type SaveStatus = "idle" | "saving" | "saved" | "error";

const FIND_BUMP_DEBOUNCE_MS = 200;

export type ExternalFrontmatterBinding = {
  draft: FrontmatterData;
  onPatch: (mutate: (prev: FrontmatterData) => FrontmatterData) => void;
};

export interface ArticleLiveEditorProps {
  filename: string;
  article: ArticleFile;
  findRootRef: React.RefObject<HTMLDivElement | null>;
  onLiveFindVersionBump?: () => void;
  onAfterSave?: () => void;
  /** Parent-owned frontmatter draft (e.g. inline edit in ArticleBrowser). */
  externalFrontmatter?: ExternalFrontmatterBinding;
  /** Hide the Properties block here — parent renders fields in-place. */
  hidePropertiesPanel?: boolean;
}

const sameNormalized = (a: string, b: string): boolean =>
  normalizeLiveMarkdownForVault(a) === normalizeLiveMarkdownForVault(b);

function snapshotFrontmatter(fm: FrontmatterData): string {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (FM_SNAPSHOT_SKIP.has(k)) continue;
    extra[k] = v;
  }
  const keys = Object.keys(extra).sort();
  const sortedExtra: Record<string, unknown> = {};
  for (const k of keys) sortedExtra[k] = extra[k];
  return JSON.stringify({
    title: fm.title ?? "",
    tags: fm.tags ?? [],
    created: fm.created ?? "",
    modified: fm.modified ?? "",
    extra: sortedExtra,
  });
}

const ArticleLiveEditor: React.FC<ArticleLiveEditorProps> = ({
  filename,
  article,
  findRootRef,
  onLiveFindVersionBump,
  onAfterSave,
  externalFrontmatter,
  hidePropertiesPanel = false,
}) => {
  const { navigate } = useNavigation();
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveHandlerRef = useRef<() => void>(() => {});

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [isDirty, setIsDirty] = useState(false);
  const savedMarkdownRef = useRef(article.content);
  const [liveBody, setLiveBody] = useState(article.content);
  const [internalDraftFm, setInternalDraftFm] = useState<FrontmatterData>(() =>
    cloneFrontmatter(article.frontmatter),
  );
  const prevFilenameRef = useRef<string | null>(null);
  const savedFmSnapshotRef = useRef(snapshotFrontmatter(article.frontmatter));
  const effectiveDraftFm = externalFrontmatter?.draft ?? internalDraftFm;
  const draftFmRef = useRef(effectiveDraftFm);
  draftFmRef.current = effectiveDraftFm;
  const externalFmRef = useRef(externalFrontmatter);
  externalFmRef.current = externalFrontmatter;

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

  const syncDirty = useCallback(() => {
    const raw = viewRef.current?.state.doc.toString() ?? "";
    const bodyDirty = !sameNormalized(
      normalizeLiveMarkdownForVault(raw),
      savedMarkdownRef.current,
    );
    const fmDirty =
      snapshotFrontmatter(draftFmRef.current) !== savedFmSnapshotRef.current;
    setIsDirty(bodyDirty || fmDirty);
  }, []);

  const patchDraftFm = useCallback(
    (mutate: (prev: FrontmatterData) => FrontmatterData) => {
      const ext = externalFmRef.current;
      if (ext) {
        ext.onPatch(mutate);
        queueMicrotask(syncDirty);
        return;
      }
      setInternalDraftFm((prev) => {
        const next = mutate(prev);
        draftFmRef.current = next;
        queueMicrotask(syncDirty);
        return next;
      });
    },
    [syncDirty],
  );

  const bodyFromParent = article.content;
  useEffect(() => {
    const switchedFile = prevFilenameRef.current !== filename;
    prevFilenameRef.current = filename;
    const fm = cloneFrontmatter(article.frontmatter);
    if (switchedFile) {
      savedMarkdownRef.current = bodyFromParent;
      setLiveBody(bodyFromParent);
      if (!externalFmRef.current) {
        setInternalDraftFm(fm);
        draftFmRef.current = fm;
      }
      savedFmSnapshotRef.current = snapshotFrontmatter(fm);
      if (externalFmRef.current) {
        draftFmRef.current = externalFmRef.current.draft;
      }
      setIsDirty(false);
      return;
    }
    if (isDirty) return;
    if (!sameNormalized(bodyFromParent, savedMarkdownRef.current)) {
      savedMarkdownRef.current = bodyFromParent;
      setLiveBody(bodyFromParent);
    }
    if (!externalFmRef.current) {
      setInternalDraftFm(fm);
      draftFmRef.current = fm;
    }
    savedFmSnapshotRef.current = snapshotFrontmatter(fm);
    if (externalFmRef.current) {
      draftFmRef.current = externalFmRef.current.draft;
    }
    setIsDirty(false);
  }, [filename, bodyFromParent, article, isDirty]);

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
        syncDirty();
        scheduleFindBump();
      }
    });

    const state = EditorState.create({
      doc: savedMarkdownRef.current,
      extensions: [
        basicSetup,
        ...luminaMarkdownSyntaxHighlightExtensions,
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
  }, [scheduleFindBump, syncDirty]);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const doc = v.state.doc.toString();
    if (doc === liveBody) return;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: liveBody },
    });
    syncDirty();
    scheduleFindBump();
  }, [liveBody, scheduleFindBump, syncDirty]);

  useEffect(() => {
    bumpFindRef.current?.();
  }, []);

  const handleSave = useCallback(async () => {
    const raw = viewRef.current?.state.doc.toString() ?? "";
    const editorContent = normalizeLiveMarkdownForVault(raw);
    const fm0 = externalFmRef.current?.draft ?? draftFmRef.current;
    const trimmedTitle = (fm0.title ?? "").trim();
    if (!trimmedTitle) {
      setSaveStatus("error");
      return;
    }

    setSaveStatus("saving");
    try {
      const now = new Date().toISOString();
      const frontmatter: FrontmatterData = {
        ...fm0,
        title: trimmedTitle,
        tags: fm0.tags ?? [],
        created: (fm0.created ?? "").trim() || now,
        modified: (fm0.modified ?? "").trim() || now,
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
      if (!externalFmRef.current) {
        setInternalDraftFm(cloneFrontmatter(frontmatter));
        draftFmRef.current = cloneFrontmatter(frontmatter);
      }
      savedFmSnapshotRef.current = snapshotFrontmatter(frontmatter);
      setIsDirty(false);
      onAfterSave?.();
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
      bumpFindRef.current?.();
    } catch (err) {
      console.error("Failed to save article:", err);
      setSaveStatus("error");
    }
  }, [onAfterSave]);

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
          const fm = cloneFrontmatter(next.frontmatter);
          if (externalFmRef.current) {
            externalFmRef.current.onPatch(() => fm);
            draftFmRef.current = fm;
          } else {
            setInternalDraftFm(fm);
            draftFmRef.current = fm;
          }
          savedFmSnapshotRef.current = snapshotFrontmatter(fm);
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
      const inProps = !!el?.closest(".article-live-editor__properties");
      const inCm =
        !!el?.closest(".cm-editor") ||
        !!el?.closest(".cm-content") ||
        !!el?.closest(".cm-scroller");
      if (!inToolbar && !inCm && !inProps) return;

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
          ? effectiveDraftFm.title?.trim()
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
            aria-label="Cancel editing and return to preview"
          >
            Cancel
          </button>
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

      {!hidePropertiesPanel && (
        <div className="article-live-editor__properties" data-article-properties>
          <h3 className="article-live-editor__properties-title">Properties</h3>
          <ArticleFrontmatterFields draftFm={effectiveDraftFm} onPatch={patchDraftFm} />
        </div>
      )}

      <div className="article-live-editor__surface article-editor__cm-wrapper">
        <div className="article-editor__cm article-live-editor__cm" ref={editorRef} />
      </div>
    </div>
  );
};

export default ArticleLiveEditor;

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkHtml from 'remark-html';
import remarkWikilinks from '../plugins/remark-wikilinks';
import remarkEmbeds from '../plugins/remark-embeds';
import remarkTags from '../plugins/remark-tags';
import type { ArticleFile } from '../../shared/types';
import { titleToFilename } from '../../shared/markdown-parser';
import { useNavigation } from './AppShell';
import { extractHeadings, addHeadingIds, type TocHeading } from './TocPanel';
import { AlignLeft, Calendar, List, Tag, X } from 'lucide-react';

// ── Remark pipeline ────────────────────────────────────────────

const markdownToHtml = (markdown: string): string => {
  const result = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkWikilinks)
    .use(remarkEmbeds)
    .use(remarkTags)
    .use(remarkHtml, { sanitize: false })
    .processSync(markdown);
  return String(result);
};

// ── Date formatting ────────────────────────────────────────────

const formatDate = (iso: string): string => {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '—';
  }
};

// ── ArticleBrowser (viewer-only) ───────────────────────────────

interface ArticleBrowserProps {
  selectedFilename: string | null;
  onHeadingsChange?: (headings: TocHeading[]) => void;
  onNavigate?: (filename: string) => void;
}

const ArticleBrowser: React.FC<ArticleBrowserProps> = ({ selectedFilename, onHeadingsChange, onNavigate }) => {
  const { editArticle } = useNavigation();

  // Selected article state
  const [article, setArticle] = useState<ArticleFile | null>(null);
  const [currentFilename, setCurrentFilename] = useState<string | null>(null);
  const [renderedHtml, setRenderedHtml] = useState('');
  const [backlinks, setBacklinks] = useState<{ title: string; filename: string }[]>([]);
  const [articleLoading, setArticleLoading] = useState(false);
  const [articleError, setArticleError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Fetch article content + backlinks by vault-relative filename
  const selectArticle = useCallback(async (filename: string) => {
    // Non-markdown files cannot be rendered — just track the selection
    if (!filename.toLowerCase().endsWith(".md")) {
      setArticle(null);
      setCurrentFilename(filename);
      setRenderedHtml('');
      setBacklinks([]);
      setArticleError(null);
      setArticleLoading(false);
      onHeadingsChange?.([]);
      return;
    }

    setArticleLoading(true);
    setArticleError(null);
    setArticle(null);
    setCurrentFilename(null);
    setRenderedHtml('');
    setBacklinks([]);

    try {
      const fetched = await window.api.getArticle(filename);
      const links = await window.api.getBacklinks(fetched.frontmatter.title);
      const headings = extractHeadings(fetched.content);
      const html = addHeadingIds(markdownToHtml(fetched.content), headings);
      setArticle(fetched);
      setCurrentFilename(filename);
      setRenderedHtml(html);
      setBacklinks(links);
      onHeadingsChange?.(headings);
    } catch (err) {
      setArticleError(err instanceof Error ? err.message : 'Failed to load article');
    } finally {
      setArticleLoading(false);
    }
  }, [onHeadingsChange]);

  // Fetch article when selectedFilename prop changes
  useEffect(() => {
    if (selectedFilename) {
      selectArticle(selectedFilename);
    } else {
      setArticle(null);
      setCurrentFilename(null);
      setRenderedHtml('');
      setBacklinks([]);
      setArticleError(null);
      onHeadingsChange?.([]);
    }
  }, [selectedFilename, selectArticle]);

  // After each render, mark wikilinks whose target file doesn't exist
  useEffect(() => {
    if (!renderedHtml || !contentRef.current) return;
    const container = contentRef.current;
    const links = Array.from(container.querySelectorAll<HTMLElement>('.wikilink'));
    if (links.length === 0) return;

    let cancelled = false;
    Promise.all(
      links.map(async (el) => {
        const target = el.getAttribute('data-target');
        if (!target) return;
        const resolved = await window.api.resolveWikilink(target);
        if (!cancelled) {
          el.classList.toggle('wikilink--missing', !resolved.exists);
        }
      })
    );
    return () => { cancelled = true; };
  }, [renderedHtml]);

  // Navigate to a backlinked article by its filename
  const handleBacklinkClick = useCallback((filename: string) => {
    if (onNavigate) onNavigate(filename);
    else selectArticle(filename);
  }, [selectArticle, onNavigate]);

  // Click handler for rendered content (wikilinks, tags, embeds)
  const handleContentClick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;

    const navigateTo = onNavigate || selectArticle;

    // Handle wikilink clicks
    const wikilink = target.closest('.wikilink');
    if (wikilink) {
      e.preventDefault();
      const articleTarget = wikilink.getAttribute('data-target');
      if (articleTarget) {
        const resolved = await window.api.resolveWikilink(articleTarget);
        if (resolved.exists && resolved.filename) {
          navigateTo(resolved.filename);
        } else {
          const create = window.confirm(`Article '${articleTarget}' doesn't exist. Create it?`);
          if (create) {
            editArticle(titleToFilename(articleTarget) + '.md');
          }
        }
      }
      return;
    }

    // Handle inline tag clicks — no-op for now (tag filtering removed)
    const tag = target.closest('.inline-tag');
    if (tag) {
      return;
    }

    // Handle embed clicks
    const embed = target.closest('.embed');
    if (embed) {
      const embedTarget = embed.getAttribute('data-target');
      if (embedTarget) {
        const resolved = await window.api.resolveWikilink(embedTarget);
        if (resolved.exists && resolved.filename) {
          navigateTo(resolved.filename);
        } else {
          const create = window.confirm(`Article '${embedTarget}' doesn't exist. Create it?`);
          if (create) {
            editArticle(titleToFilename(embedTarget) + '.md');
          }
        }
      }
      return;
    }
  }, [selectArticle, editArticle, onNavigate]);

  // ── Render ─────────────────────────────────────────────────────

  return (
    <section className="article-browser__view">
      {!selectedFilename && (
        <div className="article-browser__empty">Select an article to view</div>
      )}

      {selectedFilename && !selectedFilename.toLowerCase().endsWith(".md") && !articleLoading && !articleError && !article && (
        <div className="article-browser__status">
          Preview not available for this file type.
        </div>
      )}

      {selectedFilename && articleLoading && (
        <div className="article-browser__status">Loading article…</div>
      )}

      {selectedFilename && articleError && (
        <div className="article-browser__status article-browser__status--error">
          {articleError}
        </div>
      )}

      {selectedFilename && article && !articleLoading && !articleError && (
        <>
          {/* Corrupted file warning */}
          {article.frontmatter._corrupted && (
            <div className="article-view__warning" role="alert">
              ⚠ This file has corrupted frontmatter and is displayed as raw content.
            </div>
          )}

          {/* Filename */}
          <h1 className="text-lg font-bold text-text-primary mb-4">{currentFilename?.split('/').pop()?.replace(/\.md$/i, '')}</h1>

          {/* Properties panel */}
          <div className="mb-6 pb-4 border-b border-border">
            <h2 className="text-sm font-semibold text-text-primary mb-3">Properties</h2>
            <div className="flex flex-col gap-2.5">
              {/* title */}
              <div className="flex items-start gap-3 text-[13px]">
                <div className="flex items-center gap-2 w-28 shrink-0 text-text-secondary">
                  <AlignLeft size={14} className="opacity-60" />
                  <span>title</span>
                </div>
                <span className="text-text-primary">{article.frontmatter.title}</span>
              </div>

              {/* extra string fields */}
              {Object.entries(article.frontmatter)
                .filter(([k, v]) => !['title', 'tags', 'created', 'modified', '_corrupted'].includes(k) && typeof v === 'string')
                .map(([k, v]) => (
                  <div key={k} className="flex items-start gap-3 text-[13px]">
                    <div className="flex items-center gap-2 w-28 shrink-0 text-text-secondary">
                      <AlignLeft size={14} className="opacity-60" />
                      <span>{k}</span>
                    </div>
                    <span className="text-text-primary">{v as string}</span>
                  </div>
                ))}

              {/* created */}
              <div className="flex items-start gap-3 text-[13px]">
                <div className="flex items-center gap-2 w-28 shrink-0 text-text-secondary">
                  <Calendar size={14} className="opacity-60" />
                  <span>created</span>
                </div>
                <span className="text-text-primary">{formatDate(article.frontmatter.created)}</span>
              </div>

              {/* modified */}
              <div className="flex items-start gap-3 text-[13px]">
                <div className="flex items-center gap-2 w-28 shrink-0 text-text-secondary">
                  <Calendar size={14} className="opacity-60" />
                  <span>updated</span>
                </div>
                <span className="text-text-primary">{formatDate(article.frontmatter.modified)}</span>
              </div>

              {/* list fields (sources etc.) */}
              {Object.entries(article.frontmatter)
                .filter(([k, v]) => !['title', 'tags', 'created', 'modified', '_corrupted'].includes(k) && Array.isArray(v) && k !== 'tags')
                .map(([k, v]) => (
                  <div key={k} className="flex items-start gap-3 text-[13px]">
                    <div className="flex items-center gap-2 w-28 shrink-0 text-text-secondary">
                      <List size={14} className="opacity-60" />
                      <span>{k}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(v as string[]).map((item, i) => (
                        <span key={i} className="text-text-primary">{item}</span>
                      ))}
                    </div>
                  </div>
                ))}

              {/* tags */}
              {article.frontmatter.tags.length > 0 && (
                <div className="flex items-start gap-3 text-[13px]">
                  <div className="flex items-center gap-2 w-28 shrink-0 text-text-secondary">
                    <Tag size={14} className="opacity-60" />
                    <span>tags</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {article.frontmatter.tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1 px-2.5 py-0.5 text-xs rounded-full bg-primary-bg text-primary-text"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Rendered markdown body */}
          <div
            ref={contentRef}
            className="article-view__content"
            onClick={handleContentClick}
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />

          {/* Backlinks */}
          {backlinks.length > 0 && (
            <section className="article-view__backlinks">
              <h3 className="article-view__backlinks-title">Backlinks</h3>
              <ul className="article-view__backlinks-list">
                {backlinks.map((link) => (
                  <li key={link.filename}>
                    <button
                      className="article-view__backlink"
                      onClick={() => handleBacklinkClick(link.filename)}
                    >
                      {link.title}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  );
};

export default ArticleBrowser;

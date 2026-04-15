import React, { useState, useEffect, useCallback } from 'react';
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
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
};

// ── ArticleBrowser (viewer-only) ───────────────────────────────

interface ArticleBrowserProps {
  selectedFilename: string | null;
  onHeadingsChange?: (headings: TocHeading[]) => void;
}

const ArticleBrowser: React.FC<ArticleBrowserProps> = ({ selectedFilename, onHeadingsChange }) => {
  const { editArticle } = useNavigation();

  // Selected article state
  const [article, setArticle] = useState<ArticleFile | null>(null);
  const [currentFilename, setCurrentFilename] = useState<string | null>(null);
  const [renderedHtml, setRenderedHtml] = useState('');
  const [backlinks, setBacklinks] = useState<{ title: string; filename: string }[]>([]);
  const [articleLoading, setArticleLoading] = useState(false);
  const [articleError, setArticleError] = useState<string | null>(null);

  // Fetch article content + backlinks by vault-relative filename
  const selectArticle = useCallback(async (filename: string) => {
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
  }, []);

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

  // Navigate to a backlinked article by its filename
  const handleBacklinkClick = useCallback((filename: string) => {
    selectArticle(filename);
  }, [selectArticle]);

  // Click handler for rendered content (wikilinks, tags, embeds)
  const handleContentClick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;

    // Handle wikilink clicks
    const wikilink = target.closest('.wikilink');
    if (wikilink) {
      e.preventDefault();
      const articleTarget = wikilink.getAttribute('data-target');
      if (articleTarget) {
        const resolved = await window.api.resolveWikilink(articleTarget);
        if (resolved.exists) {
          // Wikilinks reference flat-vault files by title; derive filename the same way
          selectArticle(titleToFilename(resolved.title) + '.md');
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
        if (resolved.exists) {
          selectArticle(titleToFilename(resolved.title) + '.md');
        } else {
          const create = window.confirm(`Article '${embedTarget}' doesn't exist. Create it?`);
          if (create) {
            editArticle(titleToFilename(embedTarget) + '.md');
          }
        }
      }
      return;
    }
  }, [selectArticle, editArticle]);

  // ── Render ─────────────────────────────────────────────────────

  return (
    <section className="article-browser__view">
      {!selectedFilename && (
        <div className="article-browser__empty">Select an article to view</div>
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

          {/* Metadata header */}
          <header className="article-view__header">
            <h1 className="article-view__title">{article.frontmatter.title}</h1>

            <div className="article-view__meta">
              <span className="article-view__date">
                Created {formatDate(article.frontmatter.created)}
              </span>
              <span className="article-view__date">
                Modified {formatDate(article.frontmatter.modified)}
              </span>
            </div>

            {article.frontmatter.tags.length > 0 && (
              <div className="article-view__tags">
                {article.frontmatter.tags.map((tag) => (
                  <span
                    key={tag}
                    className="article-view__tag"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            )}

            <button
              className="article-view__edit-btn"
              onClick={() => currentFilename && editArticle(currentFilename)}
            >
              ✏️ Edit
            </button>
          </header>

          {/* Rendered markdown body */}
          <div
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

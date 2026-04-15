import React, { useState, useEffect, useCallback } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkHtml from 'remark-html';
import remarkWikilinks from '../plugins/remark-wikilinks';
import remarkEmbeds from '../plugins/remark-embeds';
import remarkTags from '../plugins/remark-tags';
import type { ArticleMeta, ArticleFile } from '../../shared/types';
import { useNavigation } from './AppShell';

// ── Remark pipeline ────────────────────────────────────────────

const markdownToHtml = (markdown: string): string => {
  const result = unified()
    .use(remarkParse)
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

// ── ArticleBrowser ─────────────────────────────────────────────

const ArticleBrowser: React.FC = () => {
  const { editArticle } = useNavigation();

  // Article list state
  const [articles, setArticles] = useState<ArticleMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selected article state
  const [selectedTitle, setSelectedTitle] = useState<string | null>(null);
  const [article, setArticle] = useState<ArticleFile | null>(null);
  const [renderedHtml, setRenderedHtml] = useState('');
  const [backlinks, setBacklinks] = useState<string[]>([]);
  const [articleLoading, setArticleLoading] = useState(false);
  const [articleError, setArticleError] = useState<string | null>(null);

  // Fetch article list on mount
  useEffect(() => {
    let cancelled = false;

    const fetchArticles = async () => {
      try {
        setLoading(true);
        setError(null);
        const list = await window.api.listArticles();
        if (!cancelled) {
          setArticles(list);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load articles');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchArticles();
    return () => { cancelled = true; };
  }, []);

  // Fetch selected article content + backlinks
  const selectArticle = useCallback(async (title: string) => {
    setSelectedTitle(title);
    setArticleLoading(true);
    setArticleError(null);
    setArticle(null);
    setRenderedHtml('');
    setBacklinks([]);

    try {
      const [fetched, links] = await Promise.all([
        window.api.getArticle(title),
        window.api.getBacklinks(title),
      ]);
      setArticle(fetched);
      setRenderedHtml(markdownToHtml(fetched.content));
      setBacklinks(links);
    } catch (err) {
      setArticleError(err instanceof Error ? err.message : 'Failed to load article');
    } finally {
      setArticleLoading(false);
    }
  }, []);

  // Navigate to a backlinked article
  const handleBacklinkClick = useCallback((title: string) => {
    selectArticle(title);
  }, [selectArticle]);

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div className="article-browser">
      {/* LEFT: Article list */}
      <aside className="article-browser__list">
        <div className="article-browser__list-header">Articles</div>

        {loading && (
          <div className="article-browser__status">Loading articles…</div>
        )}

        {error && (
          <div className="article-browser__status article-browser__status--error">
            {error}
          </div>
        )}

        {!loading && !error && articles.length === 0 && (
          <div className="article-browser__status">No articles yet</div>
        )}

        {!loading && !error && articles.map((meta) => (
          <button
            key={meta.filename}
            className={`article-browser__list-item${selectedTitle === meta.title ? ' article-browser__list-item--active' : ''}`}
            onClick={() => selectArticle(meta.title)}
          >
            <span className="article-browser__list-title">{meta.title}</span>
            <span className="article-browser__list-excerpt">
              {meta.excerpt.length > 200 ? meta.excerpt.slice(0, 200) + '…' : meta.excerpt}
            </span>
            <span className="article-browser__list-date">{formatDate(meta.modified)}</span>
          </button>
        ))}
      </aside>

      {/* RIGHT: Article view */}
      <section className="article-browser__view">
        {!selectedTitle && (
          <div className="article-browser__empty">Select an article to view</div>
        )}

        {selectedTitle && articleLoading && (
          <div className="article-browser__status">Loading article…</div>
        )}

        {selectedTitle && articleError && (
          <div className="article-browser__status article-browser__status--error">
            {articleError}
          </div>
        )}

        {selectedTitle && article && !articleLoading && !articleError && (
          <>
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
                      role="button"
                      tabIndex={0}
                      onClick={() => console.log('Tag clicked:', tag)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          console.log('Tag clicked:', tag);
                        }
                      }}
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              )}

              <button
                className="article-view__edit-btn"
                onClick={() => editArticle(article.frontmatter.title)}
              >
                ✏️ Edit
              </button>
            </header>

            {/* Rendered markdown body */}
            <div
              className="article-view__content"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />

            {/* Backlinks */}
            {backlinks.length > 0 && (
              <section className="article-view__backlinks">
                <h3 className="article-view__backlinks-title">Backlinks</h3>
                <ul className="article-view__backlinks-list">
                  {backlinks.map((link) => (
                    <li key={link}>
                      <button
                        className="article-view__backlink"
                        onClick={() => handleBacklinkClick(link)}
                      >
                        {link}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </section>
    </div>
  );
};

export default ArticleBrowser;

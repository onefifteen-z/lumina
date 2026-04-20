import React, { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight, FolderOpen } from 'lucide-react';
import luminaMarkUrl from '../../../assets/icon.svg';

export interface WelcomeScreenProps {
  onVaultSelected: () => void;
}

type Slide = {
  title: string;
  items: React.ReactNode[];
};

const WELCOME_SLIDES: Slide[] = [
  {
    title: 'Create your vault',
    items: [
      <>
        Use <strong>Select vault folder</strong> to pick any directory (new or existing). That path becomes your vault
        root.
      </>,
      <>
        If <code className="welcome-slide__code">CLAUDE.md</code> is missing, the <strong>Initialize Vault</strong>{' '}
        dialog offers <code className="welcome-slide__code">CLAUDE.md</code>, <code className="welcome-slide__code">raw/</code>, and{' '}
        <code className="welcome-slide__code">wiki/</code>.
      </>,
      <>
        <strong>Skip</strong> only when you intend to create those entries yourself — otherwise ingest and wiki flows may
        be incomplete.
      </>,
    ],
  },
  {
    title: 'Settings',
    items: [
      <>
        Open <strong>Settings</strong> and configure your <strong>API endpoint</strong>, <strong>API key</strong>, and{' '}
        <strong>model</strong> (OpenAI-compatible). Chat and built-in tools need this.
      </>,
      <>
        <strong>Office / PDF extraction</strong> uses local <strong>Python</strong> plus <strong>markitdown</strong>. A
        virtualenv may be created under <code className="welcome-slide__code">~/.lumina/venv/</code> on first use — install
        Python 3 if prompted.
      </>,
      <>
        Optional <strong>PDF page images</strong> lets the model use vision-style paths for scanned or hard-to-parse PDFs
        (higher token use).
      </>,
    ],
  },
  {
    title: 'Add files to raw/',
    items: [
      <>
        Drop or copy files into <code className="welcome-slide__code">raw/</code> in Finder, Explorer, or your terminal.
        Sources are read into the wiki pipeline and are not rewritten in place by default.
      </>,
      <>
        Supported types include plain text, Markdown, JSON/HTML, Office formats, PDFs, and common images — the bundled{' '}
        <strong>INGEST</strong> protocol defines the full matrix.
      </>,
      <>
        Prefer names like <code className="welcome-slide__code">YYYY-MM-DD-short-description.ext</code> so sources stay
        easy to find and cite.
      </>,
    ],
  },
  {
    title: 'Ingest → build wiki',
    items: [
      <>
        In <strong>Chat</strong>, run e.g. <code className="welcome-slide__code">/ingest your-file.pdf</code> (paths are
        relative to the vault; files usually live under <code className="welcome-slide__code">raw/</code>). You can add a
        short instruction after the path.
      </>,
      <>
        The assistant follows <code className="welcome-slide__code">CLAUDE.md</code> plus the built-in <strong>INGEST</strong>{' '}
        protocol and calls the <strong>ingest_source</strong> tool — avoid asking the model to bypass that with ad-hoc pip
        installs for parsing.
      </>,
      <>
        If Office/PDF ingest fails: install <strong>python3</strong>, capture <strong>markitdown</strong> errors, or enable
        PDF images and retry with vision when text extraction is empty.
      </>,
      <>
        After a run, inspect <code className="welcome-slide__code">wiki/sources/</code>,{' '}
        <code className="welcome-slide__code">wiki/index.md</code>, and <code className="welcome-slide__code">wiki/log.md</code> — a
        single ingest often updates several files (expected).
      </>,
    ],
  },
  {
    title: 'Ask questions',
    items: [
      <>
        Use natural language in <strong>Chat</strong>. The query workflow reads <code className="welcome-slide__code">wiki/index.md</code>, opens related wiki pages, and answers with citations.
      </>,
      <>
        When it fits the task, Lumina may offer to persist structured answers under{' '}
        <code className="welcome-slide__code">wiki/analyses/</code> so insights compound over time.
      </>,
    ],
  },
  {
    title: 'Lint wiki',
    items: [
      <>
        Run <code className="welcome-slide__code">/lint</code> (optionally add focus text on the same line) for a vault-wide check guided by <code className="welcome-slide__code">CLAUDE.md</code>.
      </>,
      <>
        Typical checks: contradictory statements, stale pages superseded by newer sources, orphan pages, missing entity entries, weak cross-links, and terminology drift.
      </>,
      <>
        A complete lint often appends a line to <code className="welcome-slide__code">wiki/log.md</code> — review it after major ingests or on a schedule.
      </>,
    ],
  },
];

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onVaultSelected }) => {
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slideIndex, setSlideIndex] = useState(0);
  const total = WELCOME_SLIDES.length;

  const go = useCallback(
    (delta: number) => {
      setSlideIndex((i) => {
        const next = i + delta;
        if (next < 0) return total - 1;
        if (next >= total) return 0;
        return next;
      });
    },
    [total],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        go(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  const handleSelectVault = async () => {
    setSelecting(true);
    setError(null);
    try {
      const selectedPath = await window.api.selectVaultFolder();
      if (!selectedPath) {
        setSelecting(false);
        return;
      }
      await window.api.saveConfig({ vaultPath: selectedPath });
      await window.api.listArticles();
      onVaultSelected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set up vault folder.');
      setSelecting(false);
    }
  };

  return (
    <div className="welcome-screen">
      <div className="welcome-screen__glow welcome-screen__glow--a" aria-hidden="true" />
      <div className="welcome-screen__glow welcome-screen__glow--b" aria-hidden="true" />
      <div className="welcome-screen__grid" aria-hidden="true" />
      <div className="welcome-screen__shell">
        <div className="welcome-screen__card">
          <div className="welcome-screen__head">
            <img
              src={luminaMarkUrl}
              className="welcome-screen__logo welcome-screen__logo--compact"
              width={56}
              height={56}
              alt=""
              decoding="async"
            />
            <div className="welcome-screen__head-text">
              <p className="welcome-screen__eyebrow">Personal LLM wiki</p>
              <h1 className="welcome-screen__title welcome-screen__title--compact">Welcome to Lumina</h1>
            </div>
          </div>

          <div
            className="welcome-screen__carousel"
            role="region"
            aria-roledescription="carousel"
            aria-label="Getting started with Lumina"
          >
            <div className="welcome-screen__slide-stage" aria-live="polite">
              {WELCOME_SLIDES.map((s, i) => (
                <div
                  key={s.title}
                  id={`welcome-slide-${i}`}
                  aria-hidden={i !== slideIndex}
                  className={`welcome-slide ${i === slideIndex ? 'welcome-slide--active' : ''}`}
                >
                  <h2 className="welcome-slide__title">{s.title}</h2>
                  <ul className="welcome-slide__list">
                    {s.items.map((item, j) => (
                      <li key={j} className="welcome-slide__li">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="welcome-screen__carousel-nav">
              <button
                type="button"
                className="welcome-screen__nav-btn"
                onClick={() => go(-1)}
                aria-label="Previous slide"
              >
                <ChevronLeft size={20} strokeWidth={2} aria-hidden />
              </button>
              <div className="welcome-screen__dots" role="group" aria-label="Slides">
                {WELCOME_SLIDES.map((_, i) => (
                  <button
                    key={String(i)}
                    type="button"
                    className={`welcome-screen__dot ${i === slideIndex ? 'welcome-screen__dot--active' : ''}`}
                    onClick={() => setSlideIndex(i)}
                    aria-label={`Go to slide ${i + 1} of ${total}`}
                    aria-current={i === slideIndex ? 'step' : undefined}
                  />
                ))}
              </div>
              <button type="button" className="welcome-screen__nav-btn" onClick={() => go(1)} aria-label="Next slide">
                <ChevronRight size={20} strokeWidth={2} aria-hidden />
              </button>
            </div>
          </div>

          <p className="welcome-screen__hint">Use arrow keys ← → to move between tips.</p>

          <button type="button" className="welcome-screen__btn" onClick={handleSelectVault} disabled={selecting}>
            <FolderOpen className="welcome-screen__btn-icon" aria-hidden strokeWidth={2} />
            {selecting ? 'Setting up…' : 'Select vault folder'}
          </button>
          {error && (
            <p className="welcome-screen__error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

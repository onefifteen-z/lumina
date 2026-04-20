# GitHub Pages (this folder)

This directory is the **static site root** for the project’s GitHub Pages landing page.

**Download:** the landing page links to the McKinsey Box build (`Download` / `Download Lumina` buttons). Update that URL in `index.html` if the share link changes.

## Enable Pages

1. In the GitHub repository, go to **Settings → Pages** (under *Code and automation*).
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Select branch **`main`** and folder **`/docs`**, then save.
4. After the site builds, open:

   `https://<your-username-or-org>.github.io/<repository-name>/`

   For example, if the repo is `McK-Playground/prj-lumina`, the URL is:

   `https://mck-playground.github.io/prj-lumina/`

## Local preview

From the repository root:

```bash
npx --yes serve docs
```

Then open the URL printed in the terminal (paths use `./` so they work under a subpath on Pages).

## Files

- `guide.html` — **User guide** (vault → settings → raw → ingest → Q&A → `/lint`) in **EN / 中文 / 日本語** via the same `?lang=` + `locales/guide-*.json` mechanism as the landing page
- `index.html` — landing page (feature story + CSS “UI” mockups); links to `guide.html`
- `styles.css` — layout, motion, and scroll-reveal styles
- `main.js` — scroll progress bar, nav “scrolled” state, parallax on hero glow, `IntersectionObserver` for reveal-on-scroll (skipped when `prefers-reduced-motion: reduce`)
- `assets/icon.png` — app icon (copy of root `assets/icon.png` for Pages)
- `.nojekyll` — disables Jekyll so GitHub serves files as-is

(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var THEME_KEY = "lumina-docs-theme";

  function themeCopy() {
    var g = window.__LUMINA_DOC_I18N__;
    if (g && g.themeAriaLight) return g;
    return {
      themeAriaLight: "Light background on. Activate to use a dark background.",
      themeAriaDark: "Dark background on. Activate to use a light background.",
      themeTitleLight: "Switch to dark theme",
      themeTitleDark: "Switch to light theme",
    };
  }

  function persistTheme(theme) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {}
  }

  function applyTheme(theme) {
    var isDark = theme === "dark";
    var t = themeCopy();
    document.documentElement.setAttribute("data-site-theme", isDark ? "dark" : "light");
    var btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.setAttribute("aria-checked", isDark ? "true" : "false");
      btn.setAttribute("aria-label", isDark ? t.themeAriaDark : t.themeAriaLight);
      btn.title = isDark ? t.themeTitleDark : t.themeTitleLight;
    }
  }

  window.LuminaDocsApplyThemeAria = function () {
    var cur = document.documentElement.getAttribute("data-site-theme") === "dark" ? "dark" : "light";
    applyTheme(cur);
  };

  function initThemeToggle() {
    var btn = document.getElementById("theme-toggle");
    var current = document.documentElement.getAttribute("data-site-theme") === "dark" ? "dark" : "light";
    applyTheme(current);
    if (!btn) return;
    btn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-site-theme") === "dark" ? "light" : "dark";
      applyTheme(next);
      persistTheme(next);
    });
  }

  function initReveal() {
    if (reduceMotion) {
      document.querySelectorAll(".reveal").forEach(function (el) {
        el.classList.add("is-visible");
      });
      return;
    }
    var els = document.querySelectorAll(".reveal");
    if (!els.length || !("IntersectionObserver" in window)) {
      els.forEach(function (el) {
        el.classList.add("is-visible");
      });
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { root: null, rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    els.forEach(function (el) {
      io.observe(el);
    });
  }

  function initNav() {
    var nav = document.querySelector(".top-nav");
    if (!nav) return;
    function onScroll() {
      var y = window.scrollY || document.documentElement.scrollTop;
      nav.classList.toggle("top-nav--scrolled", y > 16);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  function initParallax() {
    if (reduceMotion) return;
    var layer = document.querySelector(".hero__glow");
    if (!layer) return;
    window.addEventListener(
      "scroll",
      function () {
        var y = window.scrollY || 0;
        layer.style.setProperty("--parallax", (y * 0.12).toFixed(1) + "px");
      },
      { passive: true },
    );
  }

  function initScrollProgress() {
    var bar = document.querySelector(".scroll-progress");
    if (!bar) return;
    if (reduceMotion) {
      bar.style.display = "none";
      return;
    }
    function tick() {
      var doc = document.documentElement;
      var max = doc.scrollHeight - window.innerHeight;
      var p = max > 0 ? window.scrollY / max : 0;
      bar.style.transform = "scaleX(" + Math.min(1, Math.max(0, p)) + ")";
    }
    window.addEventListener("scroll", tick, { passive: true });
    tick();
  }

  function boot() {
    initThemeToggle();
    initReveal();
    initNav();
    initParallax();
    initScrollProgress();
  }

  function start() {
    if (window.LuminaDocsI18n && typeof window.LuminaDocsI18n.init === "function") {
      window.LuminaDocsI18n.init(boot);
    } else {
      boot();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

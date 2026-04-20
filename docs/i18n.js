(function () {
  "use strict";

  var LANG_KEY = "lumina-docs-lang";
  var BASE = "./locales/";
  /** @type {string} e.g. "" for `en.json`, or "guide-" for `guide-en.json` */
  var localeFilePrefix = "";

  function normalizeLang(raw) {
    if (raw == null || raw === "") return null;
    var s = String(raw).toLowerCase().replace("_", "-");
    if (s === "zh" || s.startsWith("zh-")) return "zh";
    if (s === "ja" || s.startsWith("ja-")) return "ja";
    if (s === "en" || s.startsWith("en-")) return "en";
    return null;
  }

  function resolveLang() {
    var q = normalizeLang(new URLSearchParams(window.location.search).get("lang"));
    if (q) return q;
    try {
      var stored = normalizeLang(window.localStorage.getItem(LANG_KEY));
      if (stored) return stored;
    } catch (e) {}
    return "en";
  }

  function setStoredLang(lang) {
    try {
      if (lang === "en") window.localStorage.removeItem(LANG_KEY);
      else window.localStorage.setItem(LANG_KEY, lang);
    } catch (e) {}
  }

  function syncUrlLang(lang) {
    try {
      var url = new URL(window.location.href);
      if (lang === "en") url.searchParams.delete("lang");
      else url.searchParams.set("lang", lang);
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    } catch (e) {}
  }

  function localeFilename(lang) {
    return localeFilePrefix + lang + ".json";
  }

  function applyMeta(data) {
    var meta = data && data._meta;
    if (!meta) return;
    if (meta.htmlLang) document.documentElement.setAttribute("lang", meta.htmlLang);
    if (meta.title) document.title = meta.title;
    if (meta.description) {
      var m = document.querySelector('meta[name="description"]');
      if (m) m.setAttribute("content", meta.description);
    }
  }

  function applyDom(data) {
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var k = el.getAttribute("data-i18n");
      if (!k || !Object.prototype.hasOwnProperty.call(data, k)) return;
      el.textContent = data[k];
    });
    document.querySelectorAll("[data-i18n-html]").forEach(function (el) {
      var k = el.getAttribute("data-i18n-html");
      if (!k || !Object.prototype.hasOwnProperty.call(data, k)) return;
      el.innerHTML = data[k];
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach(function (el) {
      var k = el.getAttribute("data-i18n-aria-label");
      if (!k || !Object.prototype.hasOwnProperty.call(data, k)) return;
      el.setAttribute("aria-label", data[k]);
    });
    document.querySelectorAll("[data-i18n-title]").forEach(function (el) {
      var k = el.getAttribute("data-i18n-title");
      if (!k || !Object.prototype.hasOwnProperty.call(data, k)) return;
      el.setAttribute("title", data[k]);
    });
  }

  function setLangActive(lang) {
    document.querySelectorAll("[data-set-lang]").forEach(function (btn) {
      var l = btn.getAttribute("data-set-lang");
      btn.classList.toggle("lang-switch__btn--active", l === lang);
      btn.setAttribute("aria-pressed", l === lang ? "true" : "false");
    });
  }

  function exposeForMain(data) {
    window.__LUMINA_DOC_I18N__ = {
      themeAriaLight: data.themeAriaLight,
      themeAriaDark: data.themeAriaDark,
      themeTitleLight: data.themeTitleLight,
      themeTitleDark: data.themeTitleDark,
    };
  }

  function applyLocale(lang, data) {
    window.__LUMINA_DOC_LANG__ = lang;
    applyMeta(data);
    applyDom(data);
    exposeForMain(data);
    setLangActive(lang);
    try {
      window.dispatchEvent(new CustomEvent("lumina-docs-locale", { detail: { lang: lang } }));
    } catch (e) {}
  }

  function loadLocale(lang, cb) {
    fetch(BASE + localeFilename(lang))
      .then(function (r) {
        if (!r.ok) throw new Error(lang);
        return r.json();
      })
      .then(function (data) {
        cb(null, data);
      })
      .catch(function () {
        if (lang === "en") {
          cb(new Error("en"));
          return;
        }
        fetch(BASE + localeFilename("en"))
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            cb(null, data);
          })
          .catch(function () {
            cb(new Error("fallback"));
          });
      });
  }

  function initLangSwitch() {
    var wrap = document.querySelector(".lang-switch");
    if (!wrap || wrap.getAttribute("data-i18n-bound") === "1") return;
    wrap.setAttribute("data-i18n-bound", "1");
    wrap.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-set-lang]");
      if (!btn || !wrap.contains(btn)) return;
      var next = btn.getAttribute("data-set-lang");
      if (!next || next === window.__LUMINA_DOC_LANG__) return;
      setStoredLang(next);
      syncUrlLang(next);
      loadLocale(next, function (err, data) {
        if (!err && data) applyLocale(next, data);
        if (typeof window.LuminaDocsApplyThemeAria === "function") {
          window.LuminaDocsApplyThemeAria();
        }
      });
    });
  }

  window.LuminaDocsI18n = {
    resolveLang: resolveLang,
    /**
     * @param {function(): void} [cb]
     * @param {{ localeFilePrefix?: string }} [opts] Pass `{ localeFilePrefix: "guide-" }` on guide.html
     */
    init: function (cb, opts) {
      opts = opts || {};
      localeFilePrefix = typeof opts.localeFilePrefix === "string" ? opts.localeFilePrefix : "";
      var lang = resolveLang();
      window.__LUMINA_DOC_LANG__ = lang;
      loadLocale(lang, function (err, data) {
        if (!err && data) {
          applyLocale(lang, data);
        } else {
          setLangActive(lang);
        }
        initLangSwitch();
        if (cb) cb();
      });
    },
    getLang: function () {
      return window.__LUMINA_DOC_LANG__ || resolveLang();
    },
  };
})();

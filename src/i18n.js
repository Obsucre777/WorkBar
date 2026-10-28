/* Shared UI translations. The native app is the authority for language choice. */
(() => {
  "use strict";
  const invoke = window.__TAURI__?.core.invoke;
  const listen = window.__TAURI__?.event.listen;
  let messages = {};
  let locale = "en";
  let revision = 0;
  const t = (key, values = {}) => (messages[key] ?? key).replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : match);

  function translatePage() {
    document.documentElement.lang = locale;
    for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
    for (const attr of ["title", "aria-label"]) {
      for (const node of document.querySelectorAll(`[data-i18n-${attr}]`)) {
        node.setAttribute(attr, t(node.getAttribute(`data-i18n-${attr}`)));
      }
    }
  }
  function apply(info) {
    if (!info || !["zh-CN", "en"].includes(info.locale) || !info.messages) return;
    locale = info.locale;
    messages = info.messages;
    translatePage();
    window.dispatchEvent(new Event("workbar-language-changed"));
  }
  async function initialize() {
    if (listen && invoke) {
      await listen("language-changed", event => { ++revision; apply(event.payload); });
      const generation = revision;
      const info = await invoke("get_language");
      if (revision === generation) apply(info);
    } else {
      const language = /^zh(?:-|$)/i.test(navigator.language) ? "zh-CN" : "en";
      const response = await fetch(`locales/${language}.json`);
      if (!response.ok) throw new Error("Could not load UI translations");
      apply({ locale: language, messages: await response.json() });
    }
  }
  window.WorkbarI18n = {
    t,
    error(error) {
      if (!error?.key) return String(error);
      return t(error.key) + (error.detail ? ` (${error.detail})` : "");
    },
    get locale() { return locale; },
    ready: initialize(),
  };
})();

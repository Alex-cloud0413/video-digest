const YTD_OPTIONS = (() => {
  const LANGUAGE_STORAGE_KEY = "ytd_options_language";
  const SUPPORTED_LANGUAGES = new Set(["en", "zh-CN", "de"]);

  const COPY = {
    en: {
      pageTitle: "Video Digest",
      languageGroupLabel: "Interface language",
      heading: "Connected to your local Codex",
      lede:
        "This local-first edition needs no Supadata, DeepSeek, or OpenAI API key.",
      transcriptHeading: "Transcript source",
      transcriptProvider: "YouTube + Bilibili subtitles",
      noKeyBadge: "No key required",
      transcriptHelp:
        "The extension reads subtitle tracks already exposed by the active YouTube or Bilibili player. It does not transcribe audio.",
      aiHeading: "AI provider",
      aiProvider: "Codex through your ChatGPT sign-in",
      subscriptionBadge: "Subscription access",
      aiHelp:
        "A loopback-only helper sends requested transcript text to the Codex CLI signed in on this computer.",
      privacyNote:
        "Requests use your Codex subscription limits. The helper accepts authenticated calls only from local Chrome extensions.",
      checkConnection: "Check local connection",
      checking: "Checking...",
      connected: "Connected. Codex features are ready.",
      disconnected:
        "The local helper is offline. Reload the extension after restarting the helper.",
      localData: "Local data",
      localDataHelp:
        "Digests, translations, and notes are stored in this Chrome profile and can be removed at any time.",
      clearCache: "Clear cached digests",
      deleteNotes: "Delete all notes",
      resetData: "Reset extension data",
      clearedDigests: ({ count }) =>
        `Cleared ${count} cached digest${count === 1 ? "" : "s"}.`,
      notesDeleted: "Deleted all saved notes.",
      resetConfirm: "Delete all cached digests, translations, and saved notes?",
      allDataDeleted: "All Video Digest data was deleted.",
      actionFailed: "The action failed. Please try again.",
      footer:
        "Video Digest is an open-source local edition based on YouTube Digest and powered by Codex.",
    },
    "zh-CN": {
      pageTitle: "Video Digest",
      languageGroupLabel: "界面语言",
      heading: "已连接到本机 Codex",
      lede: "这个本地优先版本不需要 Supadata、DeepSeek 或 OpenAI API Key。",
      transcriptHeading: "字幕来源",
      transcriptProvider: "YouTube + 哔哩哔哩页面字幕",
      noKeyBadge: "无需密钥",
      transcriptHelp:
        "扩展直接读取当前 YouTube 或哔哩哔哩播放器已经提供的字幕轨道，不会转录视频音频。",
      aiHeading: "AI 服务",
      aiProvider: "通过 ChatGPT 登录使用 Codex",
      subscriptionBadge: "使用订阅额度",
      aiHelp:
        "仅监听本机的连接程序会把当前请求所需的字幕文本交给这台电脑上已经登录的 Codex CLI。",
      privacyNote:
        "请求会占用 Codex 订阅额度。连接程序只接受来自本机 Chrome 扩展且带安装凭据的调用。",
      checkConnection: "检查本机连接",
      checking: "正在检查……",
      connected: "连接正常，Codex 功能已经可用。",
      disconnected: "本机连接程序未运行。重新启动连接程序后，请重新加载扩展。",
      localData: "本地数据",
      localDataHelp:
        "概览、翻译和笔记保存在当前 Chrome 个人资料中，可以随时删除。",
      clearCache: "清除概览缓存",
      deleteNotes: "删除全部笔记",
      resetData: "重置扩展数据",
      clearedDigests: ({ count }) => `已清除 ${count} 个视频缓存。`,
      notesDeleted: "已删除全部笔记。",
      resetConfirm: "删除全部缓存、翻译和笔记吗？",
      allDataDeleted: "已删除全部 Video Digest 数据。",
      actionFailed: "操作失败，请重试。",
      footer: "Video Digest 是基于 YouTube Digest、由 Codex 驱动的开源本地版本。",
    },
    de: {
      pageTitle: "Video Digest",
      languageGroupLabel: "Oberflächensprache",
      heading: "Mit lokalem Codex verbunden",
      lede:
        "Diese lokal ausgerichtete Version benötigt keinen Supadata-, DeepSeek- oder OpenAI-API-Schlüssel.",
      transcriptHeading: "Transkriptquelle",
      transcriptProvider: "YouTube- und Bilibili-Untertitel",
      noKeyBadge: "Kein Schlüssel erforderlich",
      transcriptHelp:
        "Die Erweiterung liest Untertitelspuren, die der aktive YouTube- oder Bilibili-Player bereits bereitstellt. Audio wird nicht transkribiert.",
      aiHeading: "KI-Anbieter",
      aiProvider: "Codex über deine ChatGPT-Anmeldung",
      subscriptionBadge: "Abonnementzugang",
      aiHelp:
        "Ein nur lokal erreichbarer Helfer sendet den benötigten Transkripttext an die auf diesem Computer angemeldete Codex CLI.",
      privacyNote:
        "Anfragen werden auf deine Codex-Abonnementlimits angerechnet. Der Helfer akzeptiert nur authentifizierte Aufrufe lokaler Chrome-Erweiterungen.",
      checkConnection: "Lokale Verbindung prüfen",
      checking: "Wird geprüft …",
      connected: "Verbunden. Codex-Funktionen sind bereit.",
      disconnected:
        "Der lokale Helfer ist offline. Starte ihn neu und lade anschließend die Erweiterung neu.",
      localData: "Lokale Daten",
      localDataHelp:
        "Digests, Übersetzungen und Notizen werden in diesem Chrome-Profil gespeichert und können jederzeit gelöscht werden.",
      clearCache: "Digest-Cache leeren",
      deleteNotes: "Alle Notizen löschen",
      resetData: "Erweiterungsdaten zurücksetzen",
      clearedDigests: ({ count }) =>
        `${count} zwischengespeicherte${count === 1 ? "n Digest" : " Digests"} gelöscht.`,
      notesDeleted: "Alle gespeicherten Notizen wurden gelöscht.",
      resetConfirm: "Alle Digests, Übersetzungen und gespeicherten Notizen löschen?",
      allDataDeleted: "Alle Video-Digest-Daten wurden gelöscht.",
      actionFailed: "Die Aktion ist fehlgeschlagen. Bitte erneut versuchen.",
      footer:
        "Video Digest ist eine lokale Open-Source-Version auf Basis von YouTube Digest und wird von Codex unterstützt.",
    },
  };

  let language = "en";

  function normalizeLanguage(value) {
    return SUPPORTED_LANGUAGES.has(value) ? value : "en";
  }

  function translate(targetLanguage, key, variables = {}) {
    const normalized = normalizeLanguage(targetLanguage);
    const value = COPY[normalized]?.[key] ?? COPY.en[key] ?? key;
    return typeof value === "function" ? value(variables) : value;
  }

  function copy(key, variables = {}) {
    return translate(language, key, variables);
  }

  function applyLanguage(nextLanguage) {
    language = normalizeLanguage(nextLanguage);
    document.documentElement.lang = language;
    document.title = copy("pageTitle");
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      element.textContent = copy(element.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-html]").forEach((element) => {
      element.textContent = copy(element.dataset.i18nHtml);
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
      element.setAttribute("aria-label", copy(element.dataset.i18nAriaLabel));
    });
    document.querySelectorAll(".language-option").forEach((button) => {
      const active = button.dataset.language === language;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  async function checkConnection() {
    const status = document.getElementById("connectionStatus");
    const button = document.getElementById("checkConnectionBtn");
    button.disabled = true;
    status.textContent = copy("checking");
    try {
      const result = await chrome.runtime.sendMessage({ action: "checkConfig" });
      status.textContent = result?.bridgeOnline
        ? copy("connected")
        : copy("disconnected");
      status.dataset.state = result?.bridgeOnline ? "success" : "error";
    } catch {
      status.textContent = copy("disconnected");
      status.dataset.state = "error";
    } finally {
      button.disabled = false;
    }
  }

  async function clearCachedDigests() {
    const status = document.getElementById("dataStatus");
    try {
      const stored = await chrome.storage.local.get(null);
      const keys = Object.keys(stored).filter(
        (key) => key.startsWith("digest_") || key.startsWith("youtubeDigestPreview:"),
      );
      if (keys.length) await chrome.storage.local.remove(keys);
      status.textContent = copy("clearedDigests", { count: keys.length });
    } catch {
      status.textContent = copy("actionFailed");
    }
  }

  async function deleteNotes() {
    const status = document.getElementById("dataStatus");
    try {
      await chrome.storage.local.remove("ytd_notes");
      status.textContent = copy("notesDeleted");
    } catch {
      status.textContent = copy("actionFailed");
    }
  }

  async function resetData() {
    const status = document.getElementById("dataStatus");
    if (!globalThis.confirm(copy("resetConfirm"))) return;
    try {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: language });
      status.textContent = copy("allDataDeleted");
    } catch {
      status.textContent = copy("actionFailed");
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", async () => {
      const stored = await chrome.storage.local
        .get(LANGUAGE_STORAGE_KEY)
        .catch(() => ({}));
      applyLanguage(stored[LANGUAGE_STORAGE_KEY] || "en");

      document.querySelectorAll(".language-option").forEach((button) => {
        button.addEventListener("click", async () => {
          applyLanguage(button.dataset.language);
          await chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: language });
          await checkConnection();
        });
      });
      document
        .getElementById("checkConnectionBtn")
        .addEventListener("click", checkConnection);
      document
        .getElementById("clearCacheBtn")
        .addEventListener("click", clearCachedDigests);
      document
        .getElementById("clearNotesBtn")
        .addEventListener("click", deleteNotes);
      document
        .getElementById("resetBtn")
        .addEventListener("click", resetData);
      await checkConnection();
    });
  }

  return {
    COPY,
    LANGUAGE_STORAGE_KEY,
    normalizeLanguage,
    translate,
    applyLanguage,
    copy,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_OPTIONS;
}

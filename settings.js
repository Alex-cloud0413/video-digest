/**
 * Shared, non-secret configuration helpers.
 *
 * API keys are stored in chrome.storage.local by options.js. This file contains
 * defaults and validation only, so it is safe to publish.
 */
var YTD_SETTINGS = (() => {
  const STORAGE_KEY = "ytd_settings";
  const DEFAULTS = Object.freeze({
    provider: "deepseek",
    aiApiKey: "",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    supadataApiKey: "",
  });

  function normalize(input = {}) {
    const provider = input.provider === "custom" ? "custom" : "deepseek";
    const normalized = {
      provider,
      aiApiKey:
        typeof input.aiApiKey === "string" ? input.aiApiKey.trim() : "",
      aiBaseUrl:
        typeof input.aiBaseUrl === "string" ? input.aiBaseUrl.trim() : "",
      aiModel: typeof input.aiModel === "string" ? input.aiModel.trim() : "",
      supadataApiKey:
        typeof input.supadataApiKey === "string"
          ? input.supadataApiKey.trim()
          : "",
    };

    if (provider === "deepseek") {
      normalized.aiBaseUrl = DEFAULTS.aiBaseUrl;
      normalized.aiModel = DEFAULTS.aiModel;
    }

    return normalized;
  }

  function chatCompletionsUrl(baseUrl) {
    const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!trimmed) throw new Error("AI provider base URL is required.");

    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(
        "AI provider base URL cannot contain credentials, query parameters, or a fragment.",
      );
    }
    const isLocal =
      parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
      throw new Error(
        "Use HTTPS for remote AI providers. HTTP is allowed only for localhost.",
      );
    }

    if (parsed.pathname.endsWith("/chat/completions")) return parsed.toString();
    return `${trimmed}/chat/completions`;
  }

  function permissionPattern(baseUrl) {
    const endpoint = new URL(chatCompletionsUrl(baseUrl));
    return `${endpoint.origin}/*`;
  }

  function canonicalYouTubeUrl(videoId) {
    const normalized = String(videoId || "").trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(normalized)) {
      throw new Error("Invalid YouTube video ID.");
    }
    return `https://www.youtube.com/watch?v=${normalized}`;
  }

  return {
    STORAGE_KEY,
    DEFAULTS,
    normalize,
    chatCompletionsUrl,
    permissionPattern,
    canonicalYouTubeUrl,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}

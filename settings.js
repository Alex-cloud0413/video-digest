/**
 * Shared, non-secret configuration helpers for the personal Codex-local fork.
 *
 * The bridge address and installation capability token are generated in
 * bridge-config.js. No Supadata, DeepSeek, or OpenAI API key is used.
 */
var YTD_SETTINGS = (() => {
  const STORAGE_KEY = "ytd_settings";
  const DEFAULTS = Object.freeze({
    provider: "codex-local",
    aiBaseUrl: "http://127.0.0.1:43110",
    aiModel: "chatgpt-subscription",
  });

  function normalize() {
    return { ...DEFAULTS };
  }

  function bridgeCompletionUrl() {
    return `${DEFAULTS.aiBaseUrl}/v1/complete`;
  }

  function bridgeHealthUrl() {
    return `${DEFAULTS.aiBaseUrl}/health`;
  }

  function canonicalYouTubeUrl(videoId) {
    const normalized = String(videoId || "").trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(normalized)) {
      throw new Error("Invalid YouTube video ID.");
    }
    return `https://www.youtube.com/watch?v=${normalized}`;
  }

  function canonicalVideoUrl(platform, videoId, pageNumber = 1) {
    if (globalThis.YTD_PLATFORMS) {
      return globalThis.YTD_PLATFORMS.canonicalVideoUrl(
        platform,
        videoId,
        pageNumber,
      );
    }
    if (platform !== "youtube") throw new Error("Unsupported video platform.");
    return canonicalYouTubeUrl(videoId);
  }

  return {
    STORAGE_KEY,
    DEFAULTS,
    normalize,
    bridgeCompletionUrl,
    bridgeHealthUrl,
    canonicalVideoUrl,
    canonicalYouTubeUrl,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}

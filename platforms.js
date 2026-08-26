(function initializePlatforms(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.YTD_PLATFORMS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  const PLATFORM_YOUTUBE = "youtube";
  const PLATFORM_BILIBILI = "bilibili";

  function cleanVideoId(platform, value) {
    const videoId = String(value || "").trim();
    const valid =
      platform === PLATFORM_YOUTUBE
        ? /^[A-Za-z0-9_-]{6,20}$/.test(videoId)
        : platform === PLATFORM_BILIBILI
          ? /^BV[A-Za-z0-9]{10,18}$/.test(videoId)
          : false;
    if (!valid) throw new Error(`Invalid ${platform || "video"} video ID.`);
    return videoId;
  }

  function cleanPageNumber(value) {
    const pageNumber = Math.floor(Number(value) || 1);
    return Math.min(10_000, Math.max(1, pageNumber));
  }

  function detectVideoSource(input) {
    try {
      const url = new URL(String(input || ""));
      const host = url.hostname.toLowerCase();
      if (host === "www.youtube.com" && url.pathname === "/watch") {
        const videoId = cleanVideoId(PLATFORM_YOUTUBE, url.searchParams.get("v"));
        return {
          platform: PLATFORM_YOUTUBE,
          videoId,
          pageNumber: 1,
          contentKey: `${PLATFORM_YOUTUBE}:${videoId}`,
        };
      }
      if (host === "youtu.be") {
        const videoId = cleanVideoId(PLATFORM_YOUTUBE, url.pathname.split("/")[1]);
        return {
          platform: PLATFORM_YOUTUBE,
          videoId,
          pageNumber: 1,
          contentKey: `${PLATFORM_YOUTUBE}:${videoId}`,
        };
      }
      if (host === "www.bilibili.com") {
        const match = url.pathname.match(/^\/video\/(BV[A-Za-z0-9]{10,18})(?:\/|$)/i);
        if (match) {
          const videoId = cleanVideoId(PLATFORM_BILIBILI, match[1]);
          const pageNumber = cleanPageNumber(url.searchParams.get("p"));
          return {
            platform: PLATFORM_BILIBILI,
            videoId,
            pageNumber,
            contentKey: `${PLATFORM_BILIBILI}:${videoId}:p${pageNumber}`,
          };
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  function canonicalVideoUrl(platform, videoId, pageNumber = 1) {
    const safeVideoId = cleanVideoId(platform, videoId);
    if (platform === PLATFORM_YOUTUBE) {
      return `https://www.youtube.com/watch?v=${safeVideoId}`;
    }
    const page = cleanPageNumber(pageNumber);
    const url = new URL(`https://www.bilibili.com/video/${safeVideoId}/`);
    if (page > 1) url.searchParams.set("p", String(page));
    return url.toString();
  }

  function timestampedVideoUrl(platform, videoId, seconds, pageNumber = 1) {
    const url = new URL(canonicalVideoUrl(platform, videoId, pageNumber));
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    url.searchParams.set("t", platform === PLATFORM_YOUTUBE ? `${safeSeconds}s` : String(safeSeconds));
    return url.toString();
  }

  function storageKey(platform, videoId, pageNumber = 1) {
    const safeVideoId = cleanVideoId(platform, videoId);
    const page = cleanPageNumber(pageNumber);
    return platform === PLATFORM_YOUTUBE
      ? `${PLATFORM_YOUTUBE}_${safeVideoId}`
      : `${PLATFORM_BILIBILI}_${safeVideoId}_p${page}`;
  }

  function isSupportedVideoUrl(url) {
    return Boolean(detectVideoSource(url));
  }

  return {
    PLATFORM_BILIBILI,
    PLATFORM_YOUTUBE,
    canonicalVideoUrl,
    cleanPageNumber,
    cleanVideoId,
    detectVideoSource,
    isSupportedVideoUrl,
    storageKey,
    timestampedVideoUrl,
  };
});

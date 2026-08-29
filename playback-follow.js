(function initPlaybackFollow(root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.YTD_PLAYBACK_FOLLOW = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  /**
   * Returns the last transcript row whose start time is not after playback.
   * Rows must be ordered by start time. A result of -1 means playback is still
   * before the first row.
   */
  function findActiveEntryIndex(startTimes, currentSeconds) {
    if (!Array.isArray(startTimes) || startTimes.length === 0) return -1;

    const time = Number(currentSeconds);
    if (!Number.isFinite(time)) return -1;

    let low = 0;
    let high = startTimes.length - 1;
    let activeIndex = -1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const start = Number(startTimes[middle]);
      if (!Number.isFinite(start)) return -1;

      if (start <= time) {
        activeIndex = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    return activeIndex;
  }

  /**
   * Keeps the active row inside a comfortable central band. This avoids
   * constant micro-scrolling while still bringing a row back when layout or
   * font changes move it out of view.
   */
  function isEntryInFollowZone(metrics, marginRatio = 0.2) {
    const containerTop = finiteNumber(metrics?.containerTop);
    const containerHeight = Math.max(0, finiteNumber(metrics?.containerHeight));
    const entryTop = finiteNumber(metrics?.entryTop);
    const entryBottom = finiteNumber(metrics?.entryBottom, entryTop);
    const safeRatio = Math.min(0.45, Math.max(0, finiteNumber(marginRatio, 0.2)));
    const zoneTop = containerTop + containerHeight * safeRatio;
    const zoneBottom = containerTop + containerHeight * (1 - safeRatio);

    return entryTop >= zoneTop && entryBottom <= zoneBottom;
  }

  /**
   * Calculates a container-local scrollTop that centers the active row and
   * clamps it to the actual scroll range.
   */
  function getCenteredScrollTop(metrics) {
    const scrollTop = finiteNumber(metrics?.scrollTop);
    const containerTop = finiteNumber(metrics?.containerTop);
    const containerHeight = Math.max(0, finiteNumber(metrics?.containerHeight));
    const entryTop = finiteNumber(metrics?.entryTop);
    const entryHeight = Math.max(0, finiteNumber(metrics?.entryHeight));
    const scrollHeight = Math.max(containerHeight, finiteNumber(metrics?.scrollHeight));
    const maxScrollTop = Math.max(0, scrollHeight - containerHeight);
    const target =
      scrollTop +
      (entryTop - containerTop) -
      (containerHeight - entryHeight) / 2;

    return Math.min(maxScrollTop, Math.max(0, target));
  }

  return Object.freeze({
    findActiveEntryIndex,
    getCenteredScrollTop,
    isEntryInFollowZone,
  });
});

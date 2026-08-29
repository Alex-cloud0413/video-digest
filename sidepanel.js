/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for Video Digest: video detection, transcript analysis,
 * rendering results, and export features.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// STATE
// ============================================================

let currentVideoId = null;
let currentVideoUrl = null;
let currentPlatform = "youtube";
let currentPageNumber = 1;
let currentContentKey = null;
let currentAnalysis = null;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptTimestamped = null; // With timestamps for AI analysis
let currentTranscriptLanguage = null;
let currentVideoTitle = "";
let currentChannelName = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let isAnalysisLoading = false; // Track if analysis is in progress
let videoTabId = null; // Store the active supported-video tab ID
let errorAction = null;
let errorLocalization = null;
let learningDraftSaveTimer = null;
let tabCheckGeneration = 0;
let digestGeneration = 0;
const DIGEST_CACHE_SCHEMA_VERSION = 3;
let currentInterfaceLanguage = "en";

function t(key, variables = {}) {
  return globalThis.VIDEO_DIGEST_I18N?.translate(
    currentInterfaceLanguage,
    key,
    variables,
  ) || key;
}

function updateLanguageButton() {
  const i18n = globalThis.VIDEO_DIGEST_I18N;
  const button = document.getElementById("languageBtn");
  const label = document.getElementById("languageBtnLabel");
  if (!i18n || !button || !label) return;
  const languageNames = { en: "English", "zh-CN": "中文", de: "Deutsch" };
  label.textContent = i18n.LANGUAGE_BADGES[currentInterfaceLanguage] || "EN";
  const description = t("switchLanguage", {
    language: languageNames[currentInterfaceLanguage] || "English",
  });
  button.title = description;
  button.setAttribute("aria-label", description);
}

function refreshLocalizedDynamicUi() {
  if (document.getElementById("errorState")?.style.display !== "none") {
    renderLocalizedError();
  }
  if (currentTranscript) {
    if (currentTranscriptMode === "original") renderTranscript();
    else translateTranscript();
    setupExplainFeature();
  }
  if (currentAnalysis) renderAnalysisResults(currentAnalysis);
  if (document.querySelector('[data-panel="notes"]')?.classList.contains("active")) {
    const showAll = document
      .getElementById("notesFilterAll")
      ?.classList.contains("active");
    loadNotes(showAll ? null : currentVideoId);
  }
}

async function setInterfaceLanguage(nextLanguage, { persist = true, refresh = true } = {}) {
  const i18n = globalThis.VIDEO_DIGEST_I18N;
  if (!i18n) return;
  currentInterfaceLanguage = i18n.applyDocument(nextLanguage, document);
  updateLanguageButton();
  if (persist) {
    await chrome.storage.local.set({
      [i18n.STORAGE_KEY]: currentInterfaceLanguage,
    });
  }
  if (refresh) refreshLocalizedDynamicUi();
}

async function initializeInterfaceLanguage() {
  const i18n = globalThis.VIDEO_DIGEST_I18N;
  if (!i18n) return;
  const stored = await chrome.storage.local.get(i18n.STORAGE_KEY).catch(() => ({}));
  await setInterfaceLanguage(stored[i18n.STORAGE_KEY] || "en", {
    persist: false,
    refresh: false,
  });
  document.getElementById("languageBtn")?.addEventListener("click", async () => {
    const languages = i18n.SUPPORTED_LANGUAGES;
    const index = languages.indexOf(currentInterfaceLanguage);
    await setInterfaceLanguage(languages[(index + 1) % languages.length]);
  });
}

// --- Translation state ---
// The public transcript control intentionally supports only the original
// subtitles, Chinese, and an aligned source + Chinese view.
let currentTranscriptMode = "original";
let translationGeneration = 0; // Invalidates responses from older UI modes/videos.
let translationWorkCount = 0;
let transcriptScrollObserver = null;
// Stable keys include the video, source mode, language, and semantic segment ID.
let transcriptParagraphCache = new Map();
const TRANSLATION_MESSAGE_TIMEOUT_MS = 190_000;

/**
 * Prevent a stopped service worker or dead message channel from leaving the
 * transcript queue stuck forever. The underlying Chrome message cannot be
 * cancelled, so settled guards deliberately ignore any late response.
 */
function sendTranslationMessage(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(
          t("translationTimeout"),
        ),
      );
    }, TRANSLATION_MESSAGE_TIMEOUT_MS);

    let messagePromise;
    try {
      messagePromise = chrome.runtime.sendMessage(message);
    } catch (error) {
      finish(reject, error);
      return;
    }

    Promise.resolve(messagePromise).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

// --- Auto-scroll state (follow video playback in transcript) ---
let autoScrollEnabled = true; // True = scroll transcript to follow video playback
let autoScrollInterval = null; // setInterval ID for polling video time
let playbackTrackingGeneration = 0; // Invalidates replies from stopped/old trackers
let playbackTrackingRequestInFlight = false; // Avoid overlapping async polls

const PLAYBACK_FOLLOW_SCROLL_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
});

function normalizeCaptionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

/**
 * Splits a single oversized thought at the strongest nearby punctuation.
 * Word boundaries are the final safety valve for captions with no punctuation.
 */
function splitOversizedThought(text, maxChars) {
  const parts = [];
  let rest = normalizeCaptionText(text);

  while (rest.length > maxChars) {
    const windowText = rest.slice(0, maxChars + 1);
    const lowerBound = Math.floor(maxChars * 0.55);
    let cut = -1;

    for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + match[0].length;
      }
      if (cut > 0) break;
    }

    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

/**
 * Reconstructs complete sentences across raw caption boundaries. Each segment
 * keeps the timestamp of the first caption that contributed text. Character
 * and time limits prevent a malformed subtitle entry from becoming one giant
 * row while punctuation remains the preferred boundary.
 */
function groupTranscriptEntries(entries, limits = TRANSCRIPT_SEGMENT_LIMITS) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const pieces = [];
  entries.forEach((entry, entryIndex) => {
    const text = normalizeCaptionText(entry?.text);
    if (!text) return;
    const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0;
    const duration = Math.max(0, Number(entry.duration) || 0);
    const sentenceParts =
      text.match(/[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) ||
      [text];
    let consumedChars = 0;

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart);
      if (!cleanPart) return;
      const oversizedParts = splitOversizedThought(cleanPart, limits.maxChars);
      oversizedParts.forEach((part, partIndex) => {
        const ratio = text.length ? Math.min(1, consumedChars / text.length) : 0;
        pieces.push({
          text: part,
          start: start + duration * ratio,
          semanticEnd:
            /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
            oversizedParts.length > 1,
          clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
          sourceOrder: `${entryIndex}:${partIndex}`,
        });
        consumedChars += part.length + 1;
      });
    });
  });

  const grouped = [];
  let current = null;

  const flush = () => {
    if (!current || !current.text.trim()) return;
    const index = grouped.length;
    const text = normalizeCaptionText(current.text);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      text,
      texts: [text],
    });
    current = null;
  };

  pieces.forEach((piece) => {
    if (!current) current = { start: piece.start, text: "" };
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
    const elapsed = Math.max(0, piece.start - current.start);
    const comfortablySized = current.text.length >= limits.minChars;
    const reachedIdeal = current.text.length >= limits.idealChars;
    const atNaturalBoundary =
      piece.semanticEnd ||
      (piece.clauseEnd &&
        (reachedIdeal ||
          current.text.length >= limits.maxChars ||
          elapsed >= limits.maxSeconds));
    const reachedGuardrail =
      atNaturalBoundary &&
      (current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds);
    const reachedHardGuardrail =
      current.text.length >= Math.round(limits.maxChars * 1.2) ||
      elapsed >= limits.maxSeconds + 5;

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedGuardrail ||
      reachedHardGuardrail
    ) {
      flush();
    }
  });
  flush();

  return grouped;
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  await initializeInterfaceLanguage();
  setupEventListeners();
  await evictOldCacheEntries(20);

  const configStatus = await chrome.runtime.sendMessage({
    action: "checkConfig",
  });

  if (!configStatus.transcriptReady) {
    showConfigError(configStatus);
    return;
  }

  await checkCurrentTab();
});

// Listen for messages from the Digest button on YouTube page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startDigestFromButton") {
    // Load the digest for the current video. Served from cache when we've
    // seen this video before (no API calls); fetched fresh otherwise.
    // (This used to force-clear the cache on every click, which silently
    // burned a transcript credit + analysis tokens per click.)
    checkCurrentTab();
    sendResponse({ success: true });
  }
  if (message.action === "transcriptProgress") {
    // Background is telling us the transcript fetch status changed
    updateLoading(message.title, message.subtitle);
    sendResponse({ success: true });
  }
  if (message.action === "noteSaved") {
    // Refresh notes list when a new note is saved
    const filterAll = document
      .getElementById("notesFilterAll")
      ?.classList.contains("active");
    loadNotes(filterAll ? null : currentVideoId);
    sendResponse({ success: true });
  }
  return false;
});

// ============================================================
// FOLLOW THE ACTIVE TAB
// ============================================================
// The panel watches which tab is in front of it and reacts:
//   - Front tab is NOT YouTube  -> the panel closes itself (window.close()).
//     We do this OURSELVES rather than relying only on the background
//     script's per-tab enable/disable, because Chrome doesn't reliably
//     apply per-tab panel state to tabs spawned in unusual ways (e.g. a
//     link opened from another app) — which let the panel linger on
//     non-YouTube pages.
//   - Front tab IS YouTube but on a different video -> refresh the digest.
//     YouTube is a single-page app (clicking a video swaps content without
//     a reload), so we track URL changes; startDigest() caches per video,
//     making re-checks instant and free for already-digested videos.
//
// Everything is scoped to the window this panel lives in: tab switches in
// OTHER browser windows must not close this panel or hijack its content.

let navigationRefreshTimer = null;
let panelWindowId = null;
chrome.windows.getCurrent().then((w) => {
  panelWindowId = w.id;
});

function scheduleDigestRefresh() {
  // Small delay lets YouTube finish rendering the new video's title and
  // description before we read them. Also collapses rapid-fire URL events
  // into a single refresh.
  clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => {
    checkCurrentTab();
  }, 600);
}

function panelIsShowingResults() {
  const results = document.getElementById("resultsState");
  return results && results.style.display !== "none";
}

/**
 * Reacts to the URL now in front of the panel: close on non-YouTube,
 * refresh the digest when the video changed.
 */
function applyPlatformTheme(platform) {
  document.body.dataset.platform = platform === "bilibili" ? "bilibili" : "youtube";
}

function handleFrontTabUrl(url) {
  const source = YTD_PLATFORMS.detectVideoSource(url || "");
  if (!source) {
    window.close();
    return;
  }
  applyPlatformTheme(source.platform);
  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video).
  if (source.contentKey !== currentContentKey || !panelIsShowingResults()) {
    scheduleDigestRefresh();
  }
}

// Fires when a tab's URL changes — including YouTube's no-reload navigation.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab.active) return;
  if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
  handleFrontTabUrl(changeInfo.url);
});

// Fires when a different tab comes to the front — switching tabs, or a new
// tab being opened (including ones opened by clicking links in other apps).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (panelWindowId !== null && windowId !== panelWindowId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Brand-new tabs may not have committed their URL yet — fall back to
    // the pending one so we judge where the tab is actually going.
    handleFrontTabUrl(tab.url || tab.pendingUrl || "");
  } catch (e) {
    // Tab closed before we could read it — nothing to do.
  }
});

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Error retry
  document.getElementById("errorBtn").addEventListener("click", () => {
    if (errorAction) {
      errorAction();
      return;
    }
    if (currentVideoId) {
      startDigest(currentVideoId, currentVideoUrl);
    }
  });

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  // Transcript actions
  document
    .getElementById("copyTranscriptBtn")
    ?.addEventListener("click", copyTranscript);
  document
    .getElementById("exportTranscriptBtn")
    ?.addEventListener("click", exportTranscript);
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      handleTranscriptModeChange(button.dataset.transcriptMode);
    });
  });

  // Follow playback button — re-enables auto-scroll after user scrolled away
  document
    .getElementById("followPlaybackBtn")
    ?.addEventListener("click", () => {
      autoScrollEnabled = true;
      document.getElementById("followPlaybackBtn").style.display = "none";
      // Jump straight back to the line currently being spoken. We scroll
      // directly (not via playbackTrackingTick) because the tick skips
      // entries that are already highlighted — and the current line almost
      // always IS highlighted, which made this button appear to do nothing.
      if (!scrollToActiveEntry({ force: true })) {
        playbackTrackingTick(); // No highlight yet — let a tick establish one
      }
    });

  // Notes filter buttons
  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    setNotesFilter(false);
    loadNotes(currentVideoId);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    setNotesFilter(true);
    loadNotes(null); // Load all notes
  });

  document
    .getElementById("learningPackForm")
    ?.addEventListener("submit", sendLearningPackToCreatorWorkspace);
  document.querySelectorAll(".learning-field textarea").forEach((field) => {
    field.addEventListener("input", scheduleLearningPackDraftSave);
  });
}

function setNotesFilter(showAll) {
  const thisVideoButton = document.getElementById("notesFilterThis");
  const allNotesButton = document.getElementById("notesFilterAll");
  thisVideoButton?.classList.toggle("active", !showAll);
  thisVideoButton?.setAttribute("aria-pressed", String(!showAll));
  allNotesButton?.classList.toggle("active", showAll);
  allNotesButton?.setAttribute("aria-pressed", String(showAll));
}

// ============================================================
// VIDEO DETECTION
// ============================================================

async function checkCurrentTab() {
  const checkGeneration = ++tabCheckGeneration;
  try {
    let tab = null;

    // Strategy 1: Active tab in last focused window
    let tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (checkGeneration !== tabCheckGeneration) return;
    if (YTD_PLATFORMS.isSupportedVideoUrl(tabs[0]?.url || "")) {
      tab = tabs[0];
    }

    // Strategy 2: Any active YouTube tab
    if (!tab) {
      const activeTabs = await chrome.tabs.query({ active: true });
      if (checkGeneration !== tabCheckGeneration) return;
      tab = activeTabs.find((candidate) =>
        YTD_PLATFORMS.isSupportedVideoUrl(candidate.url || ""),
      ) || null;
    }

    // Strategy 3: Any YouTube tab (last resort)
    if (!tab) {
      const candidates = await Promise.all([
        chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
        chrome.tabs.query({ url: "https://www.bilibili.com/video/*" }),
      ]);
      if (checkGeneration !== tabCheckGeneration) return;
      tab = candidates.flat()[0] || null;
    }

    debugLog("[YouTube Digest Panel] Found tab:", tab?.id, tab?.url);

    if (!tab?.url) {
      showState("welcome");
      return;
    }

    // Store the tab ID for reliable messaging later
    videoTabId = tab.id;

    const source = YTD_PLATFORMS.detectVideoSource(tab.url);

    if (source) {
      currentPlatform = source.platform;
      currentPageNumber = source.pageNumber;
      applyPlatformTheme(currentPlatform);
      currentVideoUrl = tab.url;

      try {
        // Route through background script for reliable message passing
        const result = await chrome.runtime.sendMessage({
          action: "relayToContent",
          tabId: videoTabId,
          payload: { action: "getVideoInfo" },
        });
        if (checkGeneration !== tabCheckGeneration) return;
        debugLog("[YouTube Digest Panel] getVideoInfo result:", result);
        if (result.success && result.response) {
          currentVideoTitle = result.response.title || "";
          currentChannelName = result.response.channelName || "";
          currentVideoDescription = result.response.description || "";
          currentVideoDuration = result.response.duration || 0;
        }
      } catch (e) {
        console.error("[YouTube Digest Panel] getVideoInfo error:", e);
        currentVideoTitle = "";
        currentChannelName = "";
        currentVideoDescription = "";
        currentVideoDuration = 0;
      }

      await startDigest(source.videoId, tab.url, source);
    } else {
      showState("welcome");
    }
  } catch (error) {
    console.error("Tab check error:", error);
    showState("welcome");
  }
}

function extractVideoId(url) {
  return YTD_PLATFORMS.detectVideoSource(url)?.videoId || null;
}

function transcriptFailureLocalization(result = {}) {
  const keyByCode = {
    VIDEO_TAB_NOT_FOUND: "videoTabNotFound",
    SOURCE_MISMATCH: "sourceMismatchMessage",
    BILIBILI_LOGIN_REQUIRED: "bilibiliLoginRequired",
    NO_TRANSCRIPT: "noTranscriptAvailable",
    BILIBILI_METADATA_FAILED: "bilibiliMetadataFailed",
    BILIBILI_SUBTITLE_DOWNLOAD_FAILED: "bilibiliSubtitleDownloadFailed",
  };
  const key = keyByCode[result.error];
  return {
    messageKey: key || null,
    message: key ? t(key) : result.message || result.error || t("errorFallback"),
  };
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

async function startDigest(videoId, videoUrl, source = null) {
  const requestGeneration = ++digestGeneration;
  const detected = source || YTD_PLATFORMS.detectVideoSource(videoUrl);
  if (detected) {
    currentPlatform = detected.platform;
    currentPageNumber = detected.pageNumber;
    applyPlatformTheme(currentPlatform);
  }
  const nextContentKey = detected?.contentKey || `${currentPlatform}:${videoId}`;
  // Check if we already have this video loaded in memory
  if (nextContentKey === currentContentKey && currentAnalysis) {
    showState("results");
    return;
  }

  // Every video change invalidates observer work and in-flight translations.
  if (nextContentKey !== currentContentKey) {
    translationGeneration += 1;
    if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
    transcriptScrollObserver = null;
  }

  // Check cache for this video
  const cached = await loadFromCache(videoId);
  if (requestGeneration !== digestGeneration) return;
  if (cached) {
    debugLog("Loading from cache:", videoId);
    currentVideoId = videoId;
    currentContentKey = nextContentKey;
    currentVideoUrl = videoUrl;
    currentAnalysis = cached.analysis || null;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptTimestamped = cached.transcriptTimestamped;
    currentTranscriptLanguage = cached.transcriptLanguage || null;
    isAnalysisLoading = false;
    document
      .getElementById("creatorWorkspaceHandoffStatus")
      ?.setAttribute("hidden", "");
    loadLearningPackDraft(videoId);

    // Restore semantic-segment translations from persistent storage.
    if (cached.paragraphCache) {
      for (const [key, value] of Object.entries(cached.paragraphCache)) {
        transcriptParagraphCache.set(key, value);
      }
    }

    if (currentVideoTitle || currentChannelName) {
      const videoInfo = document.getElementById("videoInfo");
      document.getElementById("videoTitle").textContent = currentVideoTitle;
      document.getElementById("videoChannel").textContent = currentChannelName;
      videoInfo.style.display = "block";
    }

    // Always render transcript first
    renderTranscript();

    // Render analysis if we have it cached
    if (currentAnalysis) {
      renderAnalysisResults(currentAnalysis);
      highlightMomentsOnPage(currentAnalysis.keyMoments);
    }

    showState("results");
    document.getElementById("tabsNav").style.display = "flex";

    // Load notes for this video
    loadNotes(videoId);

    // Setup explain feature
    setupExplainFeature();
    if (currentTranscriptMode !== "original") translateTranscript();
    return;
  }

  currentVideoId = videoId;
  currentContentKey = nextContentKey;
  currentVideoUrl = videoUrl;
  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;
  isAnalysisLoading = false;
  document
    .getElementById("creatorWorkspaceHandoffStatus")
    ?.setAttribute("hidden", "");
  loadLearningPackDraft(videoId);

  if (currentVideoTitle || currentChannelName) {
    const videoInfo = document.getElementById("videoInfo");
    document.getElementById("videoTitle").textContent = currentVideoTitle;
    document.getElementById("videoChannel").textContent = currentChannelName;
    videoInfo.style.display = "block";
  }

  showState("loading");
  updateLoading(t("fetchingTranscript"), t("extractingCaptions"));

  const transcriptResult = await chrome.runtime.sendMessage({
    action: "fetchTranscript",
    platform: currentPlatform,
    videoId,
    pageNumber: currentPageNumber,
    tabId: videoTabId,
  });
  if (
    requestGeneration !== digestGeneration ||
    currentContentKey !== nextContentKey
  ) {
    return;
  }

  if (
    transcriptResult?.success &&
    transcriptResult.videoInfo?.contentKey !== nextContentKey
  ) {
    showError(
      t("sourceMismatchTitle"),
      t("sourceMismatchMessage"),
      {
        titleKey: "sourceMismatchTitle",
        messageKey: "sourceMismatchMessage",
        buttonKey: "tryAgain",
      },
    );
    return;
  }

  if (!transcriptResult.success) {
    const failure = transcriptFailureLocalization(transcriptResult);
    showError(t("noTranscriptTitle"), failure.message, {
      titleKey: "noTranscriptTitle",
      messageKey: failure.messageKey,
      fallbackMessage: failure.message,
      buttonKey: "tryAgain",
    });
    return;
  }

  currentTranscript = transcriptResult.transcript;
  currentTranscriptText = transcriptResult.transcriptText;
  currentTranscriptTimestamped = transcriptResult.transcriptTextTimestamped;
  currentTranscriptLanguage = transcriptResult.language || null;
  if (transcriptResult.videoInfo) {
    currentVideoTitle = transcriptResult.videoInfo.title || currentVideoTitle;
    currentChannelName = transcriptResult.videoInfo.channelName || currentChannelName;
    currentVideoDescription = transcriptResult.videoInfo.description || currentVideoDescription;
    currentVideoDuration = transcriptResult.videoInfo.duration || currentVideoDuration;
    document.getElementById("videoTitle").textContent = currentVideoTitle;
    document.getElementById("videoChannel").textContent = currentChannelName;
    document.getElementById("videoInfo").style.display = "block";
  }

  // Render transcript immediately (no LLM needed)
  renderTranscript();
  showState("results");
  document.getElementById("tabsNav").style.display = "flex";

  // Load notes for this video
  loadNotes(videoId);

  // Setup explain feature for text selection
  setupExplainFeature();
  if (currentTranscriptMode !== "original") translateTranscript();

  // Save transcript to cache (without analysis)
  await saveToCache(videoId);

  // DON'T run LLM analysis automatically - wait for user to click Overview tab
  // This saves tokens when user just wants to see the transcript
}

// ============================================================
// RENDERING
// ============================================================

/**
 * Renders the analysis results into the Overview tab.
 * Shows chapters and key quotes only.
 */
function renderAnalysisResults(analysis) {
  // Chapters
  const chapterList = document.getElementById("chapterList");
  chapterList.innerHTML = "";
  (analysis.chapters || []).forEach((chapter) => {
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.dataset.seconds = chapter.timestampSeconds;
    li.innerHTML = `
      <span class="chapter-timestamp">${escapeHtml(chapter.timestamp)}</span>
      <div class="chapter-content">
        <span class="chapter-title">${escapeHtml(chapter.title)}</span>
        <span class="chapter-summary">${escapeHtml(chapter.summary || "")}</span>
        <div class="chapter-actions">
          <button class="context-ask-btn" type="button" title="${escapeHtml(t("askChapterTitle"))}">✦ ${escapeHtml(t("ask"))}</button>
        </div>
      </div>
    `;
    li.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Chapter clicked:",
        chapter.timestamp,
        chapter.timestampSeconds,
      );
      seekTo(chapter.timestampSeconds);
    });
    attachContextAskButton(li, {
      sourceType: "overview",
      sourceLabel: t("sourceOverviewChapter"),
      sourceText: [chapter.title, chapter.summary].filter(Boolean).join("\n"),
      surroundingContext: getTranscriptContextAtTime(chapter.timestampSeconds),
      videoId: currentVideoId,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      timestampSeconds: chapter.timestampSeconds,
    });
    chapterList.appendChild(li);
  });

  // Quotes - sort by timestamp (chronological order)
  const quotesList = document.getElementById("quotesList");
  quotesList.innerHTML = "";
  const sortedQuotes = [...(analysis.keyQuotes || [])].sort(
    (a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0),
  );
  sortedQuotes.forEach((quote) => {
    const div = document.createElement("div");
    div.className = "quote-item";
    div.dataset.seconds = quote.timestampSeconds;
    div.innerHTML = `
      <div class="quote-text">${escapeHtml(quote.quote)}</div>
      <div class="quote-meta">
        <span class="quote-timestamp">${escapeHtml(quote.timestamp)}</span>
        <div class="quote-actions">
          <button class="context-ask-btn" type="button" title="${escapeHtml(t("askQuoteTitle"))}">✦ ${escapeHtml(t("ask"))}</button>
          <button class="quote-save-note-btn" title="${escapeHtml(t("saveQuoteTitle"))}">📝 ${escapeHtml(t("note"))}</button>
          <button class="quote-copy-btn" title="${escapeHtml(t("copyQuoteTitle"))}">⧉ ${escapeHtml(t("copy"))}</button>
        </div>
      </div>
    `;
    div.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Quote clicked:",
        quote.timestamp,
        quote.timestampSeconds,
      );
      seekTo(quote.timestampSeconds);
    });
    attachContextAskButton(div, {
      sourceType: "overview",
      sourceLabel: t("sourceOverviewQuote"),
      sourceText: quote.quote,
      surroundingContext: getTranscriptContextAtTime(quote.timestampSeconds),
      videoId: currentVideoId,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      timestampSeconds: quote.timestampSeconds,
    });

    const quoteCopyBtn = div.querySelector(".quote-copy-btn");
    quoteCopyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(quote.quote);
        quoteCopyBtn.textContent = `✓ ${t("copied")}`;
        setTimeout(() => {
          quoteCopyBtn.textContent = `⧉ ${t("copy")}`;
        }, 1500);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

    const quoteSaveNoteBtn = div.querySelector(".quote-save-note-btn");
    quoteSaveNoteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await saveQuoteAsNote(quote, quoteSaveNoteBtn);
    });

    quotesList.appendChild(div);
  });
}

/**
 * Saves a key quote as a timestamped note.
 */
async function saveQuoteAsNote(quote, btn) {
  if (!currentVideoId) return;

  const originalText = btn.textContent;
  btn.textContent = t("saving");
  btn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      platform: currentPlatform,
      videoId: currentVideoId,
      pageNumber: currentPageNumber,
      tabId: videoTabId,
      timestamp: quote.timestampSeconds,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
    });

    if (result.success) {
      btn.textContent = `✓ ${t("saved")}`;
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
      // Refresh notes list if on Notes tab
      loadNotes(currentVideoId);
    } else {
      console.error("[YouTube Digest] Save quote as note failed:", result.error);
      btn.textContent = t("error");
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    }
  } catch (error) {
    console.error("[YouTube Digest] Save quote as note error:", error);
    btn.textContent = t("error");
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  }
}

/**
 * Legacy function for backwards compatibility with cached data.
 * Renders both transcript and analysis.
 */
function renderResults(analysis) {
  renderAnalysisResults(analysis);

  renderTranscript();

  document.getElementById("tabsNav").style.display = "flex";

  // Setup explain feature for text selection
  setupExplainFeature();
}

/**
 * Returns true while the user has a range of text selected.
 * Transcript row clicks must not seek in that state: the click emitted after
 * selection mouseup belongs to the selection/explain interaction, not playback.
 */
function hasNonCollapsedTextSelection() {
  const selection = window.getSelection();
  return Boolean(
    selection && selection.rangeCount > 0 && !selection.isCollapsed,
  );
}

/**
 * Preserves normal row-click seeking while keeping text selection inert.
 */
function seekFromTranscriptEntryClick(event, seconds) {
  if (hasNonCollapsedTextSelection()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  seekTo(seconds);
}

function renderTranscript() {
  if (!currentTranscript) return;

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  // Show a small badge indicating the transcript came from the video's
  // existing subtitles. (We no longer AI-transcribe audio, so subtitles
  // are the only source.)
  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> ${escapeHtml(t("fromVideoSubtitles", { label: getOriginalTranscriptLabel() }))}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = groupTranscriptEntries(currentTranscript);

  grouped.forEach((group) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = group.start;

    const minutes = Math.floor(group.start / 60);
    const seconds = Math.floor(group.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      <span class="transcript-text">${renderSubtitleInlineMarkup(group.text)}</span>
      <button class="context-ask-btn transcript-context-ask-btn" type="button" title="${escapeHtml(t("askTranscriptTitle"))}">${escapeHtml(t("ask"))}</button>
    `;

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, group.start),
    );
    attachContextAskButton(div, {
      sourceType: "transcript",
      sourceLabel: t("sourceTranscript"),
      sourceText: group.text,
      surroundingContext: getTranscriptContextAtTime(group.start),
      videoId: currentVideoId,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      timestampSeconds: group.start,
    });
    transcriptList.appendChild(div);
  });

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

function copyTranscript() {
  copyToClipboardWithFeedback(currentTranscriptText || "", "copyTranscriptBtn");
}

function exportTranscript() {
  const transcriptContent = currentTranscriptText || "";
  const videoUrl = YTD_PLATFORMS.canonicalVideoUrl(
    currentPlatform,
    currentVideoId,
    currentPageNumber,
  );

  let exportText = "";
  exportText += `${t("exportHeading")}\n`;
  exportText += `${"=".repeat(60)}\n\n`;
  exportText += `${t("exportTitle")}: ${currentVideoTitle || t("unknown")}\n`;
  exportText += `${t("exportChannel")}: ${currentChannelName || t("unknown")}\n`;
  exportText += `URL: ${videoUrl}\n`;
  exportText += `\n${"—".repeat(60)}\n\n`;

  if (currentVideoDescription) {
    exportText += `${t("exportDescription")}:\n${currentVideoDescription}\n`;
    exportText += `\n${"—".repeat(60)}\n\n`;
  }

  exportText += `${t("exportHeading")}:\n\n${transcriptContent}\n`;
  exportText += `\n${"—".repeat(60)}\n`;
  exportText += `${t("exportedBy")}\n`;

  const filename = `${sanitizeFilename(currentVideoTitle)}-transcript.txt`;
  downloadTextFile(exportText, filename);
}

// ============================================================
// UI STATE MANAGEMENT
// ============================================================

function showState(state) {
  document.getElementById("welcomeState").style.display =
    state === "welcome" ? "flex" : "none";
  document.getElementById("loadingState").style.display =
    state === "loading" ? "block" : "none";
  document.getElementById("errorState").style.display =
    state === "error" ? "block" : "none";
  const uploadEl = document.getElementById("uploadState");
  if (uploadEl) uploadEl.style.display = "none"; // Upload state removed — always hidden
  document.getElementById("resultsState").style.display =
    state === "results" ? "block" : "none";

  // The tab bar only belongs on the results view. We toggle it HERE, in one
  // place, so it tracks the view automatically. Previously each caller had to
  // remember to re-show it after showState("results"), and one path forgot —
  // which is why the tabs could vanish when re-opening an already-analyzed video.
  document.getElementById("tabsNav").style.display =
    state === "results" ? "flex" : "none";

  if (state !== "results") {
    stopPlaybackTracking();
  }
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
}

function renderLocalizedError() {
  if (!errorLocalization) return;
  document.getElementById("errorTitle").textContent = errorLocalization.titleKey
    ? t(errorLocalization.titleKey)
    : errorLocalization.fallbackTitle || t("error");
  document.getElementById("errorMessage").textContent = errorLocalization.messageKey
    ? t(errorLocalization.messageKey)
    : errorLocalization.fallbackMessage || t("errorFallback");
  document.getElementById("errorBtn").textContent = t(
    errorLocalization.buttonKey || "tryAgain",
  );
}

function showError(title, message, localization = null) {
  errorAction = null;
  errorLocalization = localization || {
    fallbackTitle: title,
    fallbackMessage: message,
    buttonKey: "tryAgain",
  };
  showState("error");
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorBtn").textContent = t("tryAgain");
}

function showConfigError(configStatus) {
  showState("error");
  errorLocalization = {
    titleKey: "localSetupIncomplete",
    messageKey: "openSettingsHelp",
    fallbackMessage: configStatus?.message || t("openSettingsHelp"),
    buttonKey: "openSettings",
  };
  renderLocalizedError();
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

// ============================================================
// TAB SWITCHING
// ============================================================

function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });

  // Start/stop playback tracking based on which tab is active
  if (tabName === "transcript") {
    startPlaybackTracking();
  } else {
    stopPlaybackTracking();
  }

  // Lazy-load LLM analysis when user switches to Overview tab
  if (tabName === "overview" && !currentAnalysis && !isAnalysisLoading) {
    triggerAnalysis();
  }

  if (tabName === "create") {
    loadLearningPackDraft(currentVideoId);
  }
}

// ============================================================
// CREATE / CREATOR WORKSPACE HANDOFF
// ============================================================

const LEARNING_REFLECTION_FIELDS = Object.freeze({
  myTake: "createMyTake",
  agreeDisagree: "createAgreeDisagree",
  connections: "createConnections",
  coreClaim: "createCoreClaim",
});

function readLearningReflection() {
  return Object.fromEntries(
    Object.entries(LEARNING_REFLECTION_FIELDS).map(([key, id]) => [
      key,
      document.getElementById(id)?.value || "",
    ]),
  );
}

function writeLearningReflection(reflection = {}) {
  for (const [key, id] of Object.entries(LEARNING_REFLECTION_FIELDS)) {
    const field = document.getElementById(id);
    if (field) field.value = typeof reflection[key] === "string" ? reflection[key] : "";
  }
}

function scheduleLearningPackDraftSave() {
  clearTimeout(learningDraftSaveTimer);
  learningDraftSaveTimer = setTimeout(saveLearningPackDraft, 350);
}

async function saveLearningPackDraft() {
  if (!currentVideoId || !globalThis.YTD_LEARNING_PACK) return;
  try {
    const key = YTD_LEARNING_PACK.draftStorageKey(
      currentPlatform,
      currentVideoId,
      currentPageNumber,
    );
    await chrome.storage.local.set({
      [key]: {
        reflection: readLearningReflection(),
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("[YouTube Digest] Could not save Learning Pack draft:", error);
  }
}

async function loadLearningPackDraft(videoId) {
  clearTimeout(learningDraftSaveTimer);
  if (!videoId || !globalThis.YTD_LEARNING_PACK) {
    writeLearningReflection();
    return;
  }
  try {
    const key = YTD_LEARNING_PACK.draftStorageKey(
      currentPlatform,
      videoId,
      currentPageNumber,
    );
    const result = await chrome.storage.local.get(key);
    if (videoId !== currentVideoId) return;
    writeLearningReflection(result[key]?.reflection || {});
  } catch (error) {
    console.error("[YouTube Digest] Could not load Learning Pack draft:", error);
  }
}

function setCreatorWorkspaceStatus(type, message, directory = "") {
  const status = document.getElementById("creatorWorkspaceHandoffStatus");
  if (!status) return;
  status.hidden = false;
  status.className = `creator-workspace-status ${
    type ? `creator-workspace-status--${type}` : ""
  }`;
  status.replaceChildren();

  const messageElement = document.createElement("div");
  messageElement.className = "creator-workspace-status-message";
  messageElement.textContent = message;
  status.appendChild(messageElement);
  if (directory) {
    const pathElement = document.createElement("code");
    pathElement.className = "creator-workspace-path";
    pathElement.textContent = directory;
    status.appendChild(pathElement);
  }
}

async function sendLearningPackToCreatorWorkspace(event) {
  event?.preventDefault();
  const sendButton = document.getElementById("sendToCreatorWorkspaceBtn");
  if (!currentVideoId || !currentTranscript?.length) {
    setCreatorWorkspaceStatus(
      "error",
      t("loadTranscriptBeforePack"),
    );
    return;
  }
  if (!globalThis.YTD_LEARNING_PACK) {
    setCreatorWorkspaceStatus(
      "error",
      t("learningPackUnavailable"),
    );
    return;
  }

  sendButton.disabled = true;
  sendButton.textContent = t("sending");
  setCreatorWorkspaceStatus(
    "working",
    t("writingWorkspace"),
  );
  try {
    await saveLearningPackDraft();
    const notesResult = await chrome.runtime.sendMessage({
      action: "getNotes",
      videoId: currentVideoId,
      platform: currentPlatform,
      pageNumber: currentPageNumber,
    });
    if (!notesResult?.success) {
      throw new Error(notesResult?.error || t("couldNotLoadNotes"));
    }

    const pack = YTD_LEARNING_PACK.buildLearningPack({
      createdAt: new Date().toISOString(),
      source: {
        platform: currentPlatform,
        videoId: currentVideoId,
        pageNumber: currentPageNumber,
        url: currentVideoUrl,
        title: currentVideoTitle,
        channelName: currentChannelName,
        language: currentTranscriptLanguage,
        durationSeconds: currentVideoDuration,
      },
      analysis: currentAnalysis,
      notes: notesResult.notes,
      reflection: readLearningReflection(),
      extensionVersion: chrome.runtime.getManifest().version,
      transcriptLanguage: currentTranscriptLanguage,
      transcriptSegmentCount: currentTranscript.length,
    });
    const result = await chrome.runtime.sendMessage({
      action: "sendLearningPack",
      pack,
    });
    if (!result?.success) {
      throw new Error(result?.error || t("handoffFailed"));
    }
    setCreatorWorkspaceStatus(
      "success",
      t("handoffSuccess"),
      result.receipt?.directory || "",
    );
  } catch (error) {
    console.error("[YouTube Digest] Creator Workspace handoff failed:", error);
    setCreatorWorkspaceStatus(
      "error",
      error?.message || t("handoffFailed"),
    );
  } finally {
    sendButton.disabled = false;
    sendButton.textContent = t("sendToWorkspace");
  }
}

/**
 * Triggers the LLM analysis (lazy-loaded when user clicks Overview or Quotes tab).
 * This saves tokens by not running analysis until needed.
 */
async function triggerAnalysis() {
  if (!currentTranscriptTimestamped || isAnalysisLoading || currentAnalysis)
    return;

  isAnalysisLoading = true;

  // Show loading indicators in the Overview tab
  const chapterList = document.getElementById("chapterList");
  const quotesList = document.getElementById("quotesList");

  if (chapterList)
    chapterList.innerHTML =
      `<li class="chapter-item" style="color: var(--text-muted); border: none;">${escapeHtml(t("loadingChapters"))}</li>`;
  if (quotesList)
    quotesList.innerHTML =
      `<div class="quote-item" style="color: var(--text-muted); border-left-color: var(--border);">${escapeHtml(t("loadingQuotes"))}</div>`;

  try {
    const analysisResult = await chrome.runtime.sendMessage({
      action: "analyzeTranscript",
      transcriptText: currentTranscriptTimestamped,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoDescription: currentVideoDescription,
      videoDuration: currentVideoDuration,
    });

    if (!analysisResult.success) {
      if (chapterList)
        chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">${escapeHtml(t("analysisFailed", { error: analysisResult.error || t("unknownError") }))}</li>`;
      isAnalysisLoading = false;
      return;
    }

    currentAnalysis = analysisResult.analysis;
    renderAnalysisResults(currentAnalysis);
    highlightMomentsOnPage(currentAnalysis.keyMoments);

    // Save to cache now that we have analysis
    await saveToCache(currentVideoId);
  } catch (error) {
    console.error("[YouTube Digest Panel] Analysis error:", error);
    if (chapterList)
      chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">${escapeHtml(t("genericError", { error: error.message }))}</li>`;
  }

  isAnalysisLoading = false;
}

// ============================================================
// TIMESTAMP / SEEK
// ============================================================

async function seekTo(seconds) {
  debugLog("[YouTube Digest Panel] seekTo called with:", seconds);
  const targetSeconds = Number(seconds);
  if (!Number.isFinite(targetSeconds)) {
    debugLog("[YouTube Digest Panel] seekTo aborted - no seconds value");
    return;
  }

  try {
    const result = await chrome.runtime.sendMessage({
      action: "seekVideo",
      tabId: videoTabId,
      seconds: Math.max(0, targetSeconds),
    });
    if (!result?.success) {
      throw new Error(result?.error || "The video could not seek to this timestamp");
    }
    debugLog("[YouTube Digest Panel] seekTo result:", result);
  } catch (error) {
    console.error("[YouTube Digest Panel] seekTo error:", error);
  }
}

/**
 * Plays a saved note at its timestamp.
 * - If the note belongs to the video currently open, we seek the player in place.
 * - If it belongs to a DIFFERENT video (e.g. viewing "All Notes"), seeking the
 *   current player would jump to the wrong content, so we open that video in a
 *   new tab at the right timestamp instead.
 */
function playNote(note) {
  if (
    note.videoId &&
    note.videoId === currentVideoId &&
    (note.platform || "youtube") === currentPlatform &&
    (currentPlatform !== "bilibili" ||
      Number(note.pageNumber || 1) === currentPageNumber)
  ) {
    seekTo(note.timestampSeconds);
  } else {
    // note.timestampedUrl already includes the &t=<seconds>s anchor
    chrome.tabs.create({ url: note.timestampedUrl });
  }
}

function getTranscriptContextAtTime(timestampSeconds) {
  if (!Array.isArray(currentTranscript) || currentTranscript.length === 0) {
    return "";
  }
  const target = Math.max(0, Number(timestampSeconds) || 0);
  let targetIndex = currentTranscript.findIndex(
    (entry, index) =>
      entry.start <= target &&
      (!currentTranscript[index + 1] || currentTranscript[index + 1].start > target),
  );
  if (targetIndex === -1) targetIndex = currentTranscript.length - 1;
  return currentTranscript
    .slice(Math.max(0, targetIndex - 4), targetIndex + 7)
    .map((entry) => entry.text)
    .join(" ")
    .slice(0, 16_000);
}

function attachContextAskButton(container, context) {
  const button = container.querySelector(".context-ask-btn");
  if (!button) return;
  ["mousedown", "mouseup"].forEach((eventName) => {
    button.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openContextQuestion(context);
  });
}

function openContextQuestion(context) {
  context = {
    ...context,
    platform: currentPlatform,
    pageNumber: currentPageNumber,
  };
  document.getElementById("contextQuestionModal")?.remove();
  const timestamp = YTD_QUESTION_ANSWER.formatTimestamp(
    context.timestampSeconds,
  );
  const modal = document.createElement("div");
  modal.id = "contextQuestionModal";
  modal.className = "context-question-overlay";
  modal.innerHTML = `
    <div class="context-question-modal" role="dialog" aria-modal="true" aria-labelledby="contextQuestionTitle">
      <div class="context-question-header">
        <div>
          <div class="context-question-eyebrow">${escapeHtml(t("askCodexEyebrow"))}</div>
          <div class="context-question-title" id="contextQuestionTitle">${escapeHtml(t("askPassage"))}</div>
        </div>
        <button class="context-question-close" type="button" aria-label="${escapeHtml(t("close"))}">✕</button>
      </div>
      <div class="context-question-source">
        <div class="context-question-source-meta">
          <span>${escapeHtml(context.sourceLabel)}</span>
          <span>${escapeHtml(timestamp)}</span>
        </div>
        <div class="context-question-excerpt">${escapeHtml(context.sourceText).replace(/\n/g, "<br>")}</div>
      </div>
      <form class="context-question-form">
        <label for="contextQuestionInput">${escapeHtml(t("yourQuestion"))}</label>
        <textarea id="contextQuestionInput" rows="3" maxlength="2000" required placeholder="${escapeHtml(t("questionPlaceholder"))}"></textarea>
        <button class="context-question-submit" type="submit">${escapeHtml(t("askCodex"))}</button>
      </form>
      <div class="context-question-result" aria-live="polite" hidden>
        <div class="context-question-answer"></div>
        <button class="context-question-save" type="button" hidden>＋ ${escapeHtml(t("saveAnswerToNotes"))}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector(".context-question-close").addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });

  const form = modal.querySelector(".context-question-form");
  const input = modal.querySelector("#contextQuestionInput");
  const submit = modal.querySelector(".context-question-submit");
  const resultBox = modal.querySelector(".context-question-result");
  const answerBox = modal.querySelector(".context-question-answer");
  const saveButton = modal.querySelector(".context-question-save");
  let latestRequest = null;
  let latestAnswer = "";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) return;
    latestRequest = { ...context, question };
    latestAnswer = "";
    submit.disabled = true;
    submit.textContent = t("askingCodex");
    resultBox.hidden = false;
    saveButton.disabled = false;
    saveButton.hidden = true;
    saveButton.textContent = `＋ ${t("saveAnswerToNotes")}`;
    answerBox.innerHTML = `
      <div class="explain-loading">
        <div class="loading-bar"></div>
        <span>${escapeHtml(t("readingContext"))}</span>
      </div>
    `;

    try {
      const response = await chrome.runtime.sendMessage({
        action: "askContextQuestion",
        request: latestRequest,
      });
      if (!response?.success) {
        throw new Error(response?.error || t("codexCouldNotAnswer"));
      }
      latestAnswer = response.answer;
      answerBox.innerHTML = `<div class="context-question-answer-text">${escapeHtml(latestAnswer).replace(/\n/g, "<br>")}</div>`;
      saveButton.hidden = false;
    } catch (error) {
      answerBox.innerHTML = `<div class="explain-error">${escapeHtml(error.message)}</div>`;
    } finally {
      submit.disabled = false;
      submit.textContent = t("askCodex");
    }
  });

  saveButton.addEventListener("click", async () => {
    if (!latestRequest || !latestAnswer) return;
    saveButton.disabled = true;
    saveButton.textContent = t("savingEllipsis");
    try {
      const response = await chrome.runtime.sendMessage({
        action: "saveQuestionAnswerNote",
        request: latestRequest,
        answer: latestAnswer,
      });
      if (!response?.success) {
        throw new Error(response?.error || t("couldNotSaveAnswer"));
      }
      saveButton.textContent = `✓ ${t("savedToNotes")}`;
    } catch (error) {
      saveButton.disabled = false;
      saveButton.textContent = t("retrySave", { error: error.message });
    }
  });

  input.focus();
}

async function highlightMomentsOnPage(moments) {
  if (!moments || !moments.length) return;

  try {
    // Route through background script for reliable message passing
    await chrome.runtime.sendMessage({
      action: "relayToContent",
      tabId: videoTabId,
      payload: {
        action: "highlightMoments",
        moments: moments,
        videoDuration: currentVideoDuration,
      },
    });
  } catch (error) {
    console.error("Highlight error:", error);
  }
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

/**
 * Renders the small subset of inline formatting commonly present in subtitle
 * tracks and model translations. Everything is escaped first; only exact,
 * attribute-free allowlisted tags are restored as markup afterwards.
 */
function renderSubtitleInlineMarkup(text) {
  return escapeHtml(text).replace(
    /&lt;(\/?)(i|em|b|strong|u)&gt;|&lt;br(?:\s*\/)?&gt;/gi,
    (_match, closing, tagName) =>
      tagName ? `<${closing}${tagName.toLowerCase()}>` : "<br>",
  );
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error("Copy failed:", error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId) {
  const btn = document.getElementById(buttonId);
  const original = btn.textContent;

  const success = await copyToClipboard(text);
  if (success) {
    btn.textContent = `✓ ${t("copied")}`;
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  }
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(str) {
  return (str || "untitled")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50)
    .toLowerCase();
}

// ============================================================
// TEXT SELECTION — EXPLAIN FEATURE
// ============================================================

/**
 * Sets up text selection handling in the transcript.
 * When user selects text, shows an "Explain" button.
 */
function setupExplainFeature() {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  // Remove existing tooltip if any
  const existingTooltip = document.getElementById("explainTooltip");
  if (existingTooltip) existingTooltip.remove();

  // Create the explain tooltip/button
  const tooltip = document.createElement("div");
  tooltip.id = "explainTooltip";
  tooltip.className = "explain-tooltip";
  tooltip.innerHTML = `
    <button class="explain-btn">💡 ${escapeHtml(t("explain"))}</button>
    <button class="selection-ask-btn">✦ ${escapeHtml(t("ask"))}</button>
  `;
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let selectedText = "";
  let selectedTimestampSeconds = 0;

  // Interacting with Explain must preserve the transcript selection and stay
  // isolated from document/row click behavior.
  tooltip.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  tooltip.addEventListener("mouseup", (event) => {
    event.stopPropagation();
  });
  tooltip.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  // Listen for text selection
  document.addEventListener("mouseup", (e) => {
    const selection = window.getSelection();
    const text = selection.toString().trim();

    // Only show if selecting within transcript
    const isInTranscript = transcriptList.contains(selection.anchorNode);

    // Allow any selection length (removed 10+ char requirement)
    if (text.length > 0 && isInTranscript) {
      selectedText = text;
      const anchorElement =
        selection.anchorNode?.nodeType === Node.TEXT_NODE
          ? selection.anchorNode.parentElement
          : selection.anchorNode;
      const transcriptEntry = anchorElement?.closest?.(".transcript-entry");
      selectedTimestampSeconds = Number(transcriptEntry?.dataset.seconds) || 0;

      // Position the tooltip near the selection
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      tooltip.style.display = "flex";
      tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
      tooltip.style.left = `${rect.left + rect.width / 2}px`;
    } else {
      tooltip.style.display = "none";
    }
  });

  // Hide tooltip when clicking elsewhere
  document.addEventListener("mousedown", (e) => {
    if (!tooltip.contains(e.target)) {
      tooltip.style.display = "none";
    }
  });

  // Handle explain button click
  tooltip
    .querySelector(".explain-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText) return;

      tooltip.style.display = "none";
      await showExplanation(selectedText);
    });

  tooltip
    .querySelector(".selection-ask-btn")
    .addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText) return;
      tooltip.style.display = "none";
      openContextQuestion({
        sourceType: "transcript",
        sourceLabel: t("sourceTranscriptSelection"),
        sourceText: selectedText,
        surroundingContext: getTranscriptContextAtTime(
          selectedTimestampSeconds,
        ),
        videoId: currentVideoId,
        videoTitle: currentVideoTitle,
        channelName: currentChannelName,
        timestampSeconds: selectedTimestampSeconds,
      });
    });
}

/**
 * Shows the explanation modal and fetches it from the configured AI provider.
 */
async function showExplanation(selectedText) {
  // Create modal
  const modal = document.createElement("div");
  modal.id = "explainModal";
  modal.className = "explain-modal-overlay";
  modal.innerHTML = `
    <div class="explain-modal">
      <div class="explain-modal-header">
        <div class="explain-modal-title">${escapeHtml(t("explain"))}</div>
        <button class="explain-modal-close" id="closeExplain">✕</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? "..." : ""}"</div>
      <div class="explain-modal-content" id="explanationContent">
        <div class="explain-loading">
          <div class="loading-bar"></div>
          <span>${escapeHtml(t("analyzing"))}</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  document
    .getElementById("closeExplain")
    .addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  // Get some context around the selection from the transcript
  const transcriptContext = getTranscriptContext(selectedText);

  // Fetch explanation
  try {
    const result = await chrome.runtime.sendMessage({
      action: "explainSelection",
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle: currentVideoTitle,
    });

    const contentDiv = document.getElementById("explanationContent");
    if (result.success) {
      contentDiv.innerHTML = `<div class="explain-text">${escapeHtml(result.explanation).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</div>`;
    } else {
      contentDiv.innerHTML = `<div class="explain-error">${escapeHtml(t("explanationFailed", { error: result.error }))}</div>`;
    }
  } catch (error) {
    const contentDiv = document.getElementById("explanationContent");
    contentDiv.innerHTML = `<div class="explain-error">${escapeHtml(t("genericError", { error: error.message }))}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText) {
  const fullText = currentTranscriptText || "";
  const index = fullText.indexOf(selectedText);

  if (index === -1) return "";

  // Get 200 chars before and after
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selectedText.length + 200);

  return fullText.substring(start, end);
}

// ============================================================
// CACHING
// ============================================================

/**
 * Saves the current digest results to persistent local storage.
 * Results survive browser restarts — reopening the same video loads from cache
 * without consuming Codex usage or subtitle requests.
 * Cache expires after 30 days. Oldest entries evicted when > 20 videos cached.
 */
async function saveToCache(videoId) {
  if (!videoId || !currentTranscript) return;

  try {
    // Persist semantic-segment translations for this video.
    const paragraphCacheForVideo = {};
    for (const [key, value] of transcriptParagraphCache.entries()) {
      if (key.startsWith(`${currentContentKey || videoId}:`)) {
        paragraphCacheForVideo[key] = value;
      }
    }

    const cacheData = {
      cacheSchemaVersion: DIGEST_CACHE_SCHEMA_VERSION,
      contentKey: currentContentKey,
      analysis: currentAnalysis, // May be null if not yet analyzed
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptLanguage: currentTranscriptLanguage,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoId,
      platform: currentPlatform,
      pageNumber: currentPageNumber,
      paragraphCache: paragraphCacheForVideo,
      timestamp: Date.now(),
    };

    const sourceStorageKey = YTD_PLATFORMS.storageKey(
      currentPlatform,
      videoId,
      currentPageNumber,
    );
    await chrome.storage.local.set({ [`digest_${sourceStorageKey}`]: cacheData });
    debugLog(
      "Saved to cache:",
      videoId,
      currentAnalysis ? "(with analysis)" : "(transcript only)",
    );

    // Evict old entries if we have more than 20 videos cached
    await evictOldCacheEntries(20);
  } catch (error) {
    console.error("Cache save error:", error);
  }
}

/**
 * Keeps the cache from growing unbounded.
 * Removes the oldest entries when we exceed maxEntries videos.
 *
 * @param {number} maxEntries - Maximum number of cached videos to keep
 */
async function evictOldCacheEntries(maxEntries) {
  try {
    const allData = await chrome.storage.local.get(null);
    let digestKeys = Object.keys(allData).filter((k) =>
      k.startsWith("digest_"),
    );
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = digestKeys.filter((key) => {
      const timestamp = Number(allData[key]?.timestamp) || 0;
      return Date.now() - timestamp > THIRTY_DAYS;
    });
    if (expired.length) {
      await chrome.storage.local.remove(expired);
      const expiredSet = new Set(expired);
      digestKeys = digestKeys.filter((key) => !expiredSet.has(key));
    }

    if (digestKeys.length <= maxEntries) return;

    // Sort by timestamp (oldest first) and remove excess
    const sorted = digestKeys
      .map((k) => ({ key: k, ts: allData[k]?.timestamp || 0 }))
      .sort((a, b) => a.ts - b.ts);

    const toRemove = sorted
      .slice(0, sorted.length - maxEntries)
      .map((e) => e.key);
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
      debugLog(`[YouTube Digest] Evicted ${toRemove.length} old cache entries`);
    }
  } catch (error) {
    console.error("Cache eviction error:", error);
  }
}

/**
 * Loads digest results from persistent local storage.
 * Returns null if not cached or expired (30-day expiry).
 */
async function loadFromCache(videoId) {
  if (!videoId) return null;

  try {
    const sourceStorageKey = YTD_PLATFORMS.storageKey(
      currentPlatform,
      videoId,
      currentPageNumber,
    );
    const cacheKeys = [`digest_${sourceStorageKey}`];
    if (currentPlatform === "youtube") cacheKeys.push(`digest_${videoId}`);
    const result = await chrome.storage.local.get(cacheKeys);
    const cached = cacheKeys.map((key) => result[key]).find(Boolean);

    if (!cached) return null;

    const expectedContentKey =
      currentPlatform === "youtube"
        ? `youtube:${videoId}`
        : `bilibili:${videoId}:p${currentPageNumber}`;
    if (
      cached.cacheSchemaVersion !== DIGEST_CACHE_SCHEMA_VERSION ||
      cached.contentKey !== expectedContentKey ||
      cached.videoId !== videoId
    ) {
      // Invalidate derived digest data from builds that did not bind every
      // transcript and cache entry to an exact platform/video identity.
      // Timestamped Notes use separate keys and are not affected.
      await chrome.storage.local.remove(cacheKeys);
      return null;
    }

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await chrome.storage.local.remove(cacheKeys);
      return null;
    }

    return cached;
  } catch (error) {
    console.error("Cache load error:", error);
    return null;
  }
}

/**
 * Updates the cache after enhance or translation operations.
 */
async function updateCache() {
  if (currentVideoId) {
    await saveToCache(currentVideoId);
  }
}

// ============================================================
// NOTES
// ============================================================

/**
 * Loads and renders notes from storage.
 * @param {string|null} videoId - Filter by video ID, or null for all notes
 */
async function loadNotes(videoId) {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getNotes",
      videoId: videoId,
      platform: videoId ? currentPlatform : undefined,
      pageNumber: videoId ? currentPageNumber : undefined,
    });

    if (result.success) {
      renderNotes(result.notes, videoId);
    }
  } catch (error) {
    console.error("[YouTube Digest Panel] Load notes error:", error);
  }
}

/**
 * Renders the notes list in the Notes tab.
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");

  if (!notesList) return;

  notesList.innerHTML = "";

  if (!notes || notes.length === 0) {
    notesIntro.style.display = "block";
    notesIntro.textContent = filteredVideoId
      ? t("noNotesThisVideo")
      : t("noNotesAll");
    return;
  }

  notesIntro.style.display = "none";

  notes.forEach((note) => {
    const noteEl = document.createElement("div");
    noteEl.className = "note-item";
    const noteBody =
      note.noteType === "question_answer" && note.question && note.answer
        ? `<div class="note-question"><span>Q</span>${escapeHtml(note.question)}</div><div class="note-answer"><span>A</span>${escapeHtml(note.answer).replace(/\n/g, "<br>")}</div>`
        : `"${escapeHtml(note.text)}"`;
    noteEl.innerHTML = `
      <div class="note-header">
        <span class="note-timestamp" data-url="${escapeHtml(note.timestampedUrl)}" data-seconds="${Number(note.timestampSeconds) || 0}">${escapeHtml(note.timestamp)}</span>
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
        ${note.noteType === "question_answer" ? `<span class="note-kind">${escapeHtml(t("codexAnswer"))}</span>` : ""}
        <button class="note-delete" data-id="${escapeHtml(note.id)}" title="${escapeHtml(t("deleteNote"))}">✕</button>
      </div>
      <div class="note-text">${noteBody}</div>
      <div class="note-actions">
        <button class="note-action-btn context-ask-btn">✦ ${escapeHtml(t("ask"))}</button>
        <button class="note-action-btn note-copy-text">⧉ ${escapeHtml(t("copyText"))}</button>
        <button class="note-action-btn note-copy-link" data-url="${escapeHtml(note.timestampedUrl)}">🔗 ${escapeHtml(t("copyTimestamp"))}</button>
        <button class="note-action-btn note-play" data-seconds="${Number(note.timestampSeconds) || 0}">▶ ${escapeHtml(t("play"))}</button>
      </div>
    `;

    attachContextAskButton(noteEl, {
      sourceType: "note",
      sourceLabel: t("sourceSavedNote"),
      sourceText: note.text,
      surroundingContext: note.rawText || "",
      videoId: note.videoId,
      videoTitle: note.videoTitle,
      channelName: note.channelName || "",
      timestampSeconds: note.timestampSeconds,
    });

    // Timestamp click - play from this point (in this tab or a new one)
    noteEl.querySelector(".note-timestamp").addEventListener("click", () => {
      playNote(note);
    });

    // Delete button
    noteEl
      .querySelector(".note-delete")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteNote(note.id);
        loadNotes(filteredVideoId);
      });

    // Copy text button — copies just the note's text
    noteEl
      .querySelector(".note-copy-text")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.text);
          const btn = noteEl.querySelector(".note-copy-text");
          btn.textContent = `✓ ${t("copiedBang")}`;
          setTimeout(() => {
            btn.textContent = `⧉ ${t("copyText")}`;
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Copy timestamp button — copies the timestamped YouTube link
    noteEl
      .querySelector(".note-copy-link")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.timestampedUrl);
          const btn = noteEl.querySelector(".note-copy-link");
          btn.textContent = `✓ ${t("copiedBang")}`;
          setTimeout(() => {
            btn.textContent = `🔗 ${t("copyTimestamp")}`;
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Play button (in this tab if it's the current video, else a new tab)
    noteEl.querySelector(".note-play").addEventListener("click", () => {
      playNote(note);
    });

    notesList.appendChild(noteEl);
  });
}

/**
 * Deletes a note by ID.
 */
async function deleteNote(noteId) {
  try {
    await chrome.runtime.sendMessage({
      action: "deleteNote",
      noteId: noteId,
    });
  } catch (error) {
    console.error("[YouTube Digest Panel] Delete note error:", error);
  }
}

// ============================================================
// AUTO-SCROLL — Follow video playback in transcript
// ============================================================
// While a video plays, the transcript automatically scrolls to show which
// 30-second chunk is currently being spoken. If the user manually scrolls
// (e.g., to read ahead), auto-scroll pauses and a "Follow playback" button
// appears so they can resume it. Highlight always stays active regardless.

/**
 * Starts polling the video's current time and highlighting/scrolling
 * to the matching transcript entry.
 */
function startPlaybackTracking() {
  if (!currentTranscript || !currentTranscript.length) return;

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  autoScrollEnabled = true;
  document.getElementById("followPlaybackBtn").style.display = "none";

  playbackTrackingGeneration += 1;

  // Poll video time every 500ms and run once immediately so the transcript
  // follows playback without waiting for the first interval.
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);
  playbackTrackingTick();

  // Listen for explicit user scrolling intent. A scroll event alone cannot
  // distinguish a trackpad gesture from our own smooth animation, which is
  // why the old implementation frequently disabled itself.
  const contentArea = document.getElementById("contentArea");
  detachPlaybackFollowIntentListeners(contentArea);
  contentArea.addEventListener("wheel", onPlaybackFollowUserIntent, {
    passive: true,
  });
  contentArea.addEventListener("touchmove", onPlaybackFollowUserIntent, {
    passive: true,
  });
  contentArea.addEventListener("pointerdown", onPlaybackFollowPointerDown);
  document.addEventListener("keydown", onPlaybackFollowKeyDown);
}

/**
 * Stops playback tracking entirely. Called when leaving transcript tab,
 * starting a new digest, or leaving results state.
 */
function stopPlaybackTracking() {
  playbackTrackingGeneration += 1;
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  playbackTrackingRequestInFlight = false;
  autoScrollEnabled = true; // Reset for next time
  document.getElementById("followPlaybackBtn").style.display = "none";
  detachPlaybackFollowIntentListeners(document.getElementById("contentArea"));

  // Remove active highlights
  document
    .querySelectorAll(".transcript-entry.active-playback")
    .forEach((el) => {
      el.classList.remove("active-playback");
    });
}

/**
 * One tick of the playback tracker. Gets current video time from the
 * YouTube tab and highlights + scrolls to the matching transcript entry.
 */
async function playbackTrackingTick() {
  if (playbackTrackingRequestInFlight || !autoScrollInterval) return;

  const trackingGeneration = playbackTrackingGeneration;
  playbackTrackingRequestInFlight = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      tabId: videoTabId,
      payload: { action: "getCurrentTime" },
    });

    if (
      trackingGeneration !== playbackTrackingGeneration ||
      !autoScrollInterval ||
      !result?.success ||
      !result.response
    ) {
      return;
    }

    const currentTime = Number(result.response.currentTime);
    if (!Number.isFinite(currentTime)) return;
    highlightActiveEntry(currentTime);
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away
  } finally {
    if (trackingGeneration === playbackTrackingGeneration) {
      playbackTrackingRequestInFlight = false;
    }
  }
}

/**
 * Scrolls the transcript to the entry currently being spoken (the one
 * carrying the active-playback highlight). Returns false if nothing is
 * highlighted yet. Programmatic scrolling targets the panel's own scroll
 * container and therefore never has to masquerade as user input.
 */
function scrollToActiveEntry({ force = false } = {}) {
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!activeEntry) return false;

  scrollTranscriptEntryIntoView(activeEntry, { force });
  return true;
}

function scrollTranscriptEntryIntoView(entry, { force = false } = {}) {
  const contentArea = document.getElementById("contentArea");
  if (!contentArea || !entry) return false;

  const containerRect = contentArea.getBoundingClientRect();
  const entryRect = entry.getBoundingClientRect();
  const metrics = {
    containerTop: containerRect.top,
    containerHeight: contentArea.clientHeight,
    entryTop: entryRect.top,
    entryBottom: entryRect.bottom,
    entryHeight: entryRect.height,
    scrollTop: contentArea.scrollTop,
    scrollHeight: contentArea.scrollHeight,
  };

  if (!force && YTD_PLAYBACK_FOLLOW.isEntryInFollowZone(metrics)) {
    return false;
  }

  contentArea.scrollTo({
    top: YTD_PLAYBACK_FOLLOW.getCenteredScrollTop(metrics),
    behavior: "smooth",
  });
  return true;
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  const entries = transcriptList.querySelectorAll(".transcript-entry");
  if (entries.length === 0) return;

  const entryList = Array.from(entries);
  const activeIndex = YTD_PLAYBACK_FOLLOW.findActiveEntryIndex(
    entryList.map((entry) => entry.dataset.seconds),
    currentSeconds,
  );
  const activeEntry = activeIndex >= 0 ? entryList[activeIndex] : null;

  if (!activeEntry) return;

  const changedEntry = !activeEntry.classList.contains("active-playback");
  if (changedEntry) {
    entries.forEach((entry) => entry.classList.remove("active-playback"));
    activeEntry.classList.add("active-playback");
  }

  // A newly active row is centered. For an unchanged row, still recover if a
  // layout/font change has moved it outside the central follow zone.
  if (autoScrollEnabled) {
    scrollTranscriptEntryIntoView(activeEntry, { force: changedEntry });
  }
}

/**
 * Pauses following only for explicit user intent. Programmatic smooth scrolls
 * never pass through this path, so they cannot accidentally disable tracking.
 */
function pausePlaybackFollow() {
  if (autoScrollEnabled && autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
}

function onPlaybackFollowUserIntent() {
  pausePlaybackFollow();
}

function onPlaybackFollowKeyDown(event) {
  if (!PLAYBACK_FOLLOW_SCROLL_KEYS.has(event.key)) return;
  if (
    event.target?.matches?.(
      "input, textarea, select, [contenteditable='true']",
    )
  ) {
    return;
  }
  pausePlaybackFollow();
}

function onPlaybackFollowPointerDown(event) {
  const contentArea = document.getElementById("contentArea");
  if (!contentArea || event.target !== contentArea) return;

  const bounds = contentArea.getBoundingClientRect();
  const scrollbarHitArea = 18;
  if (event.clientX >= bounds.right - scrollbarHitArea) {
    pausePlaybackFollow();
  }
}

function detachPlaybackFollowIntentListeners(contentArea) {
  contentArea?.removeEventListener("wheel", onPlaybackFollowUserIntent);
  contentArea?.removeEventListener("touchmove", onPlaybackFollowUserIntent);
  contentArea?.removeEventListener("pointerdown", onPlaybackFollowPointerDown);
  document.removeEventListener("keydown", onPlaybackFollowKeyDown);
}

// ============================================================
// TRANSCRIPT MODE UI — Original / Chinese / aligned bilingual
// ============================================================

function getOriginalTranscriptLabel() {
  const language = String(currentTranscriptLanguage || "").trim();
  return /^[A-Za-z0-9-]{1,20}$/.test(language)
    ? t("originalWithLanguage", { language })
    : t("original");
}

function getActiveTranscriptSegments() {
  return groupTranscriptEntries(currentTranscript || []);
}

function transcriptTranslationCacheKey(segment) {
  return `${currentContentKey || currentVideoId}:zh:semantic:${segment.id}`;
}

function setTranscriptModeButtons(mode) {
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    const active = button.dataset.transcriptMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function handleTranscriptModeChange(mode) {
  if (!["original", "zh", "bilingual"].includes(mode)) return;
  if (mode === currentTranscriptMode) return;

  currentTranscriptMode = mode;
  translationGeneration += 1;
  translationWorkCount = 0;
  setTranslatingSpinner(false);
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
  transcriptScrollObserver = null;
  setTranscriptModeButtons(mode);

  if (mode === "original") {
    renderTranscript();
    return;
  }

  await translateTranscript();
}

function renderTranscriptSegmentContent(segment, mode, translated, error) {
  const original = renderSubtitleInlineMarkup(segment.text);
  let translationHtml = "";
  if (translated) {
    translationHtml = renderSubtitleInlineMarkup(translated);
  } else if (error) {
    translationHtml = `${escapeHtml(error)}<button class="translation-retry-btn" type="button">${escapeHtml(t("retry"))}</button>`;
  } else {
    translationHtml = escapeHtml(t("waitingTranslation"));
  }

  if (mode === "bilingual") {
    return `<span class="transcript-copy"><span class="transcript-original">${original}</span><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
  }

  return `<span class="transcript-copy"><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
}

function renderTranscriptModeRows(segments, mode) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return [];
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();
  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  const originalLabel = getOriginalTranscriptLabel();
  const modeLabel =
    mode === "bilingual"
      ? t("bilingualModeLabel", { original: originalLabel })
      : t("translatedModeLabel", { original: originalLabel });
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> ${escapeHtml(t("fromVideoSubtitles", { label: modeLabel }))}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  const rows = [];
  segments.forEach((segment, index) => {
    const div = document.createElement("div");
    const cached = transcriptParagraphCache.get(
      transcriptTranslationCacheKey(segment),
    );
    div.className = `transcript-entry ${cached ? "translated" : "translating"}`;
    div.dataset.seconds = segment.start;
    div.dataset.segmentId = segment.id;
    div.dataset.segmentIndex = index;

    const minutes = Math.floor(segment.start / 60);
    const seconds = Math.floor(segment.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;
    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      ${renderTranscriptSegmentContent(segment, mode, cached, "")}
      <button class="context-ask-btn transcript-context-ask-btn" type="button" title="${escapeHtml(t("askTranscriptTitle"))}">${escapeHtml(t("ask"))}</button>
    `;
    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, segment.start),
    );
    attachContextAskButton(div, {
      sourceType: "transcript",
      sourceLabel: t("sourceTranscript"),
      sourceText: segment.text,
      surroundingContext: getTranscriptContextAtTime(segment.start),
      videoId: currentVideoId,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      timestampSeconds: segment.start,
    });
    transcriptList.appendChild(div);
    rows.push(div);
  });

  startPlaybackTracking();
  return rows;
}

/**
 * Rebuilds a provider response in source order. Unknown IDs are ignored and
 * missing IDs remain explicit errors, never positional guesses.
 */
function alignTranslatedSegmentBatch(sourceSegments, responseSegments) {
  const translatedById = new Map();
  if (Array.isArray(responseSegments)) {
    responseSegments.forEach((item) => {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string")
        return;
      const text = item.text.trim();
      if (text && !translatedById.has(item.id)) {
        translatedById.set(item.id, text);
      }
    });
  }

  return sourceSegments.map((segment) => ({
    id: segment.id,
    text: translatedById.get(segment.id) || "",
    error: translatedById.has(segment.id) ? "" : t("translationUnavailable"),
  }));
}

function updateTranslatedRow(segment, index, alignedItem, generation) {
  if (generation !== translationGeneration) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-id="${CSS.escape(segment.id)}"]`,
  );
  if (!row) return;

  if (alignedItem.text) {
    transcriptParagraphCache.set(
      transcriptTranslationCacheKey(segment),
      alignedItem.text,
    );
  }

  const copy = row.querySelector(".transcript-copy");
  if (copy) {
    copy.outerHTML = renderTranscriptSegmentContent(
      segment,
      currentTranscriptMode,
      alignedItem.text,
      alignedItem.error,
    );
  }
  row.classList.toggle("translated", !!alignedItem.text);
  row.classList.toggle("translating", false);
  row.classList.toggle("translation-failed", !alignedItem.text);

  const retry = row.querySelector(".translation-retry-btn");
  if (retry) {
    ["mousedown", "mouseup"].forEach((eventName) => {
      retry.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      retryTranslationSegment(index, generation);
    });
  }
}

let activeTranslationQueue = null;

async function requestTranscriptTranslationBatch(
  indices,
  segments,
  generation,
  videoId,
  mode,
) {
  const sourceBatch = indices.map((index) => segments[index]);
  setTranslatingSpinner(true);
  try {
    const result = await sendTranslationMessage({
      action: "translateContent",
      content: {
        segments: sourceBatch.map(({ id, text }) => ({ id, text })),
      },
      contentType: "transcriptBatch",
      targetLanguage: "zh",
      videoTitle: currentVideoTitle,
    });

    const isStale =
      generation !== translationGeneration ||
      videoId !== currentVideoId ||
      mode !== currentTranscriptMode;
    if (isStale) return;

    const responseSegments = result?.success
      ? result.translatedContent?.segments
      : [];
    const aligned = alignTranslatedSegmentBatch(sourceBatch, responseSegments);
    aligned.forEach((item, batchIndex) => {
      if (!result?.success) {
        item.error = result?.error || t("translationFailed");
      }
      updateTranslatedRow(
        sourceBatch[batchIndex],
        indices[batchIndex],
        item,
        generation,
      );
    });
    await updateCache();
  } catch (error) {
    if (generation !== translationGeneration) return;
    sourceBatch.forEach((segment, batchIndex) => {
      updateTranslatedRow(
        segment,
        indices[batchIndex],
        { id: segment.id, text: "", error: error.message || t("translationFailed") },
        generation,
      );
    });
  } finally {
    setTranslatingSpinner(false);
  }
}

function retryTranslationSegment(index, generation) {
  if (generation !== translationGeneration || !activeTranslationQueue) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-index="${index}"]`,
  );
  if (row) {
    row.classList.add("translating");
    row.classList.remove("translation-failed");
    const translation = row.querySelector(".transcript-translation");
    if (translation) {
      translation.className = "transcript-translation translation-pending";
      translation.textContent = t("retrying");
    }
  }
  activeTranslationQueue.enqueue(index, true);
}

/**
 * Renders immediately, translates the first small batch, then observes the
 * remaining rows. Batches are sequential so the provider is never flooded.
 */
async function translateTranscript() {
  const segments = getActiveTranscriptSegments();
  if (!segments.length || currentTranscriptMode === "original") return;

  translationGeneration += 1;
  const generation = translationGeneration;
  const videoId = currentVideoId;
  const mode = currentTranscriptMode;
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();

  const rows = renderTranscriptModeRows(segments, mode);
  const queue = [];
  const queued = new Set();
  let processing = false;

  const processNext = async () => {
    if (processing || queue.length === 0 || generation !== translationGeneration)
      return;
    processing = true;
    const indices = queue.splice(0, 12);
    indices.forEach((index) => queued.delete(index));
    try {
      await requestTranscriptTranslationBatch(
        indices,
        segments,
        generation,
        videoId,
        mode,
      );
    } finally {
      processing = false;
      if (queue.length && generation === translationGeneration) processNext();
    }
  };

  const enqueue = (index, force = false) => {
    if (!Number.isInteger(index) || !segments[index]) return;
    const cached = transcriptParagraphCache.has(
      transcriptTranslationCacheKey(segments[index]),
    );
    if ((!force && cached) || queued.has(index)) return;
    queue.push(index);
    queued.add(index);
    // Let all entries reported in the same viewport turn collect before the
    // worker starts, producing one small contextual multi-segment request.
    Promise.resolve().then(processNext);
  };
  activeTranslationQueue = { enqueue };

  transcriptScrollObserver = new IntersectionObserver(
    (observerEntries) => {
      observerEntries
        .filter((entry) => entry.isIntersecting)
        .sort(
          (a, b) =>
            Number(a.target.dataset.segmentIndex) -
            Number(b.target.dataset.segmentIndex),
        )
        .forEach((entry) => enqueue(Number(entry.target.dataset.segmentIndex)));
    },
    {
      root: document.getElementById("contentArea"),
      rootMargin: "320px 0px",
      threshold: 0,
    },
  );

  rows.forEach((row, index) => {
    if (!row.classList.contains("translated")) transcriptScrollObserver.observe(row);
    if (index < 3) enqueue(index);
  });
}

function setTranslatingSpinner(show) {
  if (show) translationWorkCount += 1;
  else translationWorkCount = Math.max(0, translationWorkCount - 1);
  const isTranslating = translationWorkCount > 0;
  const spinner = document.getElementById("langSpinner");
  if (spinner) spinner.classList.toggle("visible", isTranslating);
}

// Pure helpers are exposed for the repository's Node tests. The extension does
// not read this object at runtime.
globalThis.__YTD_TRANSCRIPT_TESTING__ = {
  sendTranslationMessage,
  groupTranscriptEntries,
  splitOversizedThought,
  alignTranslatedSegmentBatch,
  renderSubtitleInlineMarkup,
  renderTranscriptSegmentContent,
};

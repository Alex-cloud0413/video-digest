/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for YT Digest: video detection, transcript analysis,
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
let currentAnalysis = null;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptTimestamped = null; // With timestamps for AI analysis
let currentTranscriptSource = null; // always null now (subtitles are the only source)
let currentTranscriptLanguage = null;
let currentAvailableTranscriptLanguages = [];
let currentEnhancedTranscript = null;
let currentVideoTitle = "";
let currentChannelName = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let isTranscriptCleanedUp = false; // True when cleaned-up transcript is displayed
let isAnalysisLoading = false; // Track if analysis is in progress
let youtubeTabId = null; // Store the YouTube tab ID for reliable messaging
let errorAction = null;

// --- Translation state ---
// The public transcript control intentionally supports only the original
// subtitles, Chinese, and an aligned source + Chinese view.
let currentTranscriptMode = "original";
let currentLanguage = "en"; // Retained for the internal Overview translator.
let lastRequestedLanguage = "en";
let translationGeneration = 0; // Invalidates responses from older UI modes/videos.
let translationWorkCount = 0;
let isTranslating = false;
// Translation cache: Map of "videoId:lang:contentType" → translated content
// This avoids re-translating the same content when switching tabs or languages
let translationCache = new Map();
let transcriptScrollObserver = null;
// Stable keys include the video, source mode, language, and semantic segment ID.
let transcriptParagraphCache = new Map();
const TRANSLATION_MESSAGE_TIMEOUT_MS = 130_000;

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
          "Translation request timed out after 130 seconds. Please Retry.",
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
let lastAutoScrollTime = 0; // Timestamp of last programmatic scroll (ignores scroll events within 1s)

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
 * and time limits prevent a malformed Supadata entry from becoming one giant
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
  setupEventListeners();
  await evictOldCacheEntries(20);

  const configStatus = await chrome.runtime.sendMessage({
    action: "checkConfig",
  });

  if (!configStatus.hasSupadataKey || !configStatus.hasAiKey) {
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
function handleFrontTabUrl(url) {
  if (!(url || "").startsWith("https://www.youtube.com")) {
    // Panel is a YouTube-only tool — remove itself from non-YouTube tabs.
    window.close();
    return;
  }

  const newVideoId = extractVideoId(url);
  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video).
  if (newVideoId !== currentVideoId || !panelIsShowingResults()) {
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
    .getElementById("enhanceBtn")
    ?.addEventListener("click", toggleTranscriptCleanup);
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

  // Clean up toggle tooltip
  setupCleanupToggleTooltip();

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
      if (!scrollToActiveEntry()) {
        playbackTrackingTick(); // No highlight yet — let a tick establish one
      }
    });

  // Notes filter buttons
  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    document.getElementById("notesFilterThis").classList.add("active");
    document.getElementById("notesFilterAll").classList.remove("active");
    loadNotes(currentVideoId);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    document.getElementById("notesFilterAll").classList.add("active");
    document.getElementById("notesFilterThis").classList.remove("active");
    loadNotes(null); // Load all notes
  });
}

// ============================================================
// VIDEO DETECTION
// ============================================================

async function checkCurrentTab() {
  try {
    // Try multiple strategies to find the YouTube tab
    let tab = null;

    // Strategy 1: Active tab in last focused window
    let tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tabs[0]?.url?.includes("youtube.com")) {
      tab = tabs[0];
    }

    // Strategy 2: Any active YouTube tab
    if (!tab) {
      tabs = await chrome.tabs.query({
        url: "https://www.youtube.com/*",
        active: true,
      });
      if (tabs[0]) tab = tabs[0];
    }

    // Strategy 3: Any YouTube tab (last resort)
    if (!tab) {
      tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
      if (tabs[0]) tab = tabs[0];
    }

    debugLog("[YT Digest Panel] Found tab:", tab?.id, tab?.url);

    if (!tab?.url) {
      showState("welcome");
      return;
    }

    // Store the tab ID for reliable messaging later
    youtubeTabId = tab.id;

    const videoId = extractVideoId(tab.url);

    if (videoId) {
      currentVideoUrl = tab.url;

      try {
        // Route through background script for reliable message passing
        const result = await chrome.runtime.sendMessage({
          action: "relayToContent",
          payload: { action: "getVideoInfo" },
        });
        debugLog("[YT Digest Panel] getVideoInfo result:", result);
        if (result.success && result.response) {
          currentVideoTitle = result.response.title || "";
          currentChannelName = result.response.channelName || "";
          currentVideoDescription = result.response.description || "";
          currentVideoDuration = result.response.duration || 0;
        }
      } catch (e) {
        console.error("[YT Digest Panel] getVideoInfo error:", e);
        currentVideoTitle = "";
        currentChannelName = "";
        currentVideoDescription = "";
        currentVideoDuration = 0;
      }

      startDigest(videoId, tab.url);
    } else {
      showState("welcome");
    }
  } catch (error) {
    console.error("Tab check error:", error);
    showState("welcome");
  }
}

function extractVideoId(url) {
  try {
    const urlObj = new URL(url);

    if (
      urlObj.hostname.includes("youtube.com") &&
      urlObj.searchParams.has("v")
    ) {
      return urlObj.searchParams.get("v");
    }

    if (urlObj.hostname === "youtu.be") {
      return urlObj.pathname.slice(1);
    }

    if (urlObj.pathname.startsWith("/embed/")) {
      return urlObj.pathname.split("/")[2];
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

async function startDigest(videoId, videoUrl) {
  // Check if we already have this video loaded in memory
  if (videoId === currentVideoId && currentAnalysis) {
    showState("results");
    return;
  }

  // Every video change invalidates observer work and in-flight translations.
  if (videoId !== currentVideoId) {
    translationGeneration += 1;
    if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
    transcriptScrollObserver = null;
  }

  // Check cache for this video
  const cached = await loadFromCache(videoId);
  if (cached) {
    debugLog("Loading from cache:", videoId);
    currentVideoId = videoId;
    currentVideoUrl = videoUrl;
    currentAnalysis = cached.analysis || null;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptTimestamped = cached.transcriptTimestamped;
    currentTranscriptSource = cached.transcriptSource || null;
    currentTranscriptLanguage = cached.transcriptLanguage || null;
    currentAvailableTranscriptLanguages = Array.isArray(
      cached.availableTranscriptLanguages,
    )
      ? cached.availableTranscriptLanguages
      : [];
    currentEnhancedTranscript = cached.enhancedTranscript || null;
    isTranscriptCleanedUp = !!cached.enhancedTranscript;
    isAnalysisLoading = false;

    // Restore translation caches from persistent storage
    if (cached.translationCache) {
      for (const [key, value] of Object.entries(cached.translationCache)) {
        translationCache.set(key, value);
      }
    }
    // Restore per-entry/paragraph translation cache (individual chunk translations)
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
    if (isTranscriptCleanedUp && currentEnhancedTranscript) {
      renderCleanedUpTranscript(currentEnhancedTranscript);
      setCleanupToggleState(true);
    } else {
      renderTranscript();
      setCleanupToggleState(false);
    }

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
  currentVideoUrl = videoUrl;
  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptSource = null;
  currentTranscriptLanguage = null;
  currentAvailableTranscriptLanguages = [];
  currentEnhancedTranscript = null;
  isTranscriptCleanedUp = false;
  isAnalysisLoading = false;

  if (currentVideoTitle || currentChannelName) {
    const videoInfo = document.getElementById("videoInfo");
    document.getElementById("videoTitle").textContent = currentVideoTitle;
    document.getElementById("videoChannel").textContent = currentChannelName;
    videoInfo.style.display = "block";
  }

  showState("loading");
  updateLoading("Fetching transcript", "");

  const transcriptResult = await chrome.runtime.sendMessage({
    action: "fetchTranscript",
    videoId: videoId,
    videoUrl: videoUrl,
  });

  if (!transcriptResult.success) {
    if (transcriptResult.error === "NO_SUPADATA_KEY") {
      showError(
        "API key missing",
        "Add your Supadata API key in YT Digest Settings.",
      );
      return;
    }
    showError(
      "No transcript found",
      transcriptResult.message || transcriptResult.error,
    );
    return;
  }

  currentTranscript = transcriptResult.transcript;
  currentTranscriptText = transcriptResult.transcriptText;
  currentTranscriptTimestamped = transcriptResult.transcriptTextTimestamped;
  currentTranscriptSource = transcriptResult.source || null; // null (subtitles only)
  currentTranscriptLanguage = transcriptResult.language || null;
  currentAvailableTranscriptLanguages = Array.isArray(
    transcriptResult.availableLanguages,
  )
    ? transcriptResult.availableLanguages
    : [];

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
      </div>
    `;
    li.addEventListener("click", () => {
      debugLog(
        "[YT Digest Panel] Chapter clicked:",
        chapter.timestamp,
        chapter.timestampSeconds,
      );
      seekTo(chapter.timestampSeconds);
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
          <button class="quote-save-note-btn" title="Save this quote as a note">📝 Note</button>
          <button class="quote-copy-btn" title="Copy this quote">⧉ Copy</button>
        </div>
      </div>
    `;
    div.addEventListener("click", () => {
      debugLog(
        "[YT Digest Panel] Quote clicked:",
        quote.timestamp,
        quote.timestampSeconds,
      );
      seekTo(quote.timestampSeconds);
    });

    const quoteCopyBtn = div.querySelector(".quote-copy-btn");
    quoteCopyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(quote.quote);
        quoteCopyBtn.textContent = "✓ Copied";
        setTimeout(() => {
          quoteCopyBtn.textContent = "⧉ Copy";
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
  btn.textContent = "Saving...";
  btn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: currentVideoId,
      timestamp: quote.timestampSeconds,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoUrl: currentVideoUrl || `https://youtube.com/watch?v=${currentVideoId}`,
    });

    if (result.success) {
      btn.textContent = "✓ Saved";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
      // Refresh notes list if on Notes tab
      loadNotes(currentVideoId);
    } else {
      console.error("[YT Digest] Save quote as note failed:", result.error);
      btn.textContent = "Error";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    }
  } catch (error) {
    console.error("[YT Digest] Save quote as note error:", error);
    btn.textContent = "Error";
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

  // Transcript - show cleaned-up version if available and toggle is on
  if (isTranscriptCleanedUp && currentEnhancedTranscript) {
    renderCleanedUpTranscript(currentEnhancedTranscript);
    setCleanupToggleState(true);
  } else {
    renderTranscript();
    setCleanupToggleState(false);
  }

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
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> From video subtitles · ${escapeHtml(getOriginalTranscriptLabel())}`;
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
    `;

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, group.start),
    );
    transcriptList.appendChild(div);
  });

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

/**
 * Renders the cleaned-up transcript using the original timestamp groups.
 * Each group is cleaned individually so timestamps and click-to-seek remain.
 */
function renderCleanedUpTranscript(cleanedEntries) {
  if (!cleanedEntries || !cleanedEntries.length) return;

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  // Show source badge
  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> From video subtitles · ${escapeHtml(getOriginalTranscriptLabel())} · cleaned up`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  cleanedEntries.forEach((entry) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = entry.start;

    const minutes = Math.floor(entry.start / 60);
    const seconds = entry.start % 60;
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      <span class="transcript-text">${renderSubtitleInlineMarkup(entry.text)}</span>
    `;

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, entry.start),
    );
    transcriptList.appendChild(div);
  });

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

// ============================================================
// TRANSCRIPT CLEANUP
// ============================================================

async function toggleTranscriptCleanup() {
  if (!currentTranscriptText) return;

  // If already cleaned up, turn it off and re-render original
  if (isTranscriptCleanedUp) {
    isTranscriptCleanedUp = false;
    setCleanupToggleState(false);
    clearTranslationCacheForType("transcript");
    if (currentTranscriptMode === "original") renderTranscript();
    else translateTranscript();
    await updateCache();
    return;
  }

  const enhanceBtn = document.getElementById("enhanceBtn");
  const enhanceLabel = document.getElementById("enhanceBtnLabel");
  enhanceBtn.disabled = true;
  if (enhanceLabel) enhanceLabel.textContent = "Cleaning...";

  try {
    const result = await chrome.runtime.sendMessage({
      action: "enhanceTranscript",
      transcriptText: currentTranscriptText,
      transcriptEntries: currentTranscript,
      videoTitle: currentVideoTitle,
      videoDescription: currentVideoDescription,
    });

    if (result.success) {
      isTranscriptCleanedUp = true;
      currentEnhancedTranscript = result.enhancedTranscript;
      setCleanupToggleState(true);
      // Clear transcript translation cache since content changed
      clearTranslationCacheForType("transcript");
      if (currentTranscriptMode === "original") {
        renderCleanedUpTranscript(result.enhancedTranscript);
      } else {
        translateTranscript();
      }
      await updateCache(); // Save cleaned-up transcript to cache
    } else {
      isTranscriptCleanedUp = false;
      setCleanupToggleState(false);
      console.error("Cleanup failed:", result.error);
    }
  } catch (error) {
    isTranscriptCleanedUp = false;
    setCleanupToggleState(false);
    console.error("Cleanup error:", error);
  }
}

function setCleanupToggleState(isOn) {
  const btn = document.getElementById("enhanceBtn");
  const label = document.getElementById("enhanceBtnLabel");
  const badge = document.getElementById("cleanupBadge");
  if (!btn) return;

  btn.disabled = false;
  if (label) label.textContent = isOn ? "✓ Cleaned up" : "🧹 Clean up";
  btn.classList.toggle("active", isOn);
  if (badge) badge.style.display = isOn ? "inline-flex" : "none";
}

function copyTranscript() {
  const text = isTranscriptCleanedUp
    ? formatTranscriptForExport(currentEnhancedTranscript)
    : currentTranscriptText || "";
  copyToClipboardWithFeedback(text, "copyTranscriptBtn");
}

function exportTranscript() {
  const transcriptContent = isTranscriptCleanedUp
    ? formatTranscriptForExport(currentEnhancedTranscript)
    : currentTranscriptText || "";
  const videoUrl = `https://youtube.com/watch?v=${currentVideoId}`;

  let exportText = "";
  exportText += `TRANSCRIPT\n`;
  exportText += `${"=".repeat(60)}\n\n`;
  exportText += `Title: ${currentVideoTitle || "Unknown"}\n`;
  exportText += `Channel: ${currentChannelName || "Unknown"}\n`;
  exportText += `URL: ${videoUrl}\n`;
  exportText += `\n${"—".repeat(60)}\n\n`;

  if (currentVideoDescription) {
    exportText += `DESCRIPTION:\n${currentVideoDescription}\n`;
    exportText += `\n${"—".repeat(60)}\n\n`;
  }

  exportText += `TRANSCRIPT:\n\n${transcriptContent}\n`;
  exportText += `\n${"—".repeat(60)}\n`;
  exportText += `Exported by YT Digest\n`;

  const filename = `${sanitizeFilename(currentVideoTitle)}-transcript.txt`;
  downloadTextFile(exportText, filename);
}

/**
 * Formats cleaned-up transcript entries back into plain timestamped text
 * for copy/export.
 */
function formatTranscriptForExport(entries) {
  if (!entries || !Array.isArray(entries)) return "";
  return entries
    .map((entry) => {
      const minutes = Math.floor(entry.start / 60);
      const seconds = entry.start % 60;
      const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;
      return `[${timestamp}] ${entry.text}`;
    })
    .join("\n");
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

function showError(title, message) {
  errorAction = null;
  showState("error");
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorBtn").textContent = "Try Again";
}

function showConfigError(configStatus) {
  const missingKeys = [];
  if (!configStatus.hasSupadataKey) missingKeys.push("Supadata");
  if (!configStatus.hasAiKey) missingKeys.push("AI provider");

  showState("error");
  document.getElementById("errorTitle").textContent = "API Keys Missing";
  document.getElementById("errorMessage").textContent =
    `Add your ${missingKeys.join(" and ")} API key${missingKeys.length === 1 ? "" : "s"} in YT Digest Settings.`;
  document.getElementById("errorBtn").textContent = "Open Settings";
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
      '<li class="chapter-item" style="color: var(--text-muted); border: none;">Loading chapters...</li>';
  if (quotesList)
    quotesList.innerHTML =
      '<div class="quote-item" style="color: var(--text-muted); border-left-color: var(--border);">Loading quotes...</div>';

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
        chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">Analysis failed: ${escapeHtml(analysisResult.error || "Unknown error")}</li>`;
      isAnalysisLoading = false;
      return;
    }

    currentAnalysis = analysisResult.analysis;
    renderAnalysisResults(currentAnalysis);
    highlightMomentsOnPage(currentAnalysis.keyMoments);

    // Save to cache now that we have analysis
    await saveToCache(currentVideoId);
  } catch (error) {
    console.error("[YT Digest Panel] Analysis error:", error);
    if (chapterList)
      chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">Error: ${escapeHtml(error.message)}</li>`;
  }

  isAnalysisLoading = false;
}

// ============================================================
// TIMESTAMP / SEEK
// ============================================================

async function seekTo(seconds) {
  debugLog("[YT Digest Panel] seekTo called with:", seconds);
  if (seconds === undefined || seconds === null) {
    debugLog("[YT Digest Panel] seekTo aborted - no seconds value");
    return;
  }

  const payload = {
    action: "seekTo",
    seconds: Number(seconds),
  };

  try {
    // Try direct messaging to the stored YouTube tab first (fastest/reliable)
    if (youtubeTabId) {
      try {
        await chrome.tabs.sendMessage(youtubeTabId, payload);
        debugLog("[YT Digest Panel] seekTo direct success");
        return;
      } catch (directErr) {
        debugLog(
          "[YT Digest Panel] Direct seekTo failed, falling back to relay:",
          directErr.message,
        );
      }
    }

    // Fallback: route through background script
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload,
    });
    debugLog("[YT Digest Panel] seekTo relay result:", result);
  } catch (error) {
    console.error("[YT Digest Panel] seekTo error:", error);
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
  if (note.videoId && note.videoId === currentVideoId) {
    seekTo(note.timestampSeconds);
  } else {
    // note.timestampedUrl already includes the &t=<seconds>s anchor
    chrome.tabs.create({ url: note.timestampedUrl });
  }
}

async function highlightMomentsOnPage(moments) {
  if (!moments || !moments.length) return;

  try {
    // Route through background script for reliable message passing
    await chrome.runtime.sendMessage({
      action: "relayToContent",
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
    btn.textContent = "✓ Copied";
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
  tooltip.innerHTML = `<button class="explain-btn">💡 Explain</button>`;
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let selectedText = "";

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

      // Position the tooltip near the selection
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      tooltip.style.display = "block";
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
        <div class="explain-modal-title">Explain</div>
        <button class="explain-modal-close" id="closeExplain">✕</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? "..." : ""}"</div>
      <div class="explain-modal-content" id="explanationContent">
        <div class="explain-loading">
          <div class="loading-bar"></div>
          <span>Analyzing...</span>
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
      contentDiv.innerHTML = `<div class="explain-error">Failed to get explanation: ${escapeHtml(result.error)}</div>`;
    }
  } catch (error) {
    const contentDiv = document.getElementById("explanationContent");
    contentDiv.innerHTML = `<div class="explain-error">Error: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText) {
  const fullText = currentEnhancedTranscript || currentTranscriptText || "";
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
 * without consuming API tokens or Supadata calls.
 * Cache expires after 30 days. Oldest entries evicted when > 20 videos cached.
 */
async function saveToCache(videoId) {
  if (!videoId || !currentTranscript) return;

  try {
    // Build a serializable version of translation cache for this video
    const translationCacheForVideo = {};
    for (const [key, value] of translationCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        translationCacheForVideo[key] = value;
      }
    }

    // Also persist per-entry/paragraph translation cache for this video
    // These are the individual chunk translations (entry:N or para:N keys)
    const paragraphCacheForVideo = {};
    for (const [key, value] of transcriptParagraphCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        paragraphCacheForVideo[key] = value;
      }
    }

    const cacheData = {
      analysis: currentAnalysis, // May be null if not yet analyzed
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptSource: currentTranscriptSource,
      transcriptLanguage: currentTranscriptLanguage,
      availableTranscriptLanguages: currentAvailableTranscriptLanguages,
      enhancedTranscript: currentEnhancedTranscript,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      translationCache: translationCacheForVideo,
      paragraphCache: paragraphCacheForVideo,
      timestamp: Date.now(),
    };

    await chrome.storage.local.set({ [`digest_${videoId}`]: cacheData });
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
      debugLog(`[YT Digest] Evicted ${toRemove.length} old cache entries`);
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
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    const cached = result[`digest_${videoId}`];

    if (!cached) return null;

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await chrome.storage.local.remove(`digest_${videoId}`);
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
    });

    if (result.success) {
      renderNotes(result.notes, videoId);
    }
  } catch (error) {
    console.error("[YT Digest Panel] Load notes error:", error);
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
      ? "No notes for this video yet. Hover over the video and click 📝 Note to save."
      : "No notes saved yet. Hover over a video and click 📝 Note to save.";
    return;
  }

  notesIntro.style.display = "none";

  notes.forEach((note) => {
    const noteEl = document.createElement("div");
    noteEl.className = "note-item";
    noteEl.innerHTML = `
      <div class="note-header">
        <span class="note-timestamp" data-url="${escapeHtml(note.timestampedUrl)}" data-seconds="${Number(note.timestampSeconds) || 0}">${escapeHtml(note.timestamp)}</span>
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
        <button class="note-delete" data-id="${escapeHtml(note.id)}" title="Delete note">✕</button>
      </div>
      <div class="note-text">"${escapeHtml(note.text)}"</div>
      <div class="note-actions">
        <button class="note-action-btn note-copy-text">⧉ Copy text</button>
        <button class="note-action-btn note-copy-link" data-url="${escapeHtml(note.timestampedUrl)}">🔗 Copy timestamp</button>
        <button class="note-action-btn note-play" data-seconds="${Number(note.timestampSeconds) || 0}">▶ Play</button>
      </div>
    `;

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
          btn.textContent = "✓ Copied!";
          setTimeout(() => {
            btn.textContent = "⧉ Copy text";
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
          btn.textContent = "✓ Copied!";
          setTimeout(() => {
            btn.textContent = "🔗 Copy timestamp";
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
    console.error("[YT Digest Panel] Delete note error:", error);
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
 * to the matching transcript entry. Only works for raw transcripts
 * (with timestamps), not enhanced transcripts.
 */
function startPlaybackTracking() {
  // Only for raw transcripts with timestamp-based entries
  if (isTranscriptCleanedUp) return;
  if (!currentTranscript || !currentTranscript.length) return;

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  autoScrollEnabled = true;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Poll video time every 500ms
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);

  // Listen for manual scrolls on the content area
  const contentArea = document.getElementById("contentArea");
  contentArea.removeEventListener("scroll", onContentAreaScroll);
  contentArea.addEventListener("scroll", onContentAreaScroll);
}

/**
 * Stops playback tracking entirely. Called when leaving transcript tab,
 * starting a new digest, or leaving results state.
 */
function stopPlaybackTracking() {
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  autoScrollEnabled = true; // Reset for next time
  lastAutoScrollTime = 0;
  document.getElementById("followPlaybackBtn").style.display = "none";

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
  try {
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: { action: "getCurrentTime" },
    });

    if (!result.success || !result.response) return;

    const currentTime = result.response.currentTime || 0;
    highlightActiveEntry(currentTime);
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away
  }
}

/**
 * Scrolls the transcript to the entry currently being spoken (the one
 * carrying the active-playback highlight). Returns false if nothing is
 * highlighted yet. Stamps lastAutoScrollTime BEFORE scrolling so the scroll
 * events from our own smooth animation aren't mistaken for the user
 * scrolling away (which would re-disable auto-scroll immediately).
 */
function scrollToActiveEntry() {
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!activeEntry) return false;

  lastAutoScrollTime = Date.now();
  activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
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

  // Find the entry whose time range contains the current playback time
  let activeEntry = null;
  entries.forEach((entry, index) => {
    const entrySeconds = parseInt(entry.dataset.seconds);
    const nextEntry = entries[index + 1];
    const nextSeconds = nextEntry
      ? parseInt(nextEntry.dataset.seconds)
      : Infinity;

    if (currentSeconds >= entrySeconds && currentSeconds < nextSeconds) {
      activeEntry = entry;
    }
  });

  if (!activeEntry) return;

  // Skip if this entry is already highlighted (no DOM thrashing)
  if (activeEntry.classList.contains("active-playback")) return;

  // Remove old highlight, add new one
  entries.forEach((e) => e.classList.remove("active-playback"));
  activeEntry.classList.add("active-playback");

  // Only scroll if auto-scroll is enabled
  if (autoScrollEnabled) {
    lastAutoScrollTime = Date.now();
    activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * Scroll event handler for the content area.
 * Detects manual scrolling and disables auto-scroll so the user
 * can read at their own pace without being yanked back.
 */
function onContentAreaScroll() {
  // Ignore scroll events within 1 second of a programmatic scroll
  // (smooth scroll animations can last longer than a simple boolean flag)
  if (Date.now() - lastAutoScrollTime < 1000) return;

  // User scrolled manually — disable auto-scroll and show the button
  if (autoScrollEnabled && autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
}

// ============================================================
// TRANSLATION — Language switching and content translation
// ============================================================
// When the user picks ZH or JA from the language dropdown, we translate
// ONLY the currently visible tab (lazy). Translations are cached in a Map
// so switching back and forth is instant. Switching to EN always shows
// the original content immediately with zero API calls.

/**
 * Called when the user changes the language dropdown.
 * If switching to EN, we instantly re-render originals.
 * If switching to ZH/JA, we translate the currently active tab.
 *
 * @param {string} newLang - 'en', 'zh', or 'ja'
 */
async function handleLanguageChange(newLang) {
  // If nothing changed, bail out
  if (newLang === currentLanguage) return;

  const previousLang = currentLanguage;
  currentLanguage = newLang;
  lastRequestedLanguage = newLang;

  // Update visual indicator on the dropdown
  const selector = document.getElementById("langSelector");
  if (newLang !== "en") {
    selector.classList.add("active-lang");
  } else {
    selector.classList.remove("active-lang");
  }

  // If switching back to English, just re-render originals instantly
  if (newLang === "en") {
    restoreOriginalContent();
    return;
  }

  // Otherwise, translate the currently visible tab
  const activeTab = document.querySelector(".tab.active")?.dataset.tab;
  if (activeTab && activeTab !== "notes") {
    await translateCurrentTab(activeTab);
  }
}

/**
 * Re-renders all content in English (the original).
 * No API call needed — we just render from the existing state variables.
 */
function restoreOriginalContent() {
  // Stop any scroll-based translation observer
  if (transcriptScrollObserver) {
    transcriptScrollObserver.disconnect();
    transcriptScrollObserver = null;
  }

  // Transcript
  if (isTranscriptCleanedUp && currentEnhancedTranscript) {
    renderCleanedUpTranscript(currentEnhancedTranscript);
  } else if (currentTranscript) {
    renderTranscript();
  }

  // Sync toggle state
  setCleanupToggleState(isTranscriptCleanedUp);

  // Overview
  if (currentAnalysis) {
    renderAnalysisResults(currentAnalysis);
  }
}

/**
 * Translates the content of the currently active tab.
 * Checks the cache first — only makes an API call if uncached.
 *
 * @param {string} tabName - 'transcript' or 'overview'
 */
async function translateCurrentTab(tabName) {
  // Don't translate notes (user-generated content)
  if (tabName === "notes") return;

  // Check if we already have a translation cached
  const cacheKey = `${currentVideoId}:${currentLanguage}:${tabName}`;
  if (translationCache.has(cacheKey)) {
    renderTranslatedContent(tabName, translationCache.get(cacheKey));
    return;
  }

  // Check if there's content to translate
  const hasContent = checkTabHasContent(tabName);
  if (!hasContent) return; // Nothing to translate yet — will translate when content arrives

  // Route to the appropriate translation function
  switch (tabName) {
    case "transcript":
      await translateTranscript();
      break;
    case "overview":
      await translateOverview();
      break;
  }
}

/**
 * Checks if a tab has content ready to translate.
 *
 * @param {string} tabName - The tab name
 * @returns {boolean} - True if the tab has content
 */
function checkTabHasContent(tabName) {
  switch (tabName) {
    case "transcript":
      return !!(currentEnhancedTranscript || currentTranscriptText);
    case "overview":
      return !!currentAnalysis;
    default:
      return false;
  }
}

/**
 * Shows/hides the small spinner next to the language dropdown.
 *
 * @param {boolean} show - True to show, false to hide
 */
function setTranslatingSpinner(show) {
  isTranslating = show;
  const spinner = document.getElementById("langSpinner");
  if (spinner) {
    spinner.classList.toggle("visible", show);
  }
}

/**
 * Translates the transcript tab using scroll-based lazy loading.
 *
 * Works in two modes depending on transcript type:
 *
 * RAW TRANSCRIPT (default):
 * - Keeps the timestamp-grouped .transcript-entry layout intact
 * - Each 30-second group is a translation unit
 * - IntersectionObserver watches entries and translates text in-place
 * - Timestamps remain untouched, only the text portion gets translated
 *
 * ENHANCED TRANSCRIPT:
 * - Uses paragraph-based lazy translation (no timestamps to preserve)
 * - Splits by paragraph breaks, translates visible paragraphs
 *
 * Both modes use the same batch + observer pattern for fast initial load.
 */
async function translateTranscript() {
  // --- CLEANED-UP TRANSCRIPT MODE ---
  // Same timestamped layout as raw mode; translate just the text portion.
  if (isTranscriptCleanedUp && currentEnhancedTranscript) {
    if (!currentEnhancedTranscript.length) return;

    const lang = currentLanguage;
    const entryCachePrefix = `${currentVideoId}:${lang}:cleanupentry:`;

    if (transcriptScrollObserver) {
      transcriptScrollObserver.disconnect();
      transcriptScrollObserver = null;
    }

    const cleanedEntries = currentEnhancedTranscript;
    const originalTexts = cleanedEntries.map((e) => e.text);

    renderCleanedUpTranscript(cleanedEntries);

    const transcriptList = document.getElementById("transcriptList");
    const entries = transcriptList.querySelectorAll(".transcript-entry");

    entries.forEach((entry, index) => {
      entry.dataset.entryIndex = index;

      const cached = transcriptParagraphCache.get(entryCachePrefix + index);
      if (cached) {
        const textSpan = entry.querySelector(".transcript-text");
        if (textSpan) textSpan.innerHTML = renderSubtitleInlineMarkup(cached);
        entry.classList.add("translated");
      } else {
        entry.classList.add("translating");
      }
    });

    const scrollContainer = document.getElementById("contentArea");
    const pendingBatches = new Set();
    const batchQueue = [];
    let isProcessingQueue = false;

    async function processNextBatch() {
      if (isProcessingQueue || batchQueue.length === 0) return;
      if (lang !== lastRequestedLanguage) return;

      isProcessingQueue = true;
      const batch = batchQueue.splice(0, 1);
      await translateEntryBatch(
        batch,
        originalTexts,
        lang,
        entryCachePrefix,
        pendingBatches,
      );
      isProcessingQueue = false;

      if (batchQueue.length > 0) {
        processNextBatch();
      } else {
        updateCache();
      }
    }

    transcriptScrollObserver = new IntersectionObserver(
      (observerEntries) => {
        let addedNew = false;

        observerEntries.forEach((obsEntry) => {
          if (!obsEntry.isIntersecting) return;
          const div = obsEntry.target;
          const index = parseInt(div.dataset.entryIndex);
          if (div.classList.contains("translated")) return;
          if (pendingBatches.has(index)) return;

          batchQueue.push(index);
          pendingBatches.add(index);
          addedNew = true;
        });

        if (addedNew) {
          batchQueue.sort((a, b) => a - b);
          processNextBatch();
        }
      },
      {
        root: scrollContainer,
        rootMargin: "300px 0px",
        threshold: 0,
      },
    );

    entries.forEach((entry) => transcriptScrollObserver.observe(entry));
    return;
  }

  // --- RAW TRANSCRIPT MODE ---
  // Keep the [timestamp] text layout, translate just the text portion of each group
  if (!currentTranscript || !currentTranscript.length) return;

  const lang = currentLanguage;
  const entryCachePrefix = `${currentVideoId}:${lang}:entry:`;

  if (transcriptScrollObserver) {
    transcriptScrollObserver.disconnect();
    transcriptScrollObserver = null;
  }

  // Group entries using the same smart chunking as renderTranscript
  const grouped = groupTranscriptEntries(currentTranscript);

  // Store original texts before we touch the DOM (these are the API translation inputs)
  const originalTexts = grouped.map((g) => g.texts.join(" "));

  // Re-render the raw transcript to get fresh .transcript-entry elements
  renderTranscript();

  // Get all rendered entries and add index + translation state
  const transcriptList = document.getElementById("transcriptList");
  const entries = transcriptList.querySelectorAll(".transcript-entry");

  entries.forEach((entry, index) => {
    entry.dataset.entryIndex = index;

    const cached = transcriptParagraphCache.get(entryCachePrefix + index);
    if (cached) {
      // Replace just the text portion, keep timestamp intact
      const textSpan = entry.querySelector(".transcript-text");
      if (textSpan) textSpan.innerHTML = renderSubtitleInlineMarkup(cached);
      entry.classList.add("translated");
    } else {
      // Mark as pending translation (dimmed with pulsing indicator)
      entry.classList.add("translating");
    }
  });

  // Set up queue-based sequential translation.
  // Instead of firing API calls for ALL visible entries at once (which floods
  // the API and makes everything slow), we queue them and process 5 at a time.
  // This way results appear progressively — first 5 entries translate, then next 5, etc.
  const scrollContainer = document.getElementById("contentArea");
  const pendingBatches = new Set();
  const batchQueue = []; // Queue of entry indices waiting to be translated
  let isProcessingQueue = false;

  // Pulls up to 5 entries from the queue and translates them, then repeats
  async function processNextBatch() {
    if (isProcessingQueue || batchQueue.length === 0) return;
    if (lang !== lastRequestedLanguage) return; // Language changed, abort

    isProcessingQueue = true;
    const batch = batchQueue.splice(0, 1); // Translate 1 entry per API call — fast response
    await translateEntryBatch(
      batch,
      originalTexts,
      lang,
      entryCachePrefix,
      pendingBatches,
    );
    isProcessingQueue = false;

    // If there are more entries queued, process the next batch
    if (batchQueue.length > 0) {
      processNextBatch();
    } else {
      // Queue empty — persist translations to storage so reopening this video is instant
      updateCache();
    }
  }

  transcriptScrollObserver = new IntersectionObserver(
    (observerEntries) => {
      let addedNew = false;

      observerEntries.forEach((obsEntry) => {
        if (!obsEntry.isIntersecting) return;
        const div = obsEntry.target;
        const index = parseInt(div.dataset.entryIndex);
        if (div.classList.contains("translated")) return;
        if (pendingBatches.has(index)) return;

        // Add to queue instead of translating immediately
        batchQueue.push(index);
        pendingBatches.add(index);
        addedNew = true;
      });

      if (addedNew) {
        // Sort so we translate top-to-bottom (natural reading order)
        batchQueue.sort((a, b) => a - b);
        // Kick off processing if not already running
        processNextBatch();
      }
    },
    {
      root: scrollContainer,
      rootMargin: "300px 0px", // 300px ahead for smooth pre-loading
      threshold: 0,
    },
  );

  // Start observing all untranslated entries
  entries.forEach((entry) => {
    if (!entry.classList.contains("translated")) {
      transcriptScrollObserver.observe(entry);
    }
  });
}

/**
 * Translates a batch of raw transcript entries and updates the DOM in-place.
 * Each entry keeps its timestamp — only the text portion gets translated.
 * Uses the same ---PARAGRAPH_BREAK--- delimiter as enhanced mode for consistency.
 *
 * @param {number[]} indices - Array of entry indices to translate
 * @param {string[]} originalTexts - The original text for each entry (from 30-second groups)
 * @param {string} lang - Target language ('zh' or 'ja')
 * @param {string} cachePrefix - Cache key prefix for this video+lang
 * @param {Set} pendingBatches - Set tracking in-flight entry indices
 */
async function translateEntryBatch(
  indices,
  originalTexts,
  lang,
  cachePrefix,
  pendingBatches,
) {
  // Join batch entries with delimiter so we translate them in one API call
  const DELIMITER = "\n\n---PARAGRAPH_BREAK---\n\n";
  const batchText = indices.map((i) => originalTexts[i]).join(DELIMITER);

  setTranslatingSpinner(true);

  try {
    const result = await sendTranslationMessage({
      action: "translateContent",
      content: batchText,
      contentType: "transcript",
      targetLanguage: lang,
      videoTitle: currentVideoTitle,
    });

    // Guard: if user switched language while we were translating, discard result
    if (lang !== lastRequestedLanguage) return;

    if (result.success && result.translatedContent) {
      // Split translated text back into individual entries
      const translatedParts = result.translatedContent.split(
        /---PARAGRAPH_BREAK---/,
      );

      indices.forEach((entryIndex, i) => {
        const translatedText = (translatedParts[i] || "").trim();
        if (!translatedText) return;

        // Cache this entry's translation
        transcriptParagraphCache.set(cachePrefix + entryIndex, translatedText);

        // Update the DOM: replace text span content, keep timestamp
        const entry = document.querySelector(
          `.transcript-entry[data-entry-index="${entryIndex}"]`,
        );
        if (entry) {
          const textSpan = entry.querySelector(".transcript-text");
          if (textSpan) {
            textSpan.innerHTML = renderSubtitleInlineMarkup(translatedText);
          }
          entry.classList.remove("translating");
          entry.classList.add("translated");

          // Stop observing — this entry is done
          if (transcriptScrollObserver) {
            transcriptScrollObserver.unobserve(entry);
          }
        }
      });

      // Update the full transcript cache for instant tab-switching
      updateFullTranscriptCache(lang);
    } else {
      console.error(
        "[YT Digest] Entry batch translation failed:",
        result.error,
      );
    }
  } catch (error) {
    console.error("[YT Digest] Entry batch translation error:", error);
  } finally {
    indices.forEach((i) => pendingBatches.delete(i));
    setTranslatingSpinner(false);
  }
}

/**
 * Translates a batch of paragraphs and updates the DOM as each batch returns.
 *
 * @param {number[]} indices - Array of paragraph indices to translate
 * @param {string[]} paragraphs - The full array of source paragraphs
 * @param {string} lang - Target language ('zh' or 'ja')
 * @param {string} cachePrefix - Cache key prefix for this video+lang
 * @param {Set} pendingBatches - Set tracking in-flight paragraph indices
 */
async function translateParagraphBatch(
  indices,
  paragraphs,
  lang,
  cachePrefix,
  pendingBatches,
) {
  // Combine the batch paragraphs into one string separated by a unique delimiter
  // The API translates them as one block, then we split them back apart
  const DELIMITER = "\n\n---PARAGRAPH_BREAK---\n\n";
  const batchText = indices.map((i) => paragraphs[i].trim()).join(DELIMITER);

  setTranslatingSpinner(true);

  try {
    const result = await sendTranslationMessage({
      action: "translateContent",
      content: batchText,
      contentType: "transcript",
      targetLanguage: lang,
      videoTitle: currentVideoTitle,
    });

    // Guard: if user switched language while translating, discard
    if (lang !== lastRequestedLanguage) return;

    if (result.success && result.translatedContent) {
      // Split the translated text back into individual paragraphs
      const translatedParts = result.translatedContent.split(
        /---PARAGRAPH_BREAK---/,
      );

      indices.forEach((paraIndex, i) => {
        const translatedText = (translatedParts[i] || "").trim();
        if (!translatedText) return;

        // Cache the translated paragraph
        transcriptParagraphCache.set(cachePrefix + paraIndex, translatedText);

        // Update the DOM element
        const div = document.querySelector(
          `.transcript-paragraph[data-para-index="${paraIndex}"]`,
        );
        if (div) {
          div.textContent = translatedText;
          div.classList.remove("translating");
          div.classList.add("translated");

          // Stop observing this paragraph (it's done)
          if (transcriptScrollObserver) {
            transcriptScrollObserver.unobserve(div);
          }
        }
      });

      // Also update the full transcript cache so switching back and forth is instant
      updateFullTranscriptCache(lang);
    } else {
      console.error(
        "[YT Digest] Paragraph batch translation failed:",
        result.error,
      );
    }
  } catch (error) {
    console.error("[YT Digest] Paragraph batch translation error:", error);
  } finally {
    // Remove from pending set
    indices.forEach((i) => pendingBatches.delete(i));
    setTranslatingSpinner(false);
  }
}

/**
 * Rebuilds the full transcript translation cache from individual caches.
 * For raw transcripts: uses per-entry cache (entry:N keys)
 * For enhanced transcripts: uses per-paragraph cache (para:N keys)
 * Called after each batch completes so switching languages/tabs is instant.
 *
 * @param {string} lang - The target language
 */
function updateFullTranscriptCache(lang) {
  const fullCacheKey = `${currentVideoId}:${lang}:transcript`;

  if (!isTranscriptCleanedUp && currentTranscript) {
    // Raw transcript mode: collect per-entry translations
    const entryPrefix = `${currentVideoId}:${lang}:entry:`;
    const translatedEntries = [];
    let index = 0;
    while (transcriptParagraphCache.has(entryPrefix + index)) {
      translatedEntries.push(transcriptParagraphCache.get(entryPrefix + index));
      index++;
    }
    if (translatedEntries.length > 0) {
      // Store as JSON with type marker so renderTranslatedTranscript knows the format
      translationCache.set(
        fullCacheKey,
        JSON.stringify({ type: "entries", entries: translatedEntries }),
      );
    }
  } else if (isTranscriptCleanedUp && currentEnhancedTranscript) {
    // Cleaned-up transcript mode: collect per-entry translations
    const entryPrefix = `${currentVideoId}:${lang}:cleanupentry:`;
    const translatedEntries = [];
    let index = 0;
    while (transcriptParagraphCache.has(entryPrefix + index)) {
      translatedEntries.push(transcriptParagraphCache.get(entryPrefix + index));
      index++;
    }
    if (translatedEntries.length > 0) {
      translationCache.set(
        fullCacheKey,
        JSON.stringify({ type: "entries", entries: translatedEntries }),
      );
    }
  }
}

/**
 * Translates the overview tab content (chapters and key quotes).
 * Sends the relevant analysis fields as JSON and gets back translated JSON.
 */
async function translateOverview() {
  if (!currentAnalysis) return;

  const lang = currentLanguage;
  const cacheKey = `${currentVideoId}:${lang}:overview`;

  setTranslatingSpinner(true);

  try {
    // Build a JSON payload with just the translatable fields
    const overviewPayload = {
      chapters: (currentAnalysis.chapters || []).map((ch) => ({
        title: ch.title,
        summary: ch.summary || "",
        timestamp: ch.timestamp,
        timestampSeconds: ch.timestampSeconds,
      })),
      keyQuotes: (currentAnalysis.keyQuotes || []).map((q) => ({
        quote: q.quote,
        timestamp: q.timestamp,
        timestampSeconds: q.timestampSeconds,
      })),
    };

    const result = await sendTranslationMessage({
      action: "translateContent",
      content: overviewPayload,
      contentType: "overview",
      targetLanguage: lang,
      videoTitle: currentVideoTitle,
    });

    if (lang !== lastRequestedLanguage) return;

    const normalized = YTD_SETTINGS.normalizeTranslatedOverview(
      result.translatedContent,
      overviewPayload,
    );
    if (result.success && normalized) {
      translationCache.set(cacheKey, normalized);
      renderTranslatedContent("overview", normalized);
      await updateCache(); // Persist translation to storage
    } else {
      console.error(
        "[YT Digest] Overview translation failed:",
        result.error || "Unexpected translated overview structure",
      );
    }
  } catch (error) {
    console.error("[YT Digest] Overview translation error:", error);
  } finally {
    setTranslatingSpinner(false);
  }
}

/**
 * Renders translated content into the appropriate tab.
 * This is the "display" step — it takes translated data and puts it on screen.
 *
 * @param {string} tabName - Which tab to render into
 * @param {*} translatedContent - The translated content (string or object depending on tab)
 */
function renderTranslatedContent(tabName, translatedContent) {
  switch (tabName) {
    case "transcript":
      renderTranslatedTranscript(translatedContent);
      break;
    case "overview":
      renderTranslatedOverview(translatedContent);
      break;
  }
}

/**
 * Renders a fully translated transcript from cache.
 * Handles two formats:
 * - Raw transcript: renders with timestamp layout (.transcript-entry) — timestamps preserved
 * - Enhanced transcript: renders as paragraphs (.transcript-paragraph)
 *
 * @param {string} translatedData - Cached translation (JSON for raw, plain text for enhanced)
 */
function renderTranslatedTranscript(translatedData) {
  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  // Try to parse as structured data (raw transcript mode stores as JSON with type marker)
  let parsed = null;
  if (typeof translatedData === "string") {
    try {
      const obj = JSON.parse(translatedData);
      if (obj && obj.type === "entries") {
        parsed = obj;
      }
    } catch (e) {
      // Not JSON — it's an enhanced transcript (plain text)
    }
  }

  // Raw or cleaned-up transcript mode: render with timestamps
  if (
    parsed &&
    parsed.type === "entries" &&
    ((currentTranscript && currentTranscript.length) ||
      (currentEnhancedTranscript && currentEnhancedTranscript.length))
  ) {
    // Use cleaned-up entries when toggle is on, otherwise raw grouped entries
    const entries = isTranscriptCleanedUp
      ? currentEnhancedTranscript
      : groupTranscriptEntries(currentTranscript);

    entries.forEach((entry, index) => {
      const div = document.createElement("div");
      div.className = "transcript-entry translated";
      div.dataset.seconds = entry.start;
      div.dataset.entryIndex = index;

      const minutes = Math.floor(entry.start / 60);
      const seconds = entry.start % 60;
      const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

      // Use translated text if available, fall back to original
      const originalText = isTranscriptCleanedUp
        ? entry.text
        : entry.texts.join(" ");
      const translatedText = parsed.entries[index] || originalText;

      div.innerHTML = `
        <span class="transcript-time">${timestamp}</span>
        <span class="transcript-text">${renderSubtitleInlineMarkup(translatedText)}</span>
      `;

      div.addEventListener("click", (event) =>
        seekFromTranscriptEntryClick(event, entry.start),
      );
      transcriptList.appendChild(div);
    });

    return;
  }

  // Fallback: render as plain paragraphs
  const text = typeof translatedData === "string" ? translatedData : "";
  const paragraphs = text.split(/\n\n+/);

  paragraphs.forEach((para) => {
    if (!para.trim()) return;

    const div = document.createElement("div");
    div.className = "transcript-paragraph translated";
    div.textContent = para.trim();
    transcriptList.appendChild(div);
  });
}

/**
 * Renders translated overview content.
 * Merges translated text fields with original timestamps/structure.
 *
 * @param {Object} translatedOverview - Object with chapters and keyQuotes
 */
function renderTranslatedOverview(translatedOverview) {
  const normalized = YTD_SETTINGS.normalizeTranslatedOverview(
    translatedOverview,
    currentAnalysis,
  );
  if (!normalized) {
    console.error(
      "[YT Digest] Ignoring malformed translated overview from cache",
    );
    renderAnalysisResults(currentAnalysis || {});
    return;
  }

  // Chapters — use translated title/summary but keep original timestamps
  if (normalized.chapters.length) {
    const chapterList = document.getElementById("chapterList");
    chapterList.innerHTML = "";

    normalized.chapters.forEach((chapter, index) => {
      // Grab the original timestamp data (fallback to translated data if same structure)
      const origChapter = currentAnalysis?.chapters?.[index] || chapter;
      const li = document.createElement("li");
      li.className = "chapter-item";
      li.dataset.seconds =
        origChapter.timestampSeconds || chapter.timestampSeconds;
      li.innerHTML = `
        <span class="chapter-timestamp">${escapeHtml(origChapter.timestamp || chapter.timestamp)}</span>
        <div class="chapter-content">
          <span class="chapter-title">${escapeHtml(chapter.title)}</span>
          <span class="chapter-summary">${escapeHtml(chapter.summary || "")}</span>
        </div>
      `;
      li.addEventListener("click", () => {
        seekTo(origChapter.timestampSeconds || chapter.timestampSeconds);
      });
      chapterList.appendChild(li);
    });
  }

  // Key Quotes — use translated quote text but keep original timestamps
  if (normalized.keyQuotes.length) {
    const quotesList = document.getElementById("quotesList");
    quotesList.innerHTML = "";

    const sorted = [...normalized.keyQuotes].sort(
      (a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0),
    );

    sorted.forEach((quote, index) => {
      const origQuote = currentAnalysis?.keyQuotes?.[index] || quote;
      const div = document.createElement("div");
      div.className = "quote-item";
      div.dataset.seconds = origQuote.timestampSeconds || quote.timestampSeconds;
      div.innerHTML = `
        <div class="quote-text">${escapeHtml(quote.quote)}</div>
        <div class="quote-meta">
          <span class="quote-timestamp">${escapeHtml(origQuote.timestamp || quote.timestamp)}</span>
          <button class="quote-copy-btn" title="Copy this quote">⧉ Copy</button>
        </div>
      `;
      div.addEventListener("click", () => {
        seekTo(origQuote.timestampSeconds || quote.timestampSeconds);
      });

      const quoteCopyBtn = div.querySelector(".quote-copy-btn");
      quoteCopyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(quote.quote);
          quoteCopyBtn.textContent = "✓ Copied";
          setTimeout(() => {
            quoteCopyBtn.textContent = "⧉ Copy";
          }, 1500);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

      quotesList.appendChild(div);
    });
  }
}

/**
 * Clears translation cache entries for a specific content type.
 * Called when content changes (e.g., after enhancing transcript).
 *
 * @param {string} contentType - 'transcript' or 'overview'
 */
function clearTranslationCacheForType(contentType) {
  // Delete all cache entries that match this content type
  for (const key of translationCache.keys()) {
    if (key.endsWith(`:${contentType}`)) {
      translationCache.delete(key);
    }
  }

  // If clearing transcript, also clear the per-paragraph cache
  if (contentType === "transcript") {
    transcriptParagraphCache.clear();
  }
}

// ============================================================
// TRANSCRIPT MODE UI — Original / Chinese / aligned bilingual
// ============================================================

function getOriginalTranscriptLabel() {
  const language = String(currentTranscriptLanguage || "").trim();
  return /^[A-Za-z0-9-]{1,20}$/.test(language)
    ? `Original (${language})`
    : "Original";
}

function getActiveTranscriptSegments() {
  if (isTranscriptCleanedUp && Array.isArray(currentEnhancedTranscript)) {
    return currentEnhancedTranscript
      .map((entry, index) => {
        const start = Number(entry?.start) || 0;
        const text = normalizeCaptionText(entry?.text);
        return {
          id: `clean-${index}-${Math.round(start * 1000)}`,
          start,
          text,
        };
      })
      .filter((entry) => entry.text);
  }
  return groupTranscriptEntries(currentTranscript || []);
}

function transcriptTranslationCacheKey(segment) {
  const sourceMode = isTranscriptCleanedUp ? "clean" : "semantic";
  return `${currentVideoId}:zh:${sourceMode}:${segment.id}`;
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
  currentLanguage = mode === "original" ? "en" : "zh";
  lastRequestedLanguage = currentLanguage;
  translationGeneration += 1;
  translationWorkCount = 0;
  setTranslatingSpinner(false);
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
  transcriptScrollObserver = null;
  setTranscriptModeButtons(mode);

  if (mode === "original") {
    if (isTranscriptCleanedUp && currentEnhancedTranscript) {
      renderCleanedUpTranscript(currentEnhancedTranscript);
    } else {
      renderTranscript();
    }
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
    translationHtml = `${escapeHtml(error)}<button class="translation-retry-btn" type="button">Retry</button>`;
  } else {
    translationHtml = "Waiting for translation…";
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
      ? `${originalLabel} + 简体中文`
      : `简体中文 · translated from ${originalLabel}`;
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> From video subtitles · ${modeLabel}`;
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
    `;
    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, segment.start),
    );
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
    error: translatedById.has(segment.id) ? "" : "Translation unavailable.",
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
      mode !== currentTranscriptMode ||
      lastRequestedLanguage !== "zh";
    if (isStale) return;

    const responseSegments = result?.success
      ? result.translatedContent?.segments
      : [];
    const aligned = alignTranslatedSegmentBatch(sourceBatch, responseSegments);
    aligned.forEach((item, batchIndex) => {
      if (!result?.success) {
        item.error = result?.error || "Translation failed.";
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
        { id: segment.id, text: "", error: error.message || "Translation failed." },
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
      translation.textContent = "Retrying…";
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
  currentLanguage = "zh";
  lastRequestedLanguage = "zh";
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();

  const rows = renderTranscriptModeRows(segments, mode);
  const queue = [];
  const queued = new Set();
  let processing = false;

  const processNext = async () => {
    if (processing || queue.length === 0 || generation !== translationGeneration)
      return;
    processing = true;
    const indices = queue.splice(0, 3);
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
  isTranslating = translationWorkCount > 0;
  const spinner = document.getElementById("langSpinner");
  if (spinner) spinner.classList.toggle("visible", isTranslating);
}

/**
 * Shows a cost estimate tooltip when hovering the Clean up toggle.
 * Estimate: ~1.5 tokens per word for input + output combined.
 * DeepSeek-V3 list price: ~$0.14 / $0.28 per 1M tokens (input/output).
 * We use the cached word count from the current transcript text.
 */
function setupCleanupToggleTooltip() {
  const btn = document.getElementById("enhanceBtn");
  if (!btn) return;

  let tooltip = document.getElementById("cleanupTooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "cleanupTooltip";
    tooltip.className = "cleanup-tooltip";
    btn.appendChild(tooltip);
  }

  function updateTooltip() {
    const wordCount = (currentTranscriptText || "").trim().split(/\s+/).filter(
      (w) => w.length > 0,
    ).length;
    const estimatedTokens = Math.ceil(wordCount * 1.5);
    const estimatedCost = (estimatedTokens / 1_000_000) * 0.42; // blended $0.42 per 1M tokens
    tooltip.textContent = `~${estimatedTokens.toLocaleString()} tokens · est. $${estimatedCost.toFixed(4)}`;
  }

  btn.addEventListener("mouseenter", () => {
    updateTooltip();
    tooltip.classList.add("visible");
  });

  btn.addEventListener("mouseleave", () => {
    tooltip.classList.remove("visible");
  });
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

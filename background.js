/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Reading native YouTube subtitle tracks directly from the active player
 * 3. Calling the loopback-only Codex bridge for language features
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults plus the generated local capability token. The token
// protects a loopback service; it is not an external provider or API key.
importScripts("platforms.js");
importScripts("settings.js");
importScripts("bridge-config.js");
importScripts("question-answer.js");

const DEBUG = false;
const AI_PROVIDER_HARD_TIMEOUT_MS = 185_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CREATOR_WORKSPACE_HANDOFF_TIMEOUT_MS = 15_000;
const CREATOR_WORKSPACE_HANDOFF_MAX_RESPONSE_BYTES = 64 * 1024;
const BILIBILI_SUBTITLE_TIMEOUT_MS = 15_000;
const BILIBILI_SUBTITLE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Prevent the YouTube content script from reading the local bridge capability
// token or cached data.
// Side panel, options, and service-worker contexts remain trusted.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[YouTube Digest] Could not restrict storage access:", error),
  );

async function getSettings() {
  return YTD_SETTINGS.normalize();
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
}) {
  const settings = await getSettings();
  const bridge = globalThis.YTD_LOCAL_BRIDGE;
  if (!bridge?.baseUrl || !bridge?.token) {
    const error = new Error("Local Codex bridge configuration is missing.");
    error.code = "BRIDGE_CONFIG_MISSING";
    throw error;
  }
  const body = {
    messages,
    maxTokens,
    responseFormat,
  };
  if (typeof temperature === "number") body.temperature = temperature;

  const controller = new AbortController();
  const hardTimeoutId = setTimeout(
    () => controller.abort(),
    AI_PROVIDER_HARD_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`${bridge.baseUrl}/v1/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-YouTube-Digest-Token": bridge.token,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (new TextEncoder().encode(responseText).byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("Local Codex response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error("Local Codex bridge returned an invalid response.");
    }
    if (!response.ok) {
      const error = new Error(data.error || `Local Codex error: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const text = data.text;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("Local Codex returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }
    return { text, settings };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(
        "Local Codex request exceeded the 185-second limit. Please Retry.",
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(hardTimeoutId);
  }
}

async function checkLocalBridge() {
  const bridge = globalThis.YTD_LOCAL_BRIDGE;
  if (!bridge?.baseUrl) return false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`${bridge.baseUrl}/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.ok === true && data?.provider === "codex-local";
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sendLearningPackToCreatorWorkspace(pack) {
  const bridge = globalThis.YTD_LOCAL_BRIDGE;
  if (!bridge?.baseUrl || !bridge?.token) {
    return { success: false, error: "Local Codex bridge configuration is missing." };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    CREATOR_WORKSPACE_HANDOFF_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`${bridge.baseUrl}/v1/handoff`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-YouTube-Digest-Token": bridge.token,
      },
      body: JSON.stringify(pack),
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (
      new TextEncoder().encode(responseText).byteLength >
      CREATOR_WORKSPACE_HANDOFF_MAX_RESPONSE_BYTES
    ) {
      throw new Error("Local Creator Workspace response was too large.");
    }
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error("Local Creator Workspace returned an invalid response.");
    }
    if (!response.ok || data?.ok !== true) {
      throw new Error(
        data?.error || `Creator Workspace handoff failed: ${response.status}`,
      );
    }
    return { success: true, receipt: data.receipt };
  } catch (error) {
    return {
      success: false,
      error:
        error?.name === "AbortError"
          ? "Creator Workspace handoff timed out after 15 seconds."
          : error?.message || "Creator Workspace handoff failed.",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.action.onClicked.addListener((tab) => {
  // Re-enable + open without awaiting — preserves user gesture context
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
});

/**
 * Allow the side panel to open on any page, but it's designed for YouTube.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel scoped to supported YouTube and Bilibili video tabs.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. To make YouTube Digest behave like a YouTube-only tool, we
 * enable the panel on YouTube tabs and disable it everywhere else. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 * The original code only handled onUpdated, which is why the panel stayed
 * visible when switching to an already-loaded non-YouTube tab.
 */
function updatePanelForTab(tabId, url) {
  const isSupportedVideo = YTD_PLATFORMS.isSupportedVideoUrl(url || "");
  // setOptions can reject if the tab just closed — ignore that harmlessly.
  chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: isSupportedVideo })
    .catch(() => {});
}

// A tab navigated to a new URL.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return; // ignore title/favicon-only updates
  updatePanelForTab(tabId, changeInfo.url);
});

// The user switched to a different tab (or opened a new one).
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updatePanelForTab(tabId, tab.url);
  } catch (e) {
    // Tab vanished before we could read it — nothing to do.
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "fetchTranscript") {
    handleFetchTranscript({
      platform: message.platform || "youtube",
      videoId: message.videoId,
      pageNumber: message.pageNumber,
      tabId: message.tabId,
    })
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep the message channel open for async response
  }

  if (message.action === "analyzeTranscript") {
    // Pass video duration to help the AI validate timestamps
    handleAnalyzeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
      message.videoDuration,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using the local Codex bridge.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "askContextQuestion") {
    handleContextQuestion(message.request)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "saveQuestionAnswerNote") {
    handleSaveQuestionAnswerNote(message.request, message.answer)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    // Save a note at the current timestamp
    handleSaveNote(
      {
        platform: message.platform || "youtube",
        videoId: message.videoId,
        pageNumber: message.pageNumber,
        tabId: message.tabId,
      },
      message.timestamp,
      message.videoTitle,
      message.channelName,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.videoId, message.platform, message.pageNumber)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "sendLearningPack") {
    sendLearningPackToCreatorWorkspace(message.pack)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getVideoInfo") {
    handleGetVideoInfo(message.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Translation: send content to the loopback-only Codex bridge.
  if (message.action === "translateContent") {
    handleTranslateContent(
      message.content,
      message.contentType,
      message.targetLanguage,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    checkLocalBridge()
      .then((bridgeOnline) =>
        sendResponse({
          transcriptReady: true,
          aiReady: bridgeOnline,
          bridgeOnline,
          hasSupadataKey: true,
          hasAiKey: bridgeOnline,
        }),
      )
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    debugLog("[YouTube Digest BG] openSidePanel requested from tab:", tabId);

    // Re-enable the panel (it may have been disabled by auto-close) and open it.
    // IMPORTANT: we call setOptions + open synchronously (no await between them)
    // to preserve the user gesture context. Chrome requires sidePanel.open()
    // to be called within a user gesture — awaiting anything first can expire it.
    if (tabId) {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel.html",
        enabled: true,
      });
      chrome.sidePanel
        .open({ tabId })
        .then(() => {
          // Broadcast to side panel to start digest (in case it's already open)
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startDigestFromButton" })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.error("[YouTube Digest BG] openSidePanel error:", err);
        });
    } else {
      // Fallback: find the active tab
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then((tabs) => {
          if (tabs[0]) {
            chrome.sidePanel.setOptions({
              tabId: tabs[0].id,
              path: "sidepanel.html",
              enabled: true,
            });
            chrome.sidePanel.open({ tabId: tabs[0].id }).catch((err) => {
              console.error(
                "[YouTube Digest BG] openSidePanel fallback error:",
                err,
              );
            });
          }
        });
    }

    sendResponse({ success: true });
    return false;
  }

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[YouTube Digest BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        let tabs = [];
        if (Number.isInteger(message.tabId)) {
          try {
            const requestedTab = await chrome.tabs.get(message.tabId);
            if (YTD_PLATFORMS.isSupportedVideoUrl(requestedTab?.url || "")) {
              tabs = [requestedTab];
            }
          } catch {}
        }
        if (!tabs.length) tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        debugLog(
          "[YouTube Digest BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        if (!tabs[0] || !YTD_PLATFORMS.isSupportedVideoUrl(tabs[0].url || "")) {
          const activeTabs = await chrome.tabs.query({ active: true });
          tabs = activeTabs.filter((tab) =>
            YTD_PLATFORMS.isSupportedVideoUrl(tab.url || ""),
          );
        }

        if (!tabs[0]) {
          const supportedTabs = await Promise.all([
            chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
            chrome.tabs.query({ url: "https://www.bilibili.com/video/*" }),
          ]);
          tabs = supportedTabs.flat();
        }

        if (tabs[0]) {
          debugLog(
            "[YouTube Digest BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response = await chrome.tabs.sendMessage(
            tabs[0].id,
            message.payload,
          );

          // For getVideoInfo, PREFER YouTube's own player data over the
          // DOM scrape. The player's videoDetails is canonical: its `author`
          // is always THIS video's channel and its `shortDescription` is the
          // full text. The DOM scrape is unreliable — e.g. on a playlist page
          // it grabbed the playlist owner's name ("Zara Zhang") instead of the
          // real channel ("Replit and Stripe"), and its description is
          // truncated while the box is collapsed. We fall back to the DOM
          // only for fields the player didn't provide.
          const source = YTD_PLATFORMS.detectVideoSource(tabs[0].url || "");
          if (
            message.payload?.action === "getVideoInfo" &&
            source?.platform === "youtube"
          ) {
            const playerInfo = await getPlayerVideoDetails(tabs[0].id);
            if (playerInfo) {
              response = {
                title: playerInfo.title || response?.title || "",
                channelName:
                  playerInfo.channelName || response?.channelName || "",
                duration: playerInfo.duration || response?.duration || 0,
                description:
                  playerInfo.description || response?.description || "",
              };
            }
          }

          debugLog("[YouTube Digest BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[YouTube Digest BG] No supported video tab found");
          sendResponse({ success: false, error: "No supported video tab found" });
        }
      } catch (err) {
        console.error("[YouTube Digest BG] Relay error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }
});

/**
 * Reads the current video's full details straight from YouTube's player.
 *
 * Content scripts live in an isolated world and can't touch the page's own
 * JavaScript. But with the "scripting" permission we can run a tiny function
 * in the page's MAIN world, where YouTube's player object lives. Its
 * getPlayerResponse() carries videoDetails with the FULL description —
 * unlike the DOM, which truncates it until the user clicks "...more".
 *
 * Returns null on any failure so callers can fall back to DOM scraping.
 */
async function getPlayerVideoDetails(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const player = document.getElementById("movie_player");
          const details = player?.getPlayerResponse?.()?.videoDetails;
          if (!details) return null;
          return {
            title: details.title || "",
            channelName: details.author || "",
            description: details.shortDescription || "",
            duration: Number(details.lengthSeconds) || 0,
          };
        } catch (e) {
          return null;
        }
      },
    });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn("[YouTube Digest BG] Player details unavailable:", e.message);
    return null;
  }
}

// ============================================================
// DIRECT YOUTUBE SUBTITLE EXTRACTION
// ============================================================

async function findYouTubeTabForVideo(videoId) {
  const expected = String(videoId || "");
  const candidates = [];
  const addMatches = (tabs) => {
    for (const tab of tabs || []) {
      try {
        const url = new URL(tab.url || "");
        if (
          url.hostname === "www.youtube.com" &&
          url.pathname === "/watch" &&
          url.searchParams.get("v") === expected &&
          !candidates.some((candidate) => candidate.id === tab.id)
        ) {
          candidates.push(tab);
        }
      } catch {
        // Ignore tabs that changed or closed while being inspected.
      }
    }
  };

  addMatches(
    await chrome.tabs.query({ active: true, lastFocusedWindow: true }),
  );
  if (!candidates.length) {
    addMatches(await chrome.tabs.query({ url: "https://www.youtube.com/watch*" }));
  }
  return candidates[0] || null;
}

async function getCaptionTracksFromPlayer(tabId, videoId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [videoId],
    func: (expectedVideoId) => {
      try {
        const player = document.getElementById("movie_player");
        const response =
          player?.getPlayerResponse?.() || globalThis.ytInitialPlayerResponse;
        if (response?.videoDetails?.videoId !== expectedVideoId) return [];
        const tracks =
          response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (!Array.isArray(tracks)) return [];
        return tracks.slice(0, 100).map((track) => ({
          baseUrl: typeof track.baseUrl === "string" ? track.baseUrl : "",
          languageCode:
            typeof track.languageCode === "string" ? track.languageCode : "",
          kind: typeof track.kind === "string" ? track.kind : "",
          vssId: typeof track.vssId === "string" ? track.vssId : "",
          name:
            track.name?.simpleText ||
            (Array.isArray(track.name?.runs)
              ? track.name.runs.map((run) => run.text || "").join("")
              : ""),
        }));
      } catch {
        return [];
      }
    },
  });
  return Array.isArray(results?.[0]?.result) ? results[0].result : [];
}

/**
 * Fetch a player-provided subtitle URL inside YouTube's MAIN world.
 *
 * Recent YouTube subtitle URLs can depend on the page's signed-in cookies and
 * player request context. A service-worker fetch has a different origin and
 * can therefore receive an empty 200 response even while captions are visibly
 * playing. Keeping this request in the watch page preserves that context.
 */
async function fetchCaptionPayloadInPage(tabId, baseUrl) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [baseUrl],
    func: async (sourceUrl) => {
      const MAX_PAYLOAD_CHARACTERS = 2 * 1024 * 1024;
      try {
        const source = new URL(sourceUrl);
        const allowedHost =
          source.protocol === "https:" &&
          (source.hostname === "www.youtube.com" ||
            source.hostname.endsWith(".youtube.com") ||
            source.hostname.endsWith(".googlevideo.com"));
        if (!allowedHost) {
          return { ok: false, status: 0, error: "Unsupported subtitle URL" };
        }

        const json3 = new URL(source);
        json3.searchParams.set("fmt", "json3");
        const candidates = [...new Set([source.toString(), json3.toString()])];
        let lastStatus = 0;
        for (const candidate of candidates) {
          const response = await fetch(candidate, {
            method: "GET",
            credentials: "include",
            cache: "no-store",
          });
          lastStatus = response.status;
          const payload = await response.text();
          if (payload.length > MAX_PAYLOAD_CHARACTERS) {
            return {
              ok: false,
              status: response.status,
              error: "Subtitle payload exceeded the 2 MiB limit",
            };
          }
          if (response.ok && payload.trim()) {
            return { ok: true, status: response.status, payload };
          }
        }
        return {
          ok: false,
          status: lastStatus,
          error: "YouTube returned an empty subtitle response",
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          error: error?.message || "Subtitle request failed",
        };
      }
    },
  });
  return results?.[0]?.result || {
    ok: false,
    status: 0,
    error: "YouTube page did not return subtitle data",
  };
}

/**
 * Last-resort fallback: ask YouTube to open its own transcript panel and read
 * the timestamped rows that YouTube renders. This uses only the active watch
 * page and closes the panel again when this function opened it.
 */
async function getTranscriptRowsFromYouTubePanel(tabId, videoId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [videoId],
    func: async (expectedVideoId) => {
      const sleep = (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds));
      const parseTimestamp = (value) => {
        const parts = String(value || "")
          .trim()
          .split(":")
          .map((part) => Number(part));
        if (!parts.length || parts.some((part) => !Number.isFinite(part))) {
          return null;
        }
        return parts.reduce((total, part) => total * 60 + part, 0);
      };
      const collectRows = () =>
        [...document.querySelectorAll("ytd-transcript-segment-renderer")]
          .map((segment) => {
            const timestamp =
              segment.querySelector(".segment-timestamp")?.textContent || "";
            const start = parseTimestamp(timestamp);
            const text =
              segment.querySelector(".segment-text")?.textContent?.replace(/\s+/g, " ").trim() ||
              "";
            return start === null || !text ? null : { start, text };
          })
          .filter(Boolean)
          .slice(0, 50_000);

      try {
        if (new URL(location.href).searchParams.get("v") !== expectedVideoId) {
          return { ok: false, rows: [], error: "Active video changed" };
        }
        let rows = collectRows();
        if (rows.length) return { ok: true, rows };

        const expand =
          document.querySelector("ytd-watch-metadata #description #expand") ||
          document.querySelector("ytd-text-inline-expander #expand");
        if (expand instanceof HTMLElement) {
          expand.click();
          await sleep(300);
        }

        const panelBefore = document.querySelector(
          'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]',
        );
        const panelWasVisible =
          panelBefore?.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
        const transcriptButton =
          document.querySelector(
            "ytd-video-description-transcript-section-renderer button",
          ) ||
          document.querySelector(
            "ytd-video-description-transcript-section-renderer tp-yt-paper-button",
          );
        if (transcriptButton instanceof HTMLElement) transcriptButton.click();

        for (let attempt = 0; attempt < 50; attempt += 1) {
          await sleep(100);
          rows = collectRows();
          if (rows.length) break;
        }

        if (rows.length && !panelWasVisible) {
          const panel = document.querySelector(
            'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]',
          );
          const closeButton =
            panel?.querySelector("#visibility-button button") ||
            panel?.querySelector('button[aria-label*="Close" i]');
          if (closeButton instanceof HTMLElement) closeButton.click();
        }
        return rows.length
          ? { ok: true, rows }
          : { ok: false, rows: [], error: "YouTube transcript panel was unavailable" };
      } catch (error) {
        return {
          ok: false,
          rows: [],
          error: error?.message || "Could not read YouTube transcript panel",
        };
      }
    },
  });
  return results?.[0]?.result || {
    ok: false,
    rows: [],
    error: "YouTube transcript panel returned no data",
  };
}

function selectCaptionTrack(tracks) {
  const scored = (Array.isArray(tracks) ? tracks : [])
    .filter((track) => typeof track?.baseUrl === "string" && track.baseUrl)
    .map((track, index) => {
      const language = String(track.languageCode || "").toLowerCase();
      const englishScore = language === "en" ? 100 : language.startsWith("en-") ? 90 : 0;
      const humanScore = track.kind === "asr" ? 0 : 10;
      return { track, index, score: englishScore + humanScore };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return scored[0]?.track || null;
}

function cleanCaptionText(text) {
  return String(text || "")
    .replace(/>> ?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_, value) =>
      String.fromCodePoint(Number.parseInt(value, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseYouTubeJson3(data, language) {
  const transcript = [];
  for (const event of Array.isArray(data?.events) ? data.events : []) {
    if (!Array.isArray(event?.segs)) continue;
    const text = cleanCaptionText(
      event.segs.map((segment) => segment?.utf8 || "").join(""),
    );
    if (!text) continue;
    transcript.push({
      text,
      start: Math.max(0, Number(event.tStartMs) || 0) / 1000,
      duration: Math.max(0, Number(event.dDurationMs) || 0) / 1000,
      language: language || null,
    });
  }
  return transcript;
}

function parseXmlAttributes(source) {
  const attributes = {};
  for (const match of String(source || "").matchAll(/([A-Za-z]+)="([^"]*)"/g)) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

function parseYouTubeXml(payload, language) {
  const transcript = [];
  const legacy = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  for (const match of payload.matchAll(legacy)) {
    const attributes = parseXmlAttributes(match[1]);
    const text = cleanCaptionText(decodeXmlEntities(match[2].replace(/<[^>]+>/g, "")));
    if (!text) continue;
    transcript.push({
      text,
      start: Math.max(0, Number(attributes.start) || 0),
      duration: Math.max(0, Number(attributes.dur) || 0),
      language: language || null,
    });
  }
  if (transcript.length) return transcript;

  const srv3 = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  for (const match of payload.matchAll(srv3)) {
    const attributes = parseXmlAttributes(match[1]);
    const text = cleanCaptionText(decodeXmlEntities(match[2].replace(/<[^>]+>/g, "")));
    if (!text) continue;
    transcript.push({
      text,
      start: Math.max(0, Number(attributes.t) || 0) / 1000,
      duration: Math.max(0, Number(attributes.d) || 0) / 1000,
      language: language || null,
    });
  }
  return transcript;
}

function parseYouTubeCaptionPayload(payload, language) {
  const text = String(payload || "").trim();
  if (!text) return [];
  if (text.startsWith("{")) {
    return parseYouTubeJson3(JSON.parse(text), language);
  }
  return parseYouTubeXml(text, language);
}

function buildTranscriptResult(transcript, language) {
  const safeTranscript = (Array.isArray(transcript) ? transcript : [])
    .filter((item) => item?.text && Number.isFinite(Number(item.start)))
    .slice(0, 50_000)
    .sort((left, right) => Number(left.start) - Number(right.start));
  const transcriptText = safeTranscript.map((item) => item.text).join(" ");
  const transcriptTextTimestamped = safeTranscript
    .map((item) => {
      const seconds = Math.max(0, Math.floor(Number(item.start) || 0));
      const minutes = Math.floor(seconds / 60);
      const remainder = seconds % 60;
      return `[${minutes}:${String(remainder).padStart(2, "0")}] ${item.text}`;
    })
    .join("\n");
  return {
    success: true,
    transcript: safeTranscript,
    transcriptText,
    transcriptTextTimestamped,
    language: language || null,
  };
}

function parseBilibiliSubtitle(data, language) {
  const body = Array.isArray(data?.body) ? data.body : [];
  return body
    .map((entry) => {
      const start = Number(entry?.from);
      const end = Number(entry?.to);
      return {
        text: cleanCaptionText(entry?.content),
        start: Number.isFinite(start) ? Math.max(0, start) : 0,
        duration:
          Number.isFinite(start) && Number.isFinite(end)
            ? Math.max(0, end - start)
            : 0,
        language: language || null,
      };
    })
    .filter((entry) => entry.text);
}

async function findBilibiliTabForVideo(videoId, requestedTabId) {
  const matches = (tab) => {
    const source = YTD_PLATFORMS.detectVideoSource(tab?.url || "");
    return source?.platform === "bilibili" && source.videoId === videoId;
  };
  if (Number.isInteger(requestedTabId)) {
    try {
      const requested = await chrome.tabs.get(requestedTabId);
      if (matches(requested)) return requested;
    } catch {}
  }
  const tabs = await chrome.tabs.query({ url: "https://www.bilibili.com/video/*" });
  return tabs.find(matches) || null;
}

function normalizeBilibiliSubtitleUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let subtitleUrl;
  try {
    subtitleUrl = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  } catch {
    return null;
  }
  const allowedHost =
    subtitleUrl.hostname === "i0.hdslb.com" ||
    subtitleUrl.hostname.endsWith(".hdslb.com");
  const allowedPath =
    subtitleUrl.pathname.startsWith("/bfs/subtitle/") ||
    subtitleUrl.pathname.startsWith("/bfs/ai_subtitle/");
  return subtitleUrl.protocol === "https:" && allowedHost && allowedPath
    ? subtitleUrl.toString()
    : null;
}

async function fetchBilibiliSubtitlePayload(subtitleUrl) {
  const safeUrl = normalizeBilibiliSubtitleUrl(subtitleUrl);
  if (!safeUrl) {
    throw new Error("Bilibili returned an unsupported subtitle URL");
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    BILIBILI_SUBTITLE_TIMEOUT_MS,
  );
  try {
    // This fetch intentionally runs in the extension service worker. Bilibili's
    // CDN subtitle files do not consistently allow page-origin CORS requests,
    // while the manifest grants this worker access to the tightly validated
    // *.hdslb.com subtitle path above.
    const response = await fetch(safeUrl, {
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Bilibili subtitle download failed (${response.status})`);
    }
    const payloadText = await response.text();
    if (
      new TextEncoder().encode(payloadText).byteLength >
      BILIBILI_SUBTITLE_MAX_RESPONSE_BYTES
    ) {
      throw new Error("Bilibili subtitle response exceeded the 8 MiB limit");
    }
    try {
      return JSON.parse(payloadText);
    } catch {
      throw new Error("Bilibili returned invalid subtitle data");
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Bilibili subtitle download timed out after 15 seconds");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getBilibiliSubtitleTrackFromPage(tabId, videoId, pageNumber) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [videoId, Math.max(1, Math.floor(Number(pageNumber) || 1))],
    func: async (expectedBvid, expectedPage) => {
      const response = {
        ok: false,
        subtitleUrl: null,
        language: null,
        needsLogin: false,
        error: "Bilibili page did not return subtitle data",
      };
      try {
        const urlMatch = location.pathname.match(/^\/video\/(BV[A-Za-z0-9]{10,18})/i);
        if (!urlMatch || urlMatch[1] !== expectedBvid) {
          response.error = "The active Bilibili tab changed videos";
          return response;
        }
        const initial = window.__INITIAL_STATE__?.videoData || {};
        let title = initial.title || "";
        let channelName = initial.owner?.name || "";
        let description = initial.desc || "";
        let duration = Number(initial.duration) || 0;
        let cid =
          initial.pages?.find((item) => Number(item.page) === expectedPage)?.cid ||
          (expectedPage === 1 ? initial.cid : null);
        if (!cid) {
          const metadataResponse = await fetch(
            `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(expectedBvid)}`,
            { credentials: "include", cache: "no-store" },
          );
          const metadata = await metadataResponse.json();
          if (metadata?.code !== 0) throw new Error(metadata?.message || "Video metadata unavailable");
          const video = metadata.data || {};
          cid =
            video.pages?.find((item) => Number(item.page) === expectedPage)?.cid ||
            video.cid;
          title ||= video.title || "";
          channelName ||= video.owner?.name || "";
          description ||= video.desc || "";
          duration ||= Number(video.pages?.find((item) => Number(item.page) === expectedPage)?.duration || video.duration) || 0;
        }
        if (!cid) throw new Error("Bilibili video part ID is unavailable");

        const playInfoCandidates = [
          window.__playinfo__?.data,
          window.__playinfo__,
        ].filter(Boolean);
        let playerData = playInfoCandidates.find(
          (data) => Array.isArray(data?.subtitle?.subtitles) && data.subtitle.subtitles.length,
        );
        if (!playerData) {
          const playerResponse = await fetch(
            `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(expectedBvid)}&cid=${encodeURIComponent(cid)}`,
            { credentials: "include", cache: "no-store" },
          );
          const playerPayload = await playerResponse.json();
          if (playerPayload?.code !== 0) {
            throw new Error(playerPayload?.message || "Player metadata unavailable");
          }
          playerData = playerPayload.data || {};
          response.needsLogin = playerData.need_login_subtitle === true;
        }
        const tracks = Array.isArray(playerData?.subtitle?.subtitles)
          ? playerData.subtitle.subtitles
          : [];
        const preferred = [...tracks].sort((left, right) => {
          const score = (track) => {
            const language = String(track?.lan || "").toLowerCase();
            const name = String(track?.lan_doc || "");
            if (/zh|ai-zh/.test(language)) return /ai|自动|生成/.test(name) ? 2 : 0;
            if (/en/.test(language)) return 3;
            return 4;
          };
          return score(left) - score(right);
        })[0];
        if (!preferred?.subtitle_url) {
          response.error = response.needsLogin
            ? "Bilibili did not expose a subtitle track. Sign in, reload this video, and make sure the player has a CC/字幕 option. Captions baked into the picture cannot be extracted."
            : "This video does not expose a CC/AI subtitle track. Captions baked into the picture cannot be extracted as transcript data.";
          return { ...response, title, channelName, description, duration, cid };
        }
        const subtitleUrl = new URL(
          preferred.subtitle_url.startsWith("//")
            ? `https:${preferred.subtitle_url}`
            : preferred.subtitle_url,
        );
        if (
          !(subtitleUrl.protocol === "https:" &&
            (subtitleUrl.hostname === "i0.hdslb.com" || subtitleUrl.hostname.endsWith(".hdslb.com")))
        ) {
          throw new Error("Bilibili returned an unsupported subtitle host");
        }
        response.ok = true;
        response.language = preferred.lan || preferred.lan_doc || null;
        response.subtitleUrl = subtitleUrl.toString();
        return { ...response, title, channelName, description, duration, cid };
      } catch (error) {
        response.error =
          error?.message === "Failed to fetch"
            ? "Bilibili blocked the signed-in subtitle lookup. Reload the video page and try again."
            : error?.message || response.error;
        return response;
      }
    },
  });
  return results[0]?.result || {
    ok: false,
    subtitleUrl: null,
    error: "Bilibili page returned no subtitle result",
  };
}

async function handleFetchBilibiliTranscript(source) {
  const videoId = YTD_PLATFORMS.cleanVideoId("bilibili", source.videoId);
  const pageNumber = YTD_PLATFORMS.cleanPageNumber(source.pageNumber);
  const tab = await findBilibiliTabForVideo(videoId, source.tabId);
  if (!tab?.id) {
    return {
      success: false,
      error: "VIDEO_TAB_NOT_FOUND",
      message: "Open this video in a standard Bilibili video tab and try again.",
    };
  }
  const pageResult = await getBilibiliSubtitleTrackFromPage(
    tab.id,
    videoId,
    pageNumber,
  );
  if (!pageResult.ok || !pageResult.subtitleUrl) {
    return {
      success: false,
      error: pageResult.needsLogin ? "BILIBILI_LOGIN_REQUIRED" : "NO_TRANSCRIPT",
      message:
        pageResult.error ||
        "Bilibili did not expose an available CC or AI subtitle track.",
    };
  }
  let subtitlePayload;
  try {
    subtitlePayload = await fetchBilibiliSubtitlePayload(pageResult.subtitleUrl);
  } catch (error) {
    return {
      success: false,
      error: "BILIBILI_SUBTITLE_DOWNLOAD_FAILED",
      message:
        error?.message ||
        "Bilibili exposed a subtitle track, but its subtitle file could not be downloaded.",
    };
  }
  const transcript = parseBilibiliSubtitle(
    subtitlePayload,
    pageResult.language,
  );
  if (!transcript.length) {
    return {
      success: false,
      error: "NO_TRANSCRIPT",
      message: "Bilibili returned an empty subtitle track for this video.",
    };
  }
  return {
    ...buildTranscriptResult(transcript, pageResult.language),
    videoInfo: {
      title: pageResult.title || "",
      channelName: pageResult.channelName || "",
      description: pageResult.description || "",
      duration: Number(pageResult.duration) || 0,
      cid: pageResult.cid || null,
    },
  };
}

async function handleFetchYouTubeTranscript(videoId) {
  try {
    YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    const tab = await findYouTubeTabForVideo(videoId);
    if (!tab?.id) {
      return {
        success: false,
        error: "VIDEO_TAB_NOT_FOUND",
        message: "Open this video in a standard YouTube watch tab and try again.",
      };
    }
    const tracks = await getCaptionTracksFromPlayer(tab.id, videoId);
    const track = selectCaptionTrack(tracks);
    if (!track) {
      return {
        success: false,
        error: "NO_TRANSCRIPT",
        message: "This video does not expose an available subtitle track.",
      };
    }
    const pagePayload = await fetchCaptionPayloadInPage(tab.id, track.baseUrl);
    let transcript = pagePayload.ok
      ? parseYouTubeCaptionPayload(pagePayload.payload, track.languageCode)
      : [];
    if (!transcript.length) {
      const panelResult = await getTranscriptRowsFromYouTubePanel(tab.id, videoId);
      if (panelResult.ok) {
        transcript = panelResult.rows.map((row, index, rows) => ({
          text: cleanCaptionText(row.text),
          start: Math.max(0, Number(row.start) || 0),
          duration: Math.max(
            0,
            Number(rows[index + 1]?.start) - Number(row.start) || 0,
          ),
          language: track.languageCode || null,
        }));
      }
    }
    if (!transcript.length) {
      return {
        success: false,
        error: "EMPTY_TRANSCRIPT",
        message:
          "YouTube did not expose transcript data to the page. Confirm captions are available, reload the video tab, and try again.",
      };
    }
    return buildTranscriptResult(transcript, track.languageCode);
  } catch (error) {
    console.error("Transcript fetch error:", error);
    return {
      success: false,
      error: error.message || "Failed to fetch transcript",
      message: error.message || "Failed to fetch transcript",
    };
  }
}

async function handleFetchTranscript(sourceOrVideoId) {
  const source =
    typeof sourceOrVideoId === "string"
      ? { platform: "youtube", videoId: sourceOrVideoId, pageNumber: 1 }
      : sourceOrVideoId || {};
  if (source.platform === "bilibili") {
    return handleFetchBilibiliTranscript(source);
  }
  return handleFetchYouTubeTranscript(source.videoId);
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    // e.g. ["a", "b", ]  ->  ["a", "b" ]
    const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

// ============================================================
// CODEX-LOCAL ANALYSIS
// ============================================================

/**
 * Sends the transcript to the loopback-only Codex bridge for analysis.
 *
 * The prompt asks the model to produce chapters covering the whole video
 * and 3-5 key quotes with timestamps.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
) {
  try {
    const settings = await getSettings();

    // Convert duration to MM:SS format for context
    // The transcript text is already prefixed with [M:SS] markers. Its LAST
    // marker is the most reliable signal of where the content actually ends —
    // more trustworthy than the duration metadata, which is sometimes missing
    // or wrong. We use the larger of (metadata duration, last transcript stamp).
    let lastTranscriptSeconds = 0;
    const stampMatches = transcriptText.match(/\[(\d+):(\d{2})\]/g) || [];
    if (stampMatches.length) {
      const last =
        stampMatches[stampMatches.length - 1].match(/\[(\d+):(\d{2})\]/);
      lastTranscriptSeconds = parseInt(last[1]) * 60 + parseInt(last[2]);
    }

    const effectiveSeconds = Math.max(
      Math.floor(videoDuration || 0),
      lastTranscriptSeconds,
    );
    const durationMinutes = Math.floor(effectiveSeconds / 60);
    const durationSeconds = Math.floor(effectiveSeconds % 60);
    const durationFormatted = `${durationMinutes}:${String(durationSeconds).padStart(2, "0")}`;
    const maxTimestampSeconds = effectiveSeconds;

    // The "last chapter must be after" threshold (75% in) forces the model to
    // cover the WHOLE video instead of front-loading chapters near the start.
    // We do NOT prescribe a chapter count — the model picks the natural splits.
    const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
    const lateThreshold = `${Math.floor(lateThresholdSeconds / 60)}:${String(
      lateThresholdSeconds % 60,
    ).padStart(2, "0")}`;

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "analysis.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.md",
      "User prompt",
      promptVariables,
    );

    debugLog("[YouTube Digest] Requesting video analysis", settings.aiModel);
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 8192,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parse the JSON, tolerating trailing commas / stray prose
    let analysis = parseLooseJson(responseText);

    // Treat every model response as untrusted data. Rebuild the supported
    // schema and derive display timestamps from validated numeric seconds.
    analysis = validateAndFixTimestamps(analysis, maxTimestampSeconds);

    return {
      success: true,
      analysis: analysis,
    };
  } catch (error) {
    console.error("Analysis error:", error);
    if (error.status === 401) {
      return {
        success: false,
        error: "BRIDGE_AUTH_FAILED",
        message: "The local Codex bridge rejected this extension.",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "The local Codex queue is full. Try again shortly.",
      };
    }
    return {
      success: false,
      error: error.message || "Failed to analyze transcript",
    };
  }
}

/**
 * Validates all timestamps in the analysis and fixes any that exceed video duration.
 * This is a safety net to prevent hallucinated timestamps from reaching the UI.
 *
 * @param {Object} analysis - The parsed analysis from Codex
 * @param {number} maxSeconds - Maximum valid timestamp in seconds
 * @returns {Object} - Analysis with validated timestamps
 */
function validateAndFixTimestamps(analysis, maxSeconds) {
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;

  // Helper to format seconds as MM:SS
  const formatTimestamp = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const safeSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      return {
        title,
        summary: safeString(chapter?.summary, 1500),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (
    Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : []
  )
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyMoments = (
    Array.isArray(analysis?.keyMoments) ? analysis.keyMoments : []
  )
    .map(safeSeconds)
    .filter((seconds) => seconds !== null)
    .slice(0, 100);

  return { chapters, keyQuotes, keyMoments };
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Gets video info (title, channel, description) from the active YouTube tab.
 * We do this by asking the content script to read the page.
 */
async function handleGetVideoInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getVideoInfo",
    });
    return response;
  } catch (error) {
    return { title: "", channelName: "", description: "" };
  }
}

// ============================================================
// EXPLAIN SELECTION
// ============================================================

/**
 * Explains selected text using the local Codex bridge.
 * Provides context, definitions, and clarification for complex terms.
 *
 * @param {string} selectedText - The text the user selected
 * @param {string} transcriptContext - Surrounding transcript for context
 * @param {string} videoTitle - Video title for additional context
 * @returns {Object} - { success, explanation } or { success: false, error }
 */
// ============================================================
// NOTE MANAGEMENT
// ============================================================

/**
 * Saves a note at the current timestamp.
 * Fetches the transcript if needed, finds the relevant line, and cleans it up.
 */
async function handleSaveNote(
  sourceInput,
  timestamp,
  videoTitle,
  channelName,
) {
  try {
    const source =
      typeof sourceInput === "string"
        ? { platform: "youtube", videoId: sourceInput, pageNumber: 1 }
        : sourceInput || {};
    const platform = source.platform || "youtube";
    const videoId = YTD_PLATFORMS.cleanVideoId(platform, source.videoId);
    const pageNumber = YTD_PLATFORMS.cleanPageNumber(source.pageNumber);
    const canonicalVideoUrl = YTD_PLATFORMS.canonicalVideoUrl(
      platform,
      videoId,
      pageNumber,
    );
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));

    // First, try to get the transcript from the digest cache. The side panel
    // saves digests to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and
    // refetched the transcript on every saved note.
    let transcript = null;
    try {
      const storageId = YTD_PLATFORMS.storageKey(platform, videoId, pageNumber);
      const cacheKeys = [`digest_${storageId}`];
      if (platform === "youtube") cacheKeys.push(`digest_${videoId}`);
      const cached = await chrome.storage.local.get(cacheKeys);
      const cacheEntry = cacheKeys.map((key) => cached[key]).find(Boolean);
      if (cacheEntry?.transcript) {
        transcript = cacheEntry.transcript;
        debugLog("[YouTube Digest] Using cached transcript for note");
      }
    } catch (e) {
      debugLog("[YouTube Digest] No cached transcript, fetching...");
    }

    // If no cached transcript, fetch it
    if (!transcript) {
      const transcriptResult = await handleFetchTranscript({
        platform,
        videoId,
        pageNumber,
        tabId: source.tabId,
      });
      if (!transcriptResult.success) {
        return { success: false, error: "Could not fetch transcript" };
      }
      transcript = transcriptResult.transcript;
    }

    // Find the transcript line at the current timestamp
    // Look for the line that contains this timestamp (or the closest one before)
    let matchedLine = null;
    let matchedIndex = 0;
    let contextLines = [];
    let beforeLine = null; // a few sentences before
    let afterLine = null; // a few sentences after

    for (let i = 0; i < transcript.length; i++) {
      const line = transcript[i];
      if (
        line.start <= safeTimestamp &&
        (!transcript[i + 1] || transcript[i + 1].start > safeTimestamp)
      ) {
        matchedLine = line;
        matchedIndex = i;

        // Build a buffer of 2 lines before and 4 lines after the target.
        // This gives the model enough text to find a natural sentence boundary
        // and complete a thought that spans multiple short caption chunks.
        const beforeLines = [];
        for (let j = 1; j <= 2 && i - j >= 0; j++) {
          beforeLines.unshift(transcript[i - j].text);
        }
        if (beforeLines.length > 0) {
          beforeLine = beforeLines.join(" ");
        }

        const afterLines = [];
        for (let j = 1; j <= 4 && i + j < transcript.length; j++) {
          afterLines.push(transcript[i + j].text);
        }
        if (afterLines.length > 0) {
          afterLine = afterLines.join(" ");
        }

        // Get broader context (8 lines before and 12 lines after) for understanding
        const startIdx = Math.max(0, i - 8);
        const endIdx = Math.min(transcript.length - 1, i + 12);
        for (let j = startIdx; j <= endIdx; j++) {
          contextLines.push(transcript[j].text);
        }
        break;
      }
    }

    if (!matchedLine) {
      // Fallback: use the last line if timestamp is beyond transcript
      matchedLine = transcript[transcript.length - 1];
      matchedIndex = transcript.length - 1;

      // Get buffer sentence (only before, since we're at the end)
      const beforeLines = [];
      for (let j = 1; j <= 2 && matchedIndex - j >= 0; j++) {
        beforeLines.unshift(transcript[matchedIndex - j].text);
      }
      if (beforeLines.length > 0) {
        beforeLine = beforeLines.join(" ");
      }

      const startIdx = Math.max(0, matchedIndex - 8);
      for (let j = startIdx; j <= matchedIndex; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    // Clean up the text with the local Codex bridge.
    const cleanedText = await cleanupNoteText(
      matchedLine.text,
      beforeLine,
      afterLine,
      contextLines.join(" "),
      videoTitle,
    );

    // Format timestamp as MM:SS
    const minutes = Math.floor(safeTimestamp / 60);
    const seconds = safeTimestamp % 60;
    const formattedTimestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    // Create timestamped URL
    const timestampedUrl = YTD_PLATFORMS.timestampedVideoUrl(
      platform,
      videoId,
      safeTimestamp,
      pageNumber,
    );

    // Create the note object
    const note = {
      id: `note_${Date.now()}`,
      platform,
      videoId: videoId,
      pageNumber,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Video",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: formattedTimestamp,
      timestampSeconds: safeTimestamp,
      timestampedUrl: timestampedUrl,
      text: cleanedText,
      rawText: matchedLine.text,
      createdAt: Date.now(),
    };

    // Save to storage
    await saveNoteToStorage(note);

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    return { success: true, note };
  } catch (error) {
    console.error("[YouTube Digest] Save note error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Cleans up transcript lines using the local Codex bridge.
 * Takes the target line plus buffer sentences (1 before, 1 after).
 * Uses JSON output to prevent any preambles from appearing.
 */
async function cleanupNoteText(
  targetText,
  beforeText,
  afterText,
  fullContext,
  videoTitle,
) {
  try {
    debugLog("[YouTube Digest] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "note-cleanup.md",
      "User prompt",
      variables,
    );
    const { text: resultText } = await requestAiCompletion({
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let result = resultText.trim() || targetText;

    // Parse the JSON response (tolerating trailing commas / fences).
    try {
      const parsed = parseLooseJson(result);
      if (typeof parsed.quote === "string" && parsed.quote.trim()) {
        return parsed.quote.trim().slice(0, 3000);
      }
    } catch (parseError) {
      console.warn(
        "[YouTube Digest] JSON parse failed for note, stripping preambles:",
        parseError,
      );
      result = result.replace(
        /^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i,
        "",
      );
      result = result.replace(
        /^(The cleaned (quote|text|version)( is)?:?\s*)/i,
        "",
      );
      result = result.replace(/^(I will.*?:?\s*)/i, "");
      result = result.replace(/^(Cleaned:?\s*)/i, "");
      result = result.replace(/^["']|["']$/g, "");
    }

    return result.slice(0, 3000);
  } catch (e) {
    console.error("[YouTube Digest] Cleanup error:", e);
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(" ");
}

/**
 * Saves a note to chrome.storage.local
 */
async function saveNoteToStorage(note) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes = result.ytd_notes || [];
  notes.unshift(note); // Add to beginning (newest first)

  // Keep only last 100 notes to prevent storage bloat
  if (notes.length > 100) {
    notes.splice(100);
  }

  await chrome.storage.local.set({ ytd_notes: notes });
}

/**
 * Gets notes from storage, optionally filtered by video ID
 */
async function handleGetNotes(videoId, platform, pageNumber) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];

    if (videoId) {
      const expectedPlatform = platform || "youtube";
      const expectedPage = YTD_PLATFORMS.cleanPageNumber(pageNumber);
      notes = notes.filter(
        (note) =>
          note.videoId === videoId &&
          (note.platform || "youtube") === expectedPlatform &&
          (expectedPlatform !== "bilibili" ||
            YTD_PLATFORMS.cleanPageNumber(note.pageNumber) === expectedPage),
      );
    }

    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Deletes a note by ID
 */
async function handleDeleteNote(noteId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];
    notes = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ ytd_notes: notes });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[YouTube Digest] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    console.error("Explain selection error:", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
    };
  }
}

// ============================================================
// FOCUSED QUESTIONS — Transcript / Overview / Notes
// ============================================================

async function handleContextQuestion(payload) {
  try {
    const request = YTD_QUESTION_ANSWER.normalizeQuestionRequest(payload);
    const variables = {
      videoTitle: request.videoTitle,
      sourceLabel: request.sourceLabel,
      timestamp: YTD_QUESTION_ANSWER.formatTimestamp(
        request.timestampSeconds,
      ),
      sourceText: request.sourceText,
      surroundingContext: request.surroundingContext || "Not available",
      question: request.question,
    };
    const systemPrompt = await loadPromptSection(
      "context-question.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "context-question.md",
      "User prompt",
      variables,
    );

    debugLog("[YouTube Digest] Requesting focused context answer");
    const { text: answer } = await requestAiCompletion({
      maxTokens: 1800,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      answer: answer.trim().slice(0, 8_000),
    };
  } catch (error) {
    console.error("Focused context question error:", error);
    return {
      success: false,
      error: error.message || "Failed to answer the focused question",
    };
  }
}

async function handleSaveQuestionAnswerNote(payload, answer) {
  try {
    const request = YTD_QUESTION_ANSWER.normalizeQuestionRequest(payload);
    const canonicalVideoUrl = YTD_PLATFORMS.canonicalVideoUrl(
      request.platform,
      request.videoId,
      request.pageNumber,
    );
    const note = YTD_QUESTION_ANSWER.buildQuestionAnswerNote({
      request,
      answer,
      canonicalVideoUrl,
    });

    await saveNoteToStorage(note);
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});
    return { success: true, note };
  } catch (error) {
    console.error("Save question answer note error:", error);
    return {
      success: false,
      error: error.message || "Failed to save the Codex answer",
    };
  }
}

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - Must be 'zh'
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  if (targetLanguage !== "zh") {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = "Simplified Chinese";
  const langSpecific = await loadPromptSection(
    "translation.md",
    "Chinese rules",
  );
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 12) {
    throw new Error("Transcript translation requires 1 to 12 segments");
  }

  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Aligns untrusted model output by exact stable ID. Missing, duplicated,
 * unknown, empty, or clearly non-Chinese values become explicit row errors.
 */
function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid Chinese translation",
    })),
  };
}

/**
 * Translates content using the local Codex bridge.
 * @param {Object} content - JSON object containing semantic transcript segments
 * @param {string} contentType - Must be 'transcriptBatch'
 * @param {string} targetLanguage - 'zh' for Simplified Chinese
 * @param {string} videoTitle - The video title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(
  content,
  contentType,
  targetLanguage,
  videoTitle,
) {
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
      };
    }
    if (contentType !== "transcriptBatch") {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
      };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules(targetLanguage);
    const systemPrompt = await loadPromptSection(
      "translation.md",
      "Transcript batch translation",
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const userContent = JSON.stringify({ segments: sourceSegments });
    const translationOptions = {
      temperature: 0.2,
      maxTokens: 1536,
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      userContent,
      translationOptions,
    );

    // A local model response can rarely be empty. The prompt
    // already requires JSON, so retry once without response_format.
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(systemPrompt, userContent, {
        temperature: translationOptions.temperature,
        maxTokens: translationOptions.maxTokens,
      });
    }
    if (!result.success) return result;

    const parsed = parseLooseJson(result.text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "Translation returned no valid Chinese segments",
      };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    console.error("[YouTube Digest] Translation error:", error);
    return { success: false, error: error.message || "Translation failed" };
  }
}

/**
 * Makes a single Codex-local call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callAiTranslation(
  systemPrompt,
  userContent,
  { temperature = 0.3, maxTokens = 8192, responseFormat } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      responseFormat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    return { success: true, text };
  } catch (error) {
    if (error.status === 429) {
      return {
        success: false,
        error: "Rate limited — try again in a moment",
        code: "RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  callAiTranslation,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleTranslateContent,
};

globalThis.__YTD_DIRECT_TRANSCRIPT_TESTING__ = {
  buildTranscriptResult,
  cleanCaptionText,
  decodeXmlEntities,
  fetchBilibiliSubtitlePayload,
  fetchCaptionPayloadInPage,
  getBilibiliSubtitleTrackFromPage,
  normalizeBilibiliSubtitleUrl,
  getTranscriptRowsFromYouTubePanel,
  parseBilibiliSubtitle,
  parseYouTubeCaptionPayload,
  parseYouTubeJson3,
  parseYouTubeXml,
  selectCaptionTrack,
};

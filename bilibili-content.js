/**
 * Bilibili page adapter. It deliberately uses only the visible page, the
 * native <video> element, and Bilibili's own signed-in subtitle requests.
 */
(function initializeBilibiliAdapter() {
  "use strict";

  const ACCENT = "#fb7299";
  const ACCENT_HOVER = "#e45d86";
  let digestButton = null;
  let noteButton = null;
  let noteTimer = null;
  let reconcileTimer = null;
  let lastUrl = location.href;

  function currentSource() {
    const match = location.pathname.match(/^\/video\/(BV[A-Za-z0-9]{10,18})/i);
    if (!match) return null;
    return {
      platform: "bilibili",
      videoId: match[1],
      pageNumber: Math.min(
        10_000,
        Math.max(1, Math.floor(Number(new URL(location.href).searchParams.get("p")) || 1)),
      ),
    };
  }

  function videoElement() {
    return document.querySelector("video");
  }

  function extractVideoInfo() {
    const videoData = globalThis.__INITIAL_STATE__?.videoData || {};
    const title =
      document.querySelector("h1.video-title, h1[title]")?.textContent?.trim() ||
      videoData.title ||
      document.title.replace(/_哔哩哔哩.*$/i, "").trim();
    const channelName =
      document
        .querySelector(".up-name, .up-name__text, .up-info-container .username")
        ?.textContent?.trim() ||
      videoData.owner?.name ||
      "";
    const description =
      document
        .querySelector(".desc-info-text, .basic-desc-info, .video-desc-container")
        ?.textContent?.trim() ||
      videoData.desc ||
      "";
    const video = videoElement();
    return {
      title,
      channelName,
      description,
      duration: Number(video?.duration) || Number(videoData.duration) || 0,
    };
  }

  function buttonBase(label) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.cssText = `
      border: 0; border-radius: 999px; background: ${ACCENT}; color: #fff;
      height: 36px; padding: 0 18px; font: 600 14px/36px system-ui,-apple-system,sans-serif;
      cursor: pointer; box-shadow: 0 4px 14px rgba(251,114,153,.32);
      transition: background .18s ease, transform .18s ease;
    `;
    button.addEventListener("mouseenter", () => {
      button.style.background = ACCENT_HOVER;
      button.style.transform = "translateY(-1px)";
    });
    button.addEventListener("mouseleave", () => {
      button.style.background = ACCENT;
      button.style.transform = "translateY(0)";
    });
    return button;
  }

  function injectDigestButton() {
    if (!currentSource()) return;
    const existing = document.getElementById("ytd-bilibili-digest-button");
    if (existing?.isConnected) {
      digestButton = existing;
      return;
    }
    digestButton = buttonBase("▶ Digest");
    digestButton.id = "ytd-bilibili-digest-button";
    digestButton.setAttribute("aria-label", "Open Video Digest");
    digestButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await chrome.runtime.sendMessage({ action: "openSidePanel" });
    });
    const toolbar = document.querySelector(
      ".video-toolbar-left, .toolbar-left, .video-toolbar-container",
    );
    if (toolbar) {
      digestButton.style.marginRight = "12px";
      toolbar.insertBefore(digestButton, toolbar.firstChild);
    } else {
      digestButton.style.cssText += "position:fixed;right:24px;bottom:82px;z-index:99998;";
      document.body.appendChild(digestButton);
    }
  }

  function showNoteButton() {
    if (!noteButton) return;
    noteButton.style.opacity = "1";
    noteButton.style.pointerEvents = "auto";
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      if (!noteButton) return;
      noteButton.style.opacity = "0";
      noteButton.style.pointerEvents = "none";
    }, 2200);
  }

  async function saveCurrentNote() {
    const source = currentSource();
    const video = videoElement();
    if (!source || !video) return;
    const info = extractVideoInfo();
    const original = noteButton?.textContent || "✎ Note";
    if (noteButton) {
      noteButton.textContent = "Saving…";
      noteButton.disabled = true;
    }
    try {
      const result = await chrome.runtime.sendMessage({
        action: "saveNote",
        ...source,
        timestamp: Math.max(0, Math.floor(video.currentTime) - 3),
        videoTitle: info.title,
        channelName: info.channelName,
      });
      if (!result?.success) throw new Error(result?.error || "Could not save note");
      if (noteButton) noteButton.textContent = "✓ Saved";
    } catch (error) {
      if (noteButton) noteButton.textContent = "Error";
      console.error("[Video Digest] Bilibili note error:", error);
    }
    setTimeout(() => {
      if (!noteButton) return;
      noteButton.textContent = original;
      noteButton.disabled = false;
    }, 1600);
  }

  function injectNoteButton() {
    const player =
      document.querySelector(".bpx-player-container") ||
      document.querySelector(".bilibili-player") ||
      videoElement()?.parentElement;
    if (!player || !currentSource()) return;
    const existing = document.getElementById("ytd-bilibili-note-button");
    if (existing?.isConnected) {
      noteButton = existing;
      return;
    }
    if (getComputedStyle(player).position === "static") player.style.position = "relative";
    noteButton = buttonBase("✎ Note");
    noteButton.id = "ytd-bilibili-note-button";
    noteButton.style.cssText +=
      "position:absolute;right:16px;top:16px;z-index:99999;opacity:0;pointer-events:none;";
    noteButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      saveCurrentNote();
    });
    player.addEventListener("mouseenter", showNoteButton);
    player.addEventListener("mousemove", showNoteButton);
    player.addEventListener("mouseleave", () => {
      clearTimeout(noteTimer);
      if (noteButton) {
        noteButton.style.opacity = "0";
        noteButton.style.pointerEvents = "none";
      }
    });
    player.appendChild(noteButton);
  }

  function reconcile() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      digestButton?.remove();
      noteButton?.remove();
      digestButton = null;
      noteButton = null;
    }
    injectDigestButton();
    injectNoteButton();
  }

  function scheduleReconcile() {
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(reconcile, 120);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "getVideoInfo") {
      sendResponse(extractVideoInfo());
      return false;
    }
    if (message.action === "seekTo") {
      const video = videoElement();
      if (video) {
        video.currentTime = Math.max(0, Number(message.seconds) || 0);
        if (video.paused) video.play().catch(() => {});
      }
      sendResponse({ success: Boolean(video) });
      return false;
    }
    if (message.action === "getCurrentTime") {
      const video = videoElement();
      sendResponse({ currentTime: Number(video?.currentTime) || 0 });
      return false;
    }
    if (message.action === "highlightMoments") {
      sendResponse({ success: true });
      return false;
    }
    return false;
  });

  document.addEventListener("keydown", (event) => {
    if ((event.key !== "n" && event.key !== "N") || !currentSource()) return;
    const active = document.activeElement;
    if (active && (active.matches("input,textarea") || active.isContentEditable)) return;
    event.preventDefault();
    event.stopPropagation();
    saveCurrentNote();
  }, true);

  const observer = new MutationObserver(scheduleReconcile);
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  reconcile();
})();

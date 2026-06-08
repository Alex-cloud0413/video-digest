/**
 * CONTENT SCRIPT
 *
 * This script runs ON the YouTube page itself. It can see and modify
 * the YouTube page DOM (the HTML elements).
 *
 * It handles:
 * 1. Extracting video info (title, channel name) from the page
 * 2. Injecting "key moment" markers onto YouTube's progress bar
 * 3. Adding a "Digest" button to YouTube's action bar (next to Share/Save)
 *
 * Think of it like a robot sitting inside the YouTube tab,
 * reading the page and making small visual changes.
 */

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * When the page loads, inject our Digest button and Note button.
 * We wait a bit for YouTube's UI to fully render.
 */
function init() {
  // Try to inject the buttons immediately
  injectDigestButton();
  injectNoteButton();

  // Also set up an observer to handle YouTube's dynamic content loading
  // (YouTube is an SPA, so elements appear/disappear as you navigate)
  setupButtonObserver();
}

// Run init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}


// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel or background script.
 * When they ask for video info, we read it from the page.
 * When they send key moments, we highlight them on the progress bar.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[YT Digest Content] Received message:', message.action, message);

  if (message.action === 'getVideoInfo') {
    // Read video title and channel name from the page
    const info = extractVideoInfo();
    console.log('[YT Digest Content] Returning video info:', info);
    sendResponse(info);
    return false; // Synchronous response
  }

  if (message.action === 'highlightMoments') {
    // Add colored markers to YouTube's video progress bar
    console.log('[YT Digest Content] Highlighting moments:', message.moments);
    highlightKeyMoments(message.moments, message.videoDuration);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'getCurrentTime') {
    // Return the current video playback time (used by auto-scroll)
    const video = document.querySelector('video.html5-main-video');
    sendResponse({
      currentTime: video ? Math.floor(video.currentTime) : 0,
      paused: video ? video.paused : true
    });
    return false;
  }

  if (message.action === 'seekTo') {
    // Jump the video to a specific timestamp
    console.log('[YT Digest Content] Seeking to:', message.seconds);
    seekToTimestamp(message.seconds);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'showFullscreenRemix') {
    // Show fullscreen remix overlay in the main browser window
    console.log('[YT Digest Content] Showing fullscreen remix');
    showFullscreenOverlay(message.content, message.title, message.videoTitle, message.channelName);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'showNoteSavedFeedback') {
    // Show brief feedback that note was saved
    showNoteSavedToast(message.note);
    sendResponse({ success: true });
    return false;
  }

  // Unknown action - still send a response to prevent hanging
  console.log('[YT Digest Content] Unknown action:', message.action);
  sendResponse({ success: false, error: 'Unknown action' });
  return false;
});


// ============================================================
// DIGEST BUTTON INJECTION
// ============================================================

/**
 * Injects a "Digest" button into YouTube's action bar.
 * The button appears next to Share, Save, etc. below the video.
 *
 * When clicked, it opens the YT Digest side panel.
 */
function injectDigestButton() {
  // Don't inject if we're not on a video page
  if (!window.location.pathname.includes('/watch')) return;

  // Don't inject if button already exists
  if (document.getElementById('ytd-digest-button')) return;

  // Find YouTube's action buttons container (where Share, Save, etc. live)
  // IMPORTANT: We must scope this to the PRIMARY video metadata only.
  // YouTube reuses #top-level-buttons-computed in playlists, comments, etc.
  // The video's action bar lives inside ytd-watch-metadata or #actions
  // within the primary column (#primary / #columns #primary).
  const actionsContainer = document.querySelector(
    'ytd-watch-metadata #actions #top-level-buttons-computed, ' +
    'ytd-watch-metadata #top-level-buttons-computed, ' +
    '#primary #actions #top-level-buttons-computed'
  );

  if (!actionsContainer) {
    // Container not found yet — will retry via observer
    return;
  }

  // Create our Digest button
  const digestButton = document.createElement('button');
  digestButton.id = 'ytd-digest-button';
  digestButton.innerHTML = `
    <span class="ytd-digest-icon">◆</span>
    <span class="ytd-digest-label">Digest</span>
  `;

  // Style the button to match YouTube's aesthetic
  digestButton.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 16px;
    height: 36px;
    border: none;
    border-radius: 18px;
    background: #e63946;
    color: white;
    font-family: "Roboto", "Arial", sans-serif;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    margin-left: 8px;
    transition: background 0.2s, transform 0.1s;
    flex-shrink: 0;
  `;

  // Hover effects
  digestButton.addEventListener('mouseenter', () => {
    digestButton.style.background = '#d62839';
    digestButton.style.transform = 'scale(1.02)';
  });

  digestButton.addEventListener('mouseleave', () => {
    digestButton.style.background = '#e63946';
    digestButton.style.transform = 'scale(1)';
  });

  // Click handler — open the side panel
  digestButton.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    console.log('[YT Digest] Digest button clicked');

    // Send message to background script to open side panel
    try {
      const result = await chrome.runtime.sendMessage({ action: 'openSidePanel' });
      console.log('[YT Digest] openSidePanel response:', result);
    } catch (err) {
      console.error('[YT Digest] Failed to open side panel:', err);
    }
  });

  // Insert the button at the end of the actions container
  actionsContainer.appendChild(digestButton);
}

/**
 * Sets up a MutationObserver to watch for YouTube's dynamic content changes.
 * When the action buttons container appears (after navigation), we inject our button.
 */
function setupButtonObserver() {
  const observer = new MutationObserver((mutations) => {
    // Check if we need to inject the buttons
    if (window.location.pathname.includes('/watch')) {
      if (!document.getElementById('ytd-digest-button')) {
        injectDigestButton();
      }
      if (!document.getElementById('ytd-note-button')) {
        injectNoteButton();
      }
    }
  });

  // Watch the entire body for changes (YouTube rebuilds large chunks of the DOM)
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}


// ============================================================
// NOTE BUTTON (Overlay on Video Player)
// ============================================================

/**
 * Injects a "Note" button overlay on top of the YouTube video player.
 * When clicked, it captures the current timestamp (minus 3 seconds to catch what was just said)
 * and the corresponding transcript line, cleans it up, and saves it as a note.
 */
function injectNoteButton() {
  // Don't inject if we're not on a video page
  if (!window.location.pathname.includes('/watch')) return;

  // Don't inject if button already exists
  if (document.getElementById('ytd-note-button')) return;

  // Find the video player container
  const playerContainer = document.querySelector('#movie_player, .html5-video-player');
  if (!playerContainer) return;

  // Create the note button with brutalist styling
  const noteButton = document.createElement('button');
  noteButton.id = 'ytd-note-button';
  noteButton.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 6px;">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
    </svg>
    <span>NOTE</span>
  `;

  // Brutalist style - sharp edges, bold typography
  noteButton.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 60;
    display: flex;
    align-items: center;
    padding: 10px 16px;
    background: #e63946;
    color: white;
    border: none;
    font-family: 'Bebas Neue', 'Impact', 'Arial Black', sans-serif;
    font-size: 14px;
    letter-spacing: 2px;
    cursor: pointer;
    transition: all 0.15s;
    opacity: 0;
    pointer-events: none;
    box-shadow: 4px 4px 0 rgba(0,0,0,0.3);
  `;

  // Show button when hovering over the player
  playerContainer.addEventListener('mouseenter', () => {
    noteButton.style.opacity = '1';
    noteButton.style.pointerEvents = 'auto';
  });

  playerContainer.addEventListener('mouseleave', () => {
    noteButton.style.opacity = '0';
    noteButton.style.pointerEvents = 'none';
  });

  // Hover effect - shift shadow for "pressed" feel
  noteButton.addEventListener('mouseenter', () => {
    noteButton.style.background = '#d62839';
    noteButton.style.boxShadow = '2px 2px 0 rgba(0,0,0,0.3)';
    noteButton.style.transform = 'translate(2px, 2px)';
  });

  noteButton.addEventListener('mouseleave', () => {
    noteButton.style.background = '#e63946';
    noteButton.style.boxShadow = '4px 4px 0 rgba(0,0,0,0.3)';
    noteButton.style.transform = 'translate(0, 0)';
  });

  // Click handler — save the current moment as a note
  noteButton.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    console.log('[YT Digest] Note button clicked');

    // Get current video state
    const video = document.querySelector('video.html5-main-video');
    if (!video) {
      console.error('[YT Digest] No video element found');
      return;
    }

    // Go back 3 seconds to capture what was just said (user reacts after hearing it)
    const currentTime = Math.max(0, Math.floor(video.currentTime) - 3);
    const videoInfo = extractVideoInfo();
    const videoId = new URLSearchParams(window.location.search).get('v');

    // Visual feedback - show saving state
    const originalContent = noteButton.innerHTML;
    noteButton.innerHTML = '<span style="letter-spacing: 2px;">SAVING...</span>';
    noteButton.style.pointerEvents = 'none';

    try {
      // Send to background to process and save the note
      const result = await chrome.runtime.sendMessage({
        action: 'saveNote',
        videoId: videoId,
        timestamp: currentTime,
        videoTitle: videoInfo.title,
        channelName: videoInfo.channelName,
        videoUrl: window.location.href
      });

      if (result.success) {
        // Show success feedback
        noteButton.innerHTML = '<span style="letter-spacing: 2px;">SAVED</span>';
        noteButton.style.background = '#2a9d8f';

        // Show toast with the saved note
        showNoteSavedToast(result.note);
      } else {
        noteButton.innerHTML = '<span style="letter-spacing: 2px;">ERROR</span>';
        console.error('[YT Digest] Save note error:', result.error);
      }
    } catch (err) {
      noteButton.innerHTML = '<span style="letter-spacing: 2px;">ERROR</span>';
      console.error('[YT Digest] Save note exception:', err);
    }

    // Reset button after delay
    setTimeout(() => {
      noteButton.innerHTML = originalContent;
      noteButton.style.background = '#e63946';
      noteButton.style.pointerEvents = 'auto';
    }, 2000);
  });

  // Make sure player container has relative positioning
  playerContainer.style.position = 'relative';
  playerContainer.appendChild(noteButton);
}


/**
 * Shows a toast notification when a note is saved.
 */
function showNoteSavedToast(note) {
  // Remove existing toast
  const existing = document.getElementById('ytd-note-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'ytd-note-toast';
  toast.innerHTML = `
    <div style="font-weight: 600; margin-bottom: 6px; color: #e63946;">📝 Note Saved</div>
    <div style="font-size: 12px; color: #555; margin-bottom: 8px;">${note.timestamp} — ${escapeHtmlForContent(note.videoTitle)}</div>
    <div style="font-size: 13px; line-height: 1.5; color: #1a1a1a; font-style: italic;">"${escapeHtmlForContent(note.text)}"</div>
    <div style="margin-top: 10px; font-size: 11px;">
      <a href="${note.timestampedUrl}" style="color: #e63946; text-decoration: none;">🔗 Copy link</a>
    </div>
  `;

  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    background: white;
    border: 2px solid #e63946;
    border-radius: 8px;
    padding: 16px 20px;
    max-width: 350px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    font-family: 'Space Grotesk', 'Helvetica Neue', sans-serif;
    animation: ytdSlideIn 0.3s ease;
  `;

  // Add animation keyframes
  const style = document.createElement('style');
  style.textContent = `
    @keyframes ytdSlideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  // Copy link handler
  toast.querySelector('a').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(note.timestampedUrl);
      e.target.textContent = '✓ Copied!';
    } catch (err) {
      console.error('Copy failed:', err);
    }
  });

  document.body.appendChild(toast);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.style.animation = 'ytdSlideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}


// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Reads the video title, channel name, and description directly from YouTube's page.
 * These are just sitting in the HTML — we grab them from the DOM elements.
 */
function extractVideoInfo() {
  // The video title is in an h1 element inside the #title container
  const titleElement = document.querySelector(
    'h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string'
  );

  // The channel name is in the channel info section
  const channelElement = document.querySelector(
    '#channel-name yt-formatted-string a, ytd-channel-name yt-formatted-string a'
  );

  // Video duration from the video element
  const videoElement = document.querySelector('video.html5-main-video');

  // Video description — YouTube has this in a few possible places
  const descriptionElement = document.querySelector(
    '#description-inner, ' +
    'ytd-watch-metadata #description yt-attributed-string, ' +
    '#description yt-formatted-string, ' +
    'ytd-expander#description yt-attributed-string'
  );

  return {
    title: titleElement?.textContent?.trim() || '',
    channelName: channelElement?.textContent?.trim() || '',
    duration: videoElement?.duration || 0,
    description: descriptionElement?.textContent?.trim() || ''
  };
}


// ============================================================
// PROGRESS BAR KEY MOMENTS
// ============================================================

/**
 * Adds colored marker dots to YouTube's video progress bar
 * at the positions of key moments identified by Claude.
 *
 * How it works:
 * - YouTube's progress bar is a <div> element with a known class
 * - We calculate each moment's position as a percentage of total duration
 * - We inject small colored <div> elements at those positions
 * - The markers are absolutely positioned on top of the progress bar
 *
 * This is a "bonus feature" — it gives you a visual preview
 * of where the good stuff is in the video.
 */
function highlightKeyMoments(moments, videoDuration) {
  // Don't proceed if we don't have valid data
  if (!moments || !moments.length || !videoDuration) return;

  // Remove any previously injected markers (in case user re-digests)
  const existingMarkers = document.querySelectorAll('.ytd-key-moment-marker');
  existingMarkers.forEach(m => m.remove());

  // Find YouTube's progress bar container
  // This is the clickable bar at the bottom of the video
  const progressBar = document.querySelector('.ytp-progress-bar');
  if (!progressBar) return;

  // We need a container for our markers, positioned relative to the progress bar
  const markerContainer = document.createElement('div');
  markerContainer.className = 'ytd-key-moment-markers';
  markerContainer.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    z-index: 40;
  `;

  // Create a marker for each key moment
  moments.forEach(timestampSeconds => {
    // Calculate position as a percentage of total video duration
    const percentage = (timestampSeconds / videoDuration) * 100;

    // Don't render markers outside valid range
    if (percentage < 0 || percentage > 100) return;

    const marker = document.createElement('div');
    marker.className = 'ytd-key-moment-marker';
    marker.style.cssText = `
      position: absolute;
      left: ${percentage}%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 8px;
      height: 8px;
      background: #e63946;
      border-radius: 50%;
      box-shadow: 0 0 6px rgba(230, 57, 70, 0.6);
      pointer-events: none;
      z-index: 41;
    `;

    markerContainer.appendChild(marker);
  });

  // Add markers to the progress bar
  // The progress bar needs position:relative for our absolute positioning to work
  progressBar.style.position = 'relative';
  progressBar.appendChild(markerContainer);
}


// ============================================================
// SEEK TO TIMESTAMP
// ============================================================

/**
 * Jumps the YouTube video to a specific timestamp (in seconds).
 * This is called when the user clicks a timestamp in the side panel.
 *
 * We simply set the video element's .currentTime property,
 * which is the standard HTML5 way to seek in a video.
 */
function seekToTimestamp(seconds) {
  const video = document.querySelector('video.html5-main-video');
  if (video) {
    video.currentTime = seconds;
    // Also play the video if it's paused
    if (video.paused) {
      video.play().catch(() => {}); // Ignore autoplay errors
    }
  }
}


// ============================================================
// FULLSCREEN REMIX OVERLAY
// ============================================================

/**
 * Shows a fullscreen overlay in the main browser window with the remixed content.
 * This is called from the side panel when user clicks the fullscreen button.
 *
 * We inject it into the YouTube page so it fills the whole browser window,
 * not just the narrow side panel.
 */
function showFullscreenOverlay(htmlContent, styleTitle, videoTitle, channelName) {
  // Remove any existing overlay
  const existing = document.getElementById('ytd-fullscreen-remix');
  if (existing) existing.remove();

  // Create the overlay
  const overlay = document.createElement('div');
  overlay.id = 'ytd-fullscreen-remix';
  overlay.innerHTML = `
    <style>
      #ytd-fullscreen-remix {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.95);
        z-index: 999999;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: ytdFadeIn 0.2s ease;
      }
      @keyframes ytdFadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .ytd-fs-container {
        width: 90%;
        max-width: 800px;
        max-height: 90vh;
        background: #faf9f7;
        display: flex;
        flex-direction: column;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      }
      .ytd-fs-header {
        padding: 24px 32px;
        border-bottom: 4px solid #e63946;
        background: #f5f4f2;
        flex-shrink: 0;
      }
      .ytd-fs-title {
        font-family: 'Bebas Neue', Impact, sans-serif;
        font-size: 28px;
        letter-spacing: 3px;
        text-transform: uppercase;
        color: #e63946;
        margin-bottom: 8px;
      }
      .ytd-fs-meta {
        font-family: 'Space Grotesk', sans-serif;
        font-size: 14px;
        color: #555;
        margin-bottom: 16px;
      }
      .ytd-fs-close {
        font-family: 'Bebas Neue', Impact, sans-serif;
        font-size: 14px;
        letter-spacing: 1px;
        text-transform: uppercase;
        padding: 10px 20px;
        background: #faf9f7;
        border: 2px solid #e0ddd8;
        color: #555;
        cursor: pointer;
        transition: all 0.15s;
      }
      .ytd-fs-close:hover {
        border-color: #e63946;
        color: #e63946;
      }
      .ytd-fs-content {
        padding: 40px;
        overflow-y: auto;
        flex: 1;
        font-family: 'Space Grotesk', 'Helvetica Neue', sans-serif;
        font-size: 16px;
        line-height: 1.9;
        color: #1a1a1a;
      }
      .ytd-fs-content h2 { font-family: 'Bebas Neue', sans-serif; font-size: 28px; letter-spacing: 2px; margin: 32px 0 16px; border-bottom: 2px solid #e63946; padding-bottom: 8px; }
      .ytd-fs-content h3 { font-family: 'Bebas Neue', sans-serif; font-size: 22px; color: #e63946; margin: 28px 0 12px; }
      .ytd-fs-content h4 { font-family: 'Bebas Neue', sans-serif; font-size: 16px; text-transform: uppercase; margin: 24px 0 10px; }
      .ytd-fs-content p { margin-bottom: 18px; }
      .ytd-fs-content strong { font-weight: 600; }
      .ytd-fs-content blockquote { border-left: 4px solid #e63946; padding: 16px 24px; margin: 20px 0; background: #f5f4f2; font-style: italic; }
      .ytd-fs-content hr { border: none; height: 2px; background: #e0ddd8; margin: 28px 0; }
    </style>
    <div class="ytd-fs-container">
      <div class="ytd-fs-header">
        <div class="ytd-fs-title">${escapeHtmlForContent(styleTitle)}</div>
        <div class="ytd-fs-meta">${escapeHtmlForContent(videoTitle)} • ${escapeHtmlForContent(channelName)}</div>
        <button class="ytd-fs-close" id="ytd-fs-close-btn">✕ Close</button>
      </div>
      <div class="ytd-fs-content">${htmlContent}</div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Close handlers
  document.getElementById('ytd-fs-close-btn').addEventListener('click', closeFullscreenOverlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeFullscreenOverlay();
  });

  // Close on Escape
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      closeFullscreenOverlay();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

function closeFullscreenOverlay() {
  const overlay = document.getElementById('ytd-fullscreen-remix');
  if (overlay) overlay.remove();
}

function escapeHtmlForContent(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}


// ============================================================
// PAGE NAVIGATION DETECTION
// ============================================================

/**
 * YouTube is a "Single Page Application" (SPA). This means when you
 * click on a new video, the page doesn't fully reload — YouTube
 * dynamically swaps out the content. So our content script stays alive
 * but needs to detect when the video changes.
 *
 * We watch for URL changes using the `yt-navigate-finish` event,
 * which YouTube fires after navigation completes. When that happens,
 * we clean up old markers and re-inject the button.
 */
document.addEventListener('yt-navigate-finish', () => {
  // Clean up old key moment markers when navigating to a new video
  const existingMarkers = document.querySelectorAll('.ytd-key-moment-markers');
  existingMarkers.forEach(m => m.remove());

  // Remove old buttons (they will be re-injected for the new video)
  const existingDigestButton = document.getElementById('ytd-digest-button');
  if (existingDigestButton) existingDigestButton.remove();

  const existingNoteButton = document.getElementById('ytd-note-button');
  if (existingNoteButton) existingNoteButton.remove();

  // Remove any toasts
  const existingToast = document.getElementById('ytd-note-toast');
  if (existingToast) existingToast.remove();

  // Re-inject buttons for the new video (with a small delay for YouTube to render)
  setTimeout(() => {
    injectDigestButton();
    injectNoteButton();
  }, 500);
});



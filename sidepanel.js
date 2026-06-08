/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for YT Digest: video detection, transcript analysis,
 * rendering results, remix functionality, and export features.
 */

// ============================================================
// STATE
// ============================================================

let currentVideoId = null;
let currentVideoUrl = null;
let currentAnalysis = null;
let currentTranscript = null;
let currentTranscriptText = null;            // Plain text (for display/export)
let currentTranscriptTimestamped = null;     // With timestamps (for Claude analysis)
let currentTranscriptSource = null;          // 'assemblyai' if AI-transcribed, null if from subtitles
let currentEnhancedTranscript = null;
let currentRemixContent = null;
let currentRemixStyleName = '';
let currentVideoTitle = '';
let currentChannelName = '';
let currentVideoDescription = '';
let currentVideoDuration = 0;
let isTranscriptEnhanced = false;
let isAnalysisLoading = false;               // Track if analysis is in progress
let youtubeTabId = null;                     // Store the YouTube tab ID for reliable messaging

// --- Translation state ---
let currentLanguage = 'en';                  // Currently selected language: 'en', 'zh', or 'ja'
let lastRequestedLanguage = 'en';            // Guards against stale translation responses
let isTranslating = false;                   // True while a translation API call is in flight
// Translation cache: Map of "videoId:lang:contentType" → translated content
// This avoids re-translating the same content when switching tabs or languages
let translationCache = new Map();
// Scroll-based lazy translation for transcripts:
// Instead of translating the entire transcript at once (slow for long videos),
// we split it into paragraphs and only translate what's visible on screen.
// As the user scrolls, new paragraphs entering the viewport get translated.
let transcriptScrollObserver = null;       // IntersectionObserver watching paragraph visibility
let transcriptParagraphCache = new Map();  // Map of paragraphIndex → translated text (per video+lang)

// --- Auto-scroll state (follow video playback in transcript) ---
let autoScrollEnabled = true;        // True = scroll transcript to follow video playback
let autoScrollInterval = null;       // setInterval ID for polling video time
let lastAutoScrollTime = 0;          // Timestamp of last programmatic scroll (ignores scroll events within 1s)


// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

/**
 * Groups raw transcript entries into readable chunks using a hybrid approach:
 * sentence boundaries + time guardrails.
 *
 * Instead of blindly cutting every N seconds (which splits mid-sentence),
 * this waits for a sentence-ending punctuation mark (. ? !) and only splits
 * once a minimum time has passed. If no punctuation comes, it force-splits
 * at a maximum time to prevent giant blocks.
 *
 * Think of it like: "accumulate text until a sentence ends, but don't make
 * chunks shorter than ~10s or longer than ~25s."
 *
 * @param {Array<{start: number, text: string}>} entries - Raw transcript entries
 * @returns {Array<{start: number, texts: string[]}>} Grouped chunks
 */
function groupTranscriptEntries(entries) {
  if (!entries || !entries.length) return [];

  const MIN_CHUNK_SECONDS = 10;  // Don't split before this (avoids tiny one-liners)
  const MAX_CHUNK_SECONDS = 25;  // Force-split here even without punctuation

  const grouped = [];
  let currentGroup = null;

  entries.forEach(entry => {
    if (!currentGroup) {
      // First entry — start a new group
      currentGroup = { start: entry.start, texts: [entry.text] };
      grouped.push(currentGroup);
      return;
    }

    const elapsed = entry.start - currentGroup.start;

    // Force-split: chunk has grown too long, start a new one regardless
    if (elapsed >= MAX_CHUNK_SECONDS) {
      currentGroup = { start: entry.start, texts: [entry.text] };
      grouped.push(currentGroup);
      return;
    }

    // Past minimum time — look for a sentence boundary to split at.
    // YouTube caption entries don't align with sentence boundaries —
    // one entry might be "the cap table. And I felt like," where the
    // period is mid-entry. We need to SPLIT THE ENTRY TEXT itself:
    // "the cap table." → finish current chunk
    // "And I felt like," → start next chunk
    if (elapsed >= MIN_CHUNK_SECONDS) {

      // Case 1: Entry text ends with sentence punctuation — clean split
      if (/[.?!][""'）)」]*\s*$/.test(entry.text)) {
        currentGroup.texts.push(entry.text);
        currentGroup = null;
        return;
      }

      // Case 2: Sentence boundary MID-entry (e.g. "culture. and you're")
      // Find the LAST .?! followed by space (greedy .* skips to last match)
      const match = entry.text.match(/^(.*[.?!])\s+([\s\S]*)$/);
      if (match && match[2].trim()) {
        // Text up to the punctuation → finish current chunk
        currentGroup.texts.push(match[1]);
        currentGroup = null;
        // Text after the punctuation → start next chunk
        const remainder = match[2].trim();
        currentGroup = { start: entry.start, texts: [remainder] };
        grouped.push(currentGroup);
        return;
      }
    }

    // No split triggered — just accumulate
    currentGroup.texts.push(entry.text);
  });

  return grouped;
}


// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();

  const configStatus = await chrome.runtime.sendMessage({ action: 'checkConfig' });

  if (!configStatus.hasSupadataKey || !configStatus.hasAnthropicKey) {
    showConfigError(configStatus);
    return;
  }

  await checkCurrentTab();
});

// Listen for messages from the Digest button on YouTube page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startDigestFromButton') {
    // Force a fresh digest when Digest button is clicked
    forceNewDigest();
    sendResponse({ success: true });
  }
  if (message.action === 'transcriptProgress') {
    // Background is telling us the transcript fetch status changed
    // (e.g., falling back to AssemblyAI because no subtitles exist)
    updateLoading(message.title, message.subtitle);
    sendResponse({ success: true });
  }
  if (message.action === 'noteSaved') {
    // Refresh notes list when a new note is saved
    const filterAll = document.getElementById('notesFilterAll')?.classList.contains('active');
    loadNotes(filterAll ? null : currentVideoId);
    sendResponse({ success: true });
  }
  return false;
});

/**
 * Forces a new digest even if we already have cached results.
 * Called when user clicks the Digest button on YouTube.
 */
async function forceNewDigest() {
  // Clear cache for this video so we fetch fresh
  if (currentVideoId) {
    try {
      await chrome.storage.local.remove(`digest_${currentVideoId}`);
    } catch (e) {}
  }

  // Reset state to force a new analysis
  currentVideoId = null;
  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptSource = null;
  currentEnhancedTranscript = null;
  currentRemixContent = null;
  currentRemixStyleName = '';

  // Stop playback tracking
  stopPlaybackTracking();

  // Clear all cached translations for this video
  translationCache.clear();
  transcriptParagraphCache.clear();

  // Reset language to English and update the dropdown
  currentLanguage = 'en';
  lastRequestedLanguage = 'en';
  const langSelector = document.getElementById('langSelector');
  if (langSelector) {
    langSelector.value = 'en';
    langSelector.classList.remove('active-lang');
  }

  // Start fresh
  await checkCurrentTab();
}

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Action buttons
  document.getElementById('shareBtn').addEventListener('click', shareDigest);
  document.getElementById('copyBtn').addEventListener('click', copyDigest);

  // Error retry
  document.getElementById('errorBtn').addEventListener('click', () => {
    if (currentVideoId) {
      startDigest(currentVideoId, currentVideoUrl);
    }
  });

  // Transcript actions
  document.getElementById('enhanceBtn')?.addEventListener('click', enhanceTranscript);
  document.getElementById('copyTranscriptBtn')?.addEventListener('click', copyTranscript);
  document.getElementById('exportTranscriptBtn')?.addEventListener('click', exportTranscript);

  // Remix actions
  document.getElementById('copyRemixBtn')?.addEventListener('click', copyRemix);
  document.getElementById('exportRemixBtn')?.addEventListener('click', exportRemix);
  document.getElementById('fullscreenRemixBtn')?.addEventListener('click', openFullscreenRemix);

  // Language selector — triggers translation when changed
  document.getElementById('langSelector')?.addEventListener('change', (e) => {
    handleLanguageChange(e.target.value);
  });

  // Follow playback button — re-enables auto-scroll after user scrolled away
  document.getElementById('followPlaybackBtn')?.addEventListener('click', () => {
    autoScrollEnabled = true;
    document.getElementById('followPlaybackBtn').style.display = 'none';
    playbackTrackingTick(); // Immediately jump to current position
  });

  // Notes filter buttons
  document.getElementById('notesFilterThis')?.addEventListener('click', () => {
    document.getElementById('notesFilterThis').classList.add('active');
    document.getElementById('notesFilterAll').classList.remove('active');
    loadNotes(currentVideoId);
  });
  document.getElementById('notesFilterAll')?.addEventListener('click', () => {
    document.getElementById('notesFilterAll').classList.add('active');
    document.getElementById('notesFilterThis').classList.remove('active');
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
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs[0]?.url?.includes('youtube.com')) {
      tab = tabs[0];
    }

    // Strategy 2: Any active YouTube tab
    if (!tab) {
      tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*', active: true });
      if (tabs[0]) tab = tabs[0];
    }

    // Strategy 3: Any YouTube tab (last resort)
    if (!tab) {
      tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
      if (tabs[0]) tab = tabs[0];
    }

    console.log('[YT Digest Panel] Found tab:', tab?.id, tab?.url);

    if (!tab?.url) {
      showState('welcome');
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
          action: 'relayToContent',
          payload: { action: 'getVideoInfo' }
        });
        console.log('[YT Digest Panel] getVideoInfo result:', result);
        if (result.success && result.response) {
          currentVideoTitle = result.response.title || '';
          currentChannelName = result.response.channelName || '';
          currentVideoDescription = result.response.description || '';
          currentVideoDuration = result.response.duration || 0;
        }
      } catch (e) {
        console.error('[YT Digest Panel] getVideoInfo error:', e);
        currentVideoTitle = '';
        currentChannelName = '';
        currentVideoDescription = '';
        currentVideoDuration = 0;
      }

      startDigest(videoId, tab.url);
    } else {
      showState('welcome');
    }
  } catch (error) {
    console.error('Tab check error:', error);
    showState('welcome');
  }
}

function extractVideoId(url) {
  try {
    const urlObj = new URL(url);

    if (urlObj.hostname.includes('youtube.com') && urlObj.searchParams.has('v')) {
      return urlObj.searchParams.get('v');
    }

    if (urlObj.hostname === 'youtu.be') {
      return urlObj.pathname.slice(1);
    }

    if (urlObj.pathname.startsWith('/embed/')) {
      return urlObj.pathname.split('/')[2];
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
    showState('results');
    return;
  }

  // Check cache for this video
  const cached = await loadFromCache(videoId);
  if (cached) {
    console.log('Loading from cache:', videoId);
    currentVideoId = videoId;
    currentVideoUrl = videoUrl;
    currentAnalysis = cached.analysis || null;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptTimestamped = cached.transcriptTimestamped;
    currentTranscriptSource = cached.transcriptSource || null;
    currentEnhancedTranscript = cached.enhancedTranscript || null;
    currentRemixContent = cached.remixContent || null;
    currentRemixStyleName = cached.remixStyleName || '';
    isTranscriptEnhanced = !!cached.enhancedTranscript;
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
      const videoInfo = document.getElementById('videoInfo');
      document.getElementById('videoTitle').textContent = currentVideoTitle;
      document.getElementById('videoChannel').textContent = currentChannelName;
      videoInfo.style.display = 'block';
    }

    // Always render transcript first
    if (isTranscriptEnhanced && currentEnhancedTranscript) {
      renderEnhancedTranscript(currentEnhancedTranscript);
      const enhanceBtn = document.getElementById('enhanceBtn');
      if (enhanceBtn) {
        enhanceBtn.disabled = true;
        enhanceBtn.textContent = '✓ Enhanced';
      }
    } else {
      renderTranscript();
    }

    // Render analysis if we have it cached
    if (currentAnalysis) {
      renderAnalysisResults(currentAnalysis);
      highlightMomentsOnPage(currentAnalysis.keyMoments);
    }

    showState('results');
    document.getElementById('tabsNav').style.display = 'flex';
    loadRemixOptions();

    // Render cached remix if exists
    if (currentRemixContent && currentRemixStyleName) {
      document.getElementById('remixOutputTitle').textContent = currentRemixStyleName;
      document.getElementById('remixContent').innerHTML = renderMarkdown(currentRemixContent);
      document.getElementById('remixOutput').style.display = 'block';
    }

    // Load notes for this video
    loadNotes(videoId);

    // Setup explain feature
    setupExplainFeature();
    return;
  }

  currentVideoId = videoId;
  currentVideoUrl = videoUrl;
  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptSource = null;
  currentEnhancedTranscript = null;
  currentRemixContent = null;
  currentRemixStyleName = '';
  isTranscriptEnhanced = false;
  isAnalysisLoading = false;

  if (currentVideoTitle || currentChannelName) {
    const videoInfo = document.getElementById('videoInfo');
    document.getElementById('videoTitle').textContent = currentVideoTitle;
    document.getElementById('videoChannel').textContent = currentChannelName;
    videoInfo.style.display = 'block';
  }

  showState('loading');
  updateLoading('Fetching transcript', '');

  const transcriptResult = await chrome.runtime.sendMessage({
    action: 'fetchTranscript',
    videoId: videoId,
    videoUrl: videoUrl
  });

  if (!transcriptResult.success) {
    if (transcriptResult.error === 'NO_SUPADATA_KEY') {
      showError('API key missing', 'Add your Supadata API key to config.js and reload the extension.');
      return;
    }
    showError('No transcript found', transcriptResult.message || transcriptResult.error);
    return;
  }

  currentTranscript = transcriptResult.transcript;
  currentTranscriptText = transcriptResult.transcriptText;
  currentTranscriptTimestamped = transcriptResult.transcriptTextTimestamped;
  currentTranscriptSource = transcriptResult.source || null; // 'assemblyai' or null (subtitles)

  // Render transcript immediately (no LLM needed)
  renderTranscript();
  showState('results');
  document.getElementById('tabsNav').style.display = 'flex';

  // Load notes for this video
  loadNotes(videoId);

  // Load remix options (just the buttons, not the content)
  loadRemixOptions();

  // Setup explain feature for text selection
  setupExplainFeature();

  // Save transcript to cache (without analysis)
  await saveToCache(videoId);

  // DON'T run LLM analysis automatically - wait for user to click Overview or Quotes tab
  // This saves tokens when user just wants to see the transcript
}


// ============================================================
// RENDERING
// ============================================================

/**
 * Renders the analysis results (Overview and Quotes tabs).
 * Called after LLM analysis completes.
 */
function renderAnalysisResults(analysis) {
  // Summary
  document.getElementById('summaryText').textContent = analysis.summary || '';

  // Worth watching if
  const worthList = document.getElementById('worthWatchingList');
  worthList.innerHTML = '';
  (analysis.worthWatchingIf || []).forEach(statement => {
    const li = document.createElement('li');
    li.className = 'worth-item';
    li.textContent = statement;
    worthList.appendChild(li);
  });

  // Tags
  const tagsContainer = document.getElementById('tagsContainer');
  tagsContainer.innerHTML = '';
  (analysis.tags || []).forEach(tag => {
    const tagEl = document.createElement('span');
    tagEl.className = 'tag';
    tagEl.textContent = tag;
    tagsContainer.appendChild(tagEl);
  });

  // Chapters
  const chapterList = document.getElementById('chapterList');
  chapterList.innerHTML = '';
  (analysis.chapters || []).forEach(chapter => {
    const li = document.createElement('li');
    li.className = 'chapter-item';
    li.dataset.seconds = chapter.timestampSeconds;
    li.innerHTML = `
      <span class="chapter-timestamp">${chapter.timestamp}</span>
      <div class="chapter-content">
        <span class="chapter-title">${escapeHtml(chapter.title)}</span>
        <span class="chapter-summary">${escapeHtml(chapter.summary || '')}</span>
      </div>
    `;
    li.addEventListener('click', () => {
      console.log('[YT Digest Panel] Chapter clicked:', chapter.timestamp, chapter.timestampSeconds);
      seekTo(chapter.timestampSeconds);
    });
    chapterList.appendChild(li);
  });

  // Quotes - sort by timestamp (chronological order)
  const quotesList = document.getElementById('quotesList');
  quotesList.innerHTML = '';
  const sortedQuotes = [...(analysis.keyQuotes || [])].sort((a, b) =>
    (a.timestampSeconds || 0) - (b.timestampSeconds || 0)
  );
  sortedQuotes.forEach(quote => {
    const div = document.createElement('div');
    div.className = 'quote-item';
    div.dataset.seconds = quote.timestampSeconds;
    div.innerHTML = `
      <div class="quote-text">${escapeHtml(quote.quote)}</div>
      <div class="quote-meta">
        <span class="quote-timestamp">${quote.timestamp}</span>
      </div>
    `;
    div.addEventListener('click', () => {
      console.log('[YT Digest Panel] Quote clicked:', quote.timestamp, quote.timestampSeconds);
      seekTo(quote.timestampSeconds);
    });
    quotesList.appendChild(div);
  });
}

/**
 * Legacy function for backwards compatibility with cached data.
 * Renders both transcript and analysis.
 */
function renderResults(analysis) {
  renderAnalysisResults(analysis);

  // Transcript - show enhanced version if available
  if (isTranscriptEnhanced && currentEnhancedTranscript) {
    renderEnhancedTranscript(currentEnhancedTranscript);
    const enhanceBtn = document.getElementById('enhanceBtn');
    if (enhanceBtn) {
      enhanceBtn.disabled = true;
      enhanceBtn.textContent = '✓ Enhanced';
    }
  } else {
    renderTranscript();
  }

  document.getElementById('tabsNav').style.display = 'flex';

  // Setup explain feature for text selection
  setupExplainFeature();
}

function renderTranscript() {
  if (!currentTranscript) return;

  const transcriptList = document.getElementById('transcriptList');
  transcriptList.innerHTML = '';

  // Show a small badge indicating where the transcript came from
  // This helps the user know if it was pulled from existing subtitles
  // or AI-transcribed from the audio (which may be less accurate)
  const existingBadge = document.getElementById('transcriptSourceBadge');
  if (existingBadge) existingBadge.remove();

  const badge = document.createElement('div');
  badge.id = 'transcriptSourceBadge';
  badge.className = 'transcript-source-badge';
  if (currentTranscriptSource === 'assemblyai') {
    badge.innerHTML = '<span class="source-dot source-dot--ai"></span> AI-transcribed via AssemblyAI';
  } else if (currentTranscriptSource === 'youtube-auto') {
    badge.innerHTML = '<span class="source-dot source-dot--auto"></span> YouTube auto-generated captions';
  } else if (currentTranscriptSource === 'youtube') {
    badge.innerHTML = '<span class="source-dot source-dot--subs"></span> YouTube captions';
  } else {
    badge.innerHTML = '<span class="source-dot source-dot--subs"></span> From video subtitles';
  }
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = groupTranscriptEntries(currentTranscript);

  grouped.forEach(group => {
    const div = document.createElement('div');
    div.className = 'transcript-entry';
    div.dataset.seconds = group.start;

    const minutes = Math.floor(group.start / 60);
    const seconds = group.start % 60;
    const timestamp = `${minutes}:${String(seconds).padStart(2, '0')}`;

    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      <span class="transcript-text">${escapeHtml(group.texts.join(' '))}</span>
    `;

    div.addEventListener('click', () => seekTo(group.start));
    transcriptList.appendChild(div);
  });

  // Reset buttons
  const enhanceBtn = document.getElementById('enhanceBtn');
  if (enhanceBtn) {
    enhanceBtn.disabled = false;
    enhanceBtn.textContent = '✨ Enhance';
  }

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

function renderEnhancedTranscript(enhancedText) {
  const transcriptList = document.getElementById('transcriptList');
  transcriptList.innerHTML = '';

  const paragraphs = enhancedText.split(/\n\n+/);

  paragraphs.forEach(para => {
    if (!para.trim()) return;

    const div = document.createElement('div');
    div.className = 'transcript-paragraph';
    div.textContent = para.trim();
    transcriptList.appendChild(div);
  });

  currentEnhancedTranscript = enhancedText;
}


// ============================================================
// TRANSCRIPT ENHANCEMENT
// ============================================================

async function enhanceTranscript() {
  if (!currentTranscriptText || isTranscriptEnhanced) return;

  const enhanceBtn = document.getElementById('enhanceBtn');
  enhanceBtn.disabled = true;
  enhanceBtn.textContent = 'Enhancing...';

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'enhanceTranscript',
      transcriptText: currentTranscriptText,
      videoTitle: currentVideoTitle,
      videoDescription: currentVideoDescription
    });

    if (result.success) {
      isTranscriptEnhanced = true;
      enhanceBtn.textContent = '✓ Enhanced';
      renderEnhancedTranscript(result.enhancedTranscript);
      // Clear transcript translation cache since content changed
      clearTranslationCacheForType('transcript');
      await updateCache(); // Save enhanced transcript to cache
    } else {
      enhanceBtn.disabled = false;
      enhanceBtn.textContent = '✨ Enhance';
      console.error('Enhancement failed:', result.error);
    }
  } catch (error) {
    enhanceBtn.disabled = false;
    enhanceBtn.textContent = '✨ Enhance';
    console.error('Enhancement error:', error);
  }
}

function copyTranscript() {
  const text = currentEnhancedTranscript || currentTranscriptText || '';
  copyToClipboardWithFeedback(text, 'copyTranscriptBtn');
}

function exportTranscript() {
  // Build export with video metadata header
  const transcriptContent = currentEnhancedTranscript || currentTranscriptText || '';
  const videoUrl = `https://youtube.com/watch?v=${currentVideoId}`;

  let exportText = '';
  exportText += `TRANSCRIPT\n`;
  exportText += `${'='.repeat(60)}\n\n`;
  exportText += `Title: ${currentVideoTitle || 'Unknown'}\n`;
  exportText += `Channel: ${currentChannelName || 'Unknown'}\n`;
  exportText += `URL: ${videoUrl}\n`;
  exportText += `\n${'—'.repeat(60)}\n\n`;

  if (currentVideoDescription) {
    exportText += `DESCRIPTION:\n${currentVideoDescription}\n`;
    exportText += `\n${'—'.repeat(60)}\n\n`;
  }

  exportText += `TRANSCRIPT:\n\n${transcriptContent}\n`;
  exportText += `\n${'—'.repeat(60)}\n`;
  exportText += `Exported by YT Digest\n`;

  const filename = `${sanitizeFilename(currentVideoTitle)}-transcript.txt`;
  downloadTextFile(exportText, filename);
}


// ============================================================
// REMIX FUNCTIONALITY
// ============================================================

async function loadRemixOptions() {
  try {
    const result = await chrome.runtime.sendMessage({ action: 'getRemixStyles' });
    if (result.success) {
      renderRemixOptions(result.styles);
    }
  } catch (error) {
    console.error('Failed to load remix styles:', error);
  }
}

function renderRemixOptions(styles) {
  const container = document.getElementById('remixOptions');
  container.innerHTML = '';

  styles.forEach(style => {
    const div = document.createElement('div');
    div.className = 'remix-option';
    div.dataset.style = style.id;
    div.innerHTML = `
      <div class="remix-option-radio"></div>
      <div class="remix-option-content">
        <div class="remix-option-name">${style.name}</div>
        <div class="remix-option-desc">${style.description}</div>
      </div>
      <button class="remix-option-btn">Generate</button>
    `;

    div.querySelector('.remix-option-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      generateRemix(style.id, style.name);
    });

    div.addEventListener('click', () => {
      document.querySelectorAll('.remix-option').forEach(opt => opt.classList.remove('active'));
      div.classList.add('active');
    });

    container.appendChild(div);
  });
}

async function generateRemix(styleId, styleName) {
  if (!currentTranscriptText) return;

  // Show loading
  document.getElementById('remixLoading').style.display = 'block';
  document.getElementById('remixOutput').style.display = 'none';

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'remixTranscript',
      transcriptText: currentTranscriptText,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoDescription: currentVideoDescription,
      style: styleId
    });

    document.getElementById('remixLoading').style.display = 'none';

    if (result.success) {
      currentRemixContent = result.remixedContent;
      currentRemixStyleName = result.styleName || styleName;
      document.getElementById('remixOutputTitle').textContent = currentRemixStyleName;
      // Render markdown instead of plain text
      document.getElementById('remixContent').innerHTML = renderMarkdown(result.remixedContent);
      document.getElementById('remixOutput').style.display = 'block';
      // Clear remix translation cache since content changed
      clearTranslationCacheForType('remix');
      await updateCache(); // Save remix to cache
    } else {
      console.error('Remix failed:', result.error);
    }
  } catch (error) {
    document.getElementById('remixLoading').style.display = 'none';
    console.error('Remix error:', error);
  }
}


/**
 * Simple markdown renderer for remix content.
 * Handles: headers (##), bold (**), italic (*), and paragraphs.
 */
function renderMarkdown(text) {
  if (!text) return '';

  // Escape HTML first to prevent XSS
  let html = escapeHtml(text);

  // Convert markdown to HTML
  // Headers: ## Header -> <h2>Header</h2>
  html = html.replace(/^### (.+)$/gm, '<h4 class="remix-h4">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 class="remix-h3">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2 class="remix-h2">$1</h2>');

  // Bold: **text** -> <strong>text</strong>
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic: *text* or _text_ -> <em>text</em>
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

  // Blockquotes: > text -> <blockquote>
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote class="remix-quote">$1</blockquote>');

  // Horizontal rules: --- or ***
  html = html.replace(/^[-*]{3,}$/gm, '<hr class="remix-hr">');

  // Convert double newlines to paragraph breaks
  html = html.split(/\n\n+/).map(para => {
    // Don't wrap if it's already a block element
    if (para.match(/^<(h[2-4]|blockquote|hr)/)) {
      return para;
    }
    return `<p>${para.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  return html;
}

function copyRemix() {
  if (currentRemixContent) {
    copyToClipboardWithFeedback(currentRemixContent, 'copyRemixBtn');
  }
}

function exportRemix() {
  if (currentRemixContent) {
    const videoUrl = `https://youtube.com/watch?v=${currentVideoId}`;

    // Build export with video metadata header
    let exportText = '';
    exportText += `${currentRemixStyleName.toUpperCase()}\n`;
    exportText += `${'='.repeat(60)}\n\n`;
    exportText += `Source: ${currentVideoTitle || 'Unknown'}\n`;
    exportText += `Channel: ${currentChannelName || 'Unknown'}\n`;
    exportText += `URL: ${videoUrl}\n`;
    exportText += `\n${'—'.repeat(60)}\n\n`;
    exportText += currentRemixContent;
    exportText += `\n\n${'—'.repeat(60)}\n`;
    exportText += `Generated by YT Digest — Remix\n`;

    const filename = `${sanitizeFilename(currentVideoTitle)}-${currentRemixStyleName.toLowerCase().replace(/\s+/g, '-')}.txt`;
    downloadTextFile(exportText, filename);
  }
}


// ============================================================
// UI STATE MANAGEMENT
// ============================================================

function showState(state) {
  document.getElementById('welcomeState').style.display = state === 'welcome' ? 'flex' : 'none';
  document.getElementById('loadingState').style.display = state === 'loading' ? 'block' : 'none';
  document.getElementById('errorState').style.display = state === 'error' ? 'block' : 'none';
  const uploadEl = document.getElementById('uploadState');
  if (uploadEl) uploadEl.style.display = 'none'; // Upload state removed — always hidden
  document.getElementById('resultsState').style.display = state === 'results' ? 'block' : 'none';

  if (state !== 'results') {
    document.getElementById('tabsNav').style.display = 'none';
    stopPlaybackTracking();
  }
}

function updateLoading(title, subtitle) {
  document.getElementById('loadingText').textContent = title;
  document.getElementById('loadingSubtext').textContent = subtitle;
}

function showError(title, message) {
  showState('error');
  document.getElementById('errorTitle').textContent = title;
  document.getElementById('errorMessage').textContent = message;
}



function showConfigError(configStatus) {
  const missingKeys = [];
  if (!configStatus.hasSupadataKey) missingKeys.push('Supadata');
  if (!configStatus.hasAnthropicKey) missingKeys.push('Anthropic');

  showState('error');
  document.getElementById('errorTitle').textContent = 'API Keys Missing';
  document.getElementById('errorMessage').textContent =
    `Please add your ${missingKeys.join(' and ')} API key(s) to config.js and reload the extension.`;
}


// ============================================================
// TAB SWITCHING
// ============================================================

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });

  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.panel === tabName);
  });

  // Start/stop playback tracking based on which tab is active
  if (tabName === 'transcript') {
    startPlaybackTracking();
  } else {
    stopPlaybackTracking();
  }

  // Lazy-load LLM analysis when user switches to Overview or Quotes tabs
  if ((tabName === 'overview' || tabName === 'quotes') && !currentAnalysis && !isAnalysisLoading) {
    triggerAnalysis();
  }

  // If a non-English language is selected, translate the tab content lazily
  // (only translate tabs that have content and haven't been translated yet)
  if (currentLanguage !== 'en' && tabName !== 'notes') {
    translateCurrentTab(tabName);
  }
}


/**
 * Triggers the LLM analysis (lazy-loaded when user clicks Overview or Quotes tab).
 * This saves tokens by not running analysis until needed.
 */
async function triggerAnalysis() {
  if (!currentTranscriptTimestamped || isAnalysisLoading || currentAnalysis) return;

  isAnalysisLoading = true;

  // Show loading indicator in the Overview tab
  const summaryText = document.getElementById('summaryText');
  const worthList = document.getElementById('worthWatchingList');
  const chapterList = document.getElementById('chapterList');
  const quotesList = document.getElementById('quotesList');

  if (summaryText) summaryText.innerHTML = '<span style="color: var(--text-muted);">Analyzing with Claude...</span>';
  if (worthList) worthList.innerHTML = '<li class="worth-item" style="color: var(--text-muted);">Loading...</li>';
  if (chapterList) chapterList.innerHTML = '<li class="chapter-item" style="color: var(--text-muted); border: none;">Loading chapters...</li>';
  if (quotesList) quotesList.innerHTML = '<div class="quote-item" style="color: var(--text-muted); border-left-color: var(--border);">Loading quotes...</div>';

  try {
    const analysisResult = await chrome.runtime.sendMessage({
      action: 'analyzeTranscript',
      transcriptText: currentTranscriptTimestamped,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoDescription: currentVideoDescription,
      videoDuration: currentVideoDuration
    });

    if (!analysisResult.success) {
      if (summaryText) summaryText.innerHTML = `<span style="color: var(--accent);">Analysis failed: ${analysisResult.error || 'Unknown error'}</span>`;
      isAnalysisLoading = false;
      return;
    }

    currentAnalysis = analysisResult.analysis;
    renderAnalysisResults(currentAnalysis);
    highlightMomentsOnPage(currentAnalysis.keyMoments);

    // Save to cache now that we have analysis
    await saveToCache(currentVideoId);

    // If a non-English language is selected, translate the tab that just loaded
    if (currentLanguage !== 'en') {
      const activeTab = document.querySelector('.tab.active')?.dataset.tab;
      if (activeTab === 'overview' || activeTab === 'quotes') {
        translateCurrentTab(activeTab);
      }
    }

  } catch (error) {
    console.error('[YT Digest Panel] Analysis error:', error);
    if (summaryText) summaryText.innerHTML = `<span style="color: var(--accent);">Error: ${error.message}</span>`;
  }

  isAnalysisLoading = false;
}


// ============================================================
// TIMESTAMP / SEEK
// ============================================================

async function seekTo(seconds) {
  console.log('[YT Digest Panel] seekTo called with:', seconds);
  if (seconds === undefined || seconds === null) {
    console.log('[YT Digest Panel] seekTo aborted - no seconds value');
    return;
  }

  try {
    // Route through background script for reliable message passing
    const result = await chrome.runtime.sendMessage({
      action: 'relayToContent',
      payload: {
        action: 'seekTo',
        seconds: Number(seconds)
      }
    });
    console.log('[YT Digest Panel] seekTo result:', result);
  } catch (error) {
    console.error('[YT Digest Panel] seekTo error:', error);
  }
}

async function highlightMomentsOnPage(moments) {
  if (!moments || !moments.length) return;

  try {
    // Route through background script for reliable message passing
    await chrome.runtime.sendMessage({
      action: 'relayToContent',
      payload: {
        action: 'highlightMoments',
        moments: moments,
        videoDuration: currentVideoDuration
      }
    });
  } catch (error) {
    console.error('Highlight error:', error);
  }
}


// ============================================================
// SHARE & COPY
// ============================================================

async function shareDigest() {
  const text = generateShareText();

  if (navigator.share) {
    try {
      await navigator.share({
        title: `YT Digest: ${currentVideoTitle}`,
        text: text
      });
    } catch (e) {
      await copyToClipboard(text);
    }
  } else {
    await copyToClipboard(text);
  }
}

async function copyDigest() {
  const text = generateShareText();
  await copyToClipboardWithFeedback(text, 'copyBtn');
}

function generateShareText() {
  if (!currentAnalysis) return '';

  const a = currentAnalysis;
  const url = `https://youtube.com/watch?v=${currentVideoId}`;

  let text = `📺 ${currentVideoTitle}\n`;
  text += `🔗 ${url}\n\n`;
  text += `${a.summary}\n\n`;
  text += `Worth watching if you're:\n`;
  (a.worthWatchingIf || []).forEach(statement => {
    text += `• ${statement}\n`;
  });
  text += '\n';

  if (a.chapters?.length) {
    text += `📑 CHAPTERS\n`;
    a.chapters.forEach(ch => {
      text += `  ${ch.timestamp} — ${ch.title}\n`;
    });
    text += '\n';
  }

  text += `— Generated by YT Digest`;
  return text;
}


// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error('Copy failed:', error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId) {
  const btn = document.getElementById(buttonId);
  const original = btn.textContent;

  const success = await copyToClipboard(text);
  if (success) {
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = original; }, 2000);
  }
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(str) {
  return (str || 'untitled')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 50)
    .toLowerCase();
}


// ============================================================
// FULLSCREEN REMIX
// ============================================================

/**
 * Opens the remix content in a fullscreen overlay in the MAIN browser window.
 * We send the content to the content script which injects it into the YouTube page,
 * so it fills the whole browser window instead of just the side panel.
 */
async function openFullscreenRemix() {
  if (!currentRemixContent) return;

  try {
    // Route through background script for reliable message passing
    await chrome.runtime.sendMessage({
      action: 'relayToContent',
      payload: {
        action: 'showFullscreenRemix',
        content: renderMarkdown(currentRemixContent),
        title: currentRemixStyleName,
        videoTitle: currentVideoTitle,
        channelName: currentChannelName
      }
    });
  } catch (error) {
    console.error('Failed to open fullscreen:', error);
  }
}


// ============================================================
// TEXT SELECTION — EXPLAIN FEATURE
// ============================================================

/**
 * Sets up text selection handling in the transcript.
 * When user selects text, shows an "Explain" button.
 */
function setupExplainFeature() {
  const transcriptList = document.getElementById('transcriptList');
  if (!transcriptList) return;

  // Remove existing tooltip if any
  const existingTooltip = document.getElementById('explainTooltip');
  if (existingTooltip) existingTooltip.remove();

  // Create the explain tooltip/button
  const tooltip = document.createElement('div');
  tooltip.id = 'explainTooltip';
  tooltip.className = 'explain-tooltip';
  tooltip.innerHTML = `<button class="explain-btn">💡 Explain</button>`;
  tooltip.style.display = 'none';
  document.body.appendChild(tooltip);

  let selectedText = '';

  // Listen for text selection
  document.addEventListener('mouseup', (e) => {
    const selection = window.getSelection();
    const text = selection.toString().trim();

    // Only show if selecting within transcript or remix content
    const isInTranscript = transcriptList.contains(selection.anchorNode);
    const remixContent = document.getElementById('remixContent');
    const isInRemix = remixContent && remixContent.contains(selection.anchorNode);

    // Allow any selection length (removed 10+ char requirement)
    if (text.length > 0 && (isInTranscript || isInRemix)) {
      selectedText = text;

      // Position the tooltip near the selection
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      tooltip.style.display = 'block';
      tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
      tooltip.style.left = `${rect.left + (rect.width / 2)}px`;
    } else {
      tooltip.style.display = 'none';
    }
  });

  // Hide tooltip when clicking elsewhere
  document.addEventListener('mousedown', (e) => {
    if (!tooltip.contains(e.target)) {
      tooltip.style.display = 'none';
    }
  });

  // Handle explain button click
  tooltip.querySelector('.explain-btn').addEventListener('click', async () => {
    if (!selectedText) return;

    tooltip.style.display = 'none';
    await showExplanation(selectedText);
  });
}

/**
 * Shows the explanation modal and fetches explanation from Claude.
 */
async function showExplanation(selectedText) {
  // Create modal
  const modal = document.createElement('div');
  modal.id = 'explainModal';
  modal.className = 'explain-modal-overlay';
  modal.innerHTML = `
    <div class="explain-modal">
      <div class="explain-modal-header">
        <div class="explain-modal-title">Explain</div>
        <button class="explain-modal-close" id="closeExplain">✕</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? '...' : ''}"</div>
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
  document.getElementById('closeExplain').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  // Get some context around the selection from the transcript
  const transcriptContext = getTranscriptContext(selectedText);

  // Fetch explanation
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'explainSelection',
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle: currentVideoTitle
    });

    const contentDiv = document.getElementById('explanationContent');
    if (result.success) {
      contentDiv.innerHTML = `<div class="explain-text">${escapeHtml(result.explanation).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</div>`;
    } else {
      contentDiv.innerHTML = `<div class="explain-error">Failed to get explanation: ${escapeHtml(result.error)}</div>`;
    }
  } catch (error) {
    const contentDiv = document.getElementById('explanationContent');
    contentDiv.innerHTML = `<div class="explain-error">Error: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText) {
  const fullText = currentEnhancedTranscript || currentTranscriptText || '';
  const index = fullText.indexOf(selectedText);

  if (index === -1) return '';

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
      analysis: currentAnalysis,           // May be null if not yet analyzed
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptSource: currentTranscriptSource,
      enhancedTranscript: currentEnhancedTranscript,
      remixContent: currentRemixContent,
      remixStyleName: currentRemixStyleName,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      translationCache: translationCacheForVideo,
      paragraphCache: paragraphCacheForVideo,
      timestamp: Date.now()
    };

    await chrome.storage.local.set({ [`digest_${videoId}`]: cacheData });
    console.log('Saved to cache:', videoId, currentAnalysis ? '(with analysis)' : '(transcript only)');

    // Evict old entries if we have more than 20 videos cached
    await evictOldCacheEntries(20);
  } catch (error) {
    console.error('Cache save error:', error);
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
    const digestKeys = Object.keys(allData).filter(k => k.startsWith('digest_'));

    if (digestKeys.length <= maxEntries) return;

    // Sort by timestamp (oldest first) and remove excess
    const sorted = digestKeys
      .map(k => ({ key: k, ts: allData[k]?.timestamp || 0 }))
      .sort((a, b) => a.ts - b.ts);

    const toRemove = sorted.slice(0, sorted.length - maxEntries).map(e => e.key);
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
      console.log(`[YT Digest] Evicted ${toRemove.length} old cache entries`);
    }
  } catch (error) {
    console.error('Cache eviction error:', error);
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
    console.error('Cache load error:', error);
    return null;
  }
}

/**
 * Updates the cache after remix or enhance operations.
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
      action: 'getNotes',
      videoId: videoId
    });

    if (result.success) {
      renderNotes(result.notes, videoId);
    }
  } catch (error) {
    console.error('[YT Digest Panel] Load notes error:', error);
  }
}

/**
 * Renders the notes list in the Notes tab.
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById('notesList');
  const notesIntro = document.getElementById('notesIntro');

  if (!notesList) return;

  notesList.innerHTML = '';

  if (!notes || notes.length === 0) {
    notesIntro.style.display = 'block';
    notesIntro.textContent = filteredVideoId
      ? 'No notes for this video yet. Hover over the video and click 📝 Note to save.'
      : 'No notes saved yet. Hover over a video and click 📝 Note to save.';
    return;
  }

  notesIntro.style.display = 'none';

  notes.forEach(note => {
    const noteEl = document.createElement('div');
    noteEl.className = 'note-item';
    noteEl.innerHTML = `
      <div class="note-header">
        <span class="note-timestamp" data-url="${escapeHtml(note.timestampedUrl)}" data-seconds="${note.timestampSeconds}">${note.timestamp}</span>
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ''}
        <button class="note-delete" data-id="${note.id}" title="Delete note">✕</button>
      </div>
      <div class="note-text">"${escapeHtml(note.text)}"</div>
      <div class="note-actions">
        <button class="note-action-btn note-copy-link" data-url="${escapeHtml(note.timestampedUrl)}">🔗 Copy Link</button>
        <button class="note-action-btn note-play" data-seconds="${note.timestampSeconds}">▶ Play</button>
      </div>
    `;

    // Timestamp click - play from this point
    noteEl.querySelector('.note-timestamp').addEventListener('click', () => {
      seekTo(note.timestampSeconds);
    });

    // Delete button
    noteEl.querySelector('.note-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteNote(note.id);
      loadNotes(filteredVideoId);
    });

    // Copy link button
    noteEl.querySelector('.note-copy-link').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(note.timestampedUrl);
        const btn = noteEl.querySelector('.note-copy-link');
        btn.textContent = '✓ Copied!';
        setTimeout(() => { btn.textContent = '🔗 Copy Link'; }, 2000);
      } catch (err) {
        console.error('Copy failed:', err);
      }
    });

    // Play button
    noteEl.querySelector('.note-play').addEventListener('click', () => {
      seekTo(note.timestampSeconds);
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
      action: 'deleteNote',
      noteId: noteId
    });
  } catch (error) {
    console.error('[YT Digest Panel] Delete note error:', error);
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
  if (isTranscriptEnhanced) return;
  if (!currentTranscript || !currentTranscript.length) return;

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  autoScrollEnabled = true;
  document.getElementById('followPlaybackBtn').style.display = 'none';

  // Poll video time every 500ms
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);

  // Listen for manual scrolls on the content area
  const contentArea = document.getElementById('contentArea');
  contentArea.removeEventListener('scroll', onContentAreaScroll);
  contentArea.addEventListener('scroll', onContentAreaScroll);
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
  document.getElementById('followPlaybackBtn').style.display = 'none';

  // Remove active highlights
  document.querySelectorAll('.transcript-entry.active-playback').forEach(el => {
    el.classList.remove('active-playback');
  });
}

/**
 * One tick of the playback tracker. Gets current video time from the
 * YouTube tab and highlights + scrolls to the matching transcript entry.
 */
async function playbackTrackingTick() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'relayToContent',
      payload: { action: 'getCurrentTime' }
    });

    if (!result.success || !result.response) return;

    const currentTime = result.response.currentTime || 0;
    highlightActiveEntry(currentTime);
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away
  }
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds) {
  const transcriptList = document.getElementById('transcriptList');
  if (!transcriptList) return;

  const entries = transcriptList.querySelectorAll('.transcript-entry');
  if (entries.length === 0) return;

  // Find the entry whose time range contains the current playback time
  let activeEntry = null;
  entries.forEach((entry, index) => {
    const entrySeconds = parseInt(entry.dataset.seconds);
    const nextEntry = entries[index + 1];
    const nextSeconds = nextEntry ? parseInt(nextEntry.dataset.seconds) : Infinity;

    if (currentSeconds >= entrySeconds && currentSeconds < nextSeconds) {
      activeEntry = entry;
    }
  });

  if (!activeEntry) return;

  // Skip if this entry is already highlighted (no DOM thrashing)
  if (activeEntry.classList.contains('active-playback')) return;

  // Remove old highlight, add new one
  entries.forEach(e => e.classList.remove('active-playback'));
  activeEntry.classList.add('active-playback');

  // Only scroll if auto-scroll is enabled
  if (autoScrollEnabled) {
    lastAutoScrollTime = Date.now();
    activeEntry.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    document.getElementById('followPlaybackBtn').style.display = 'block';
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
  const selector = document.getElementById('langSelector');
  if (newLang !== 'en') {
    selector.classList.add('active-lang');
  } else {
    selector.classList.remove('active-lang');
  }

  // If switching back to English, just re-render originals instantly
  if (newLang === 'en') {
    restoreOriginalContent();
    return;
  }

  // Otherwise, translate the currently visible tab
  const activeTab = document.querySelector('.tab.active')?.dataset.tab;
  if (activeTab && activeTab !== 'notes') {
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
  if (isTranscriptEnhanced && currentEnhancedTranscript) {
    renderEnhancedTranscript(currentEnhancedTranscript);
  } else if (currentTranscript) {
    renderTranscript();
  }

  // Overview
  if (currentAnalysis) {
    renderAnalysisResults(currentAnalysis);
  }

  // Remix
  if (currentRemixContent && currentRemixStyleName) {
    document.getElementById('remixContent').innerHTML = renderMarkdown(currentRemixContent);
  }
}

/**
 * Translates the content of the currently active tab.
 * Checks the cache first — only makes an API call if uncached.
 *
 * @param {string} tabName - 'transcript', 'overview', 'quotes', or 'remix'
 */
async function translateCurrentTab(tabName) {
  // Don't translate notes (user-generated content)
  if (tabName === 'notes') return;

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
    case 'transcript':
      await translateTranscript();
      break;
    case 'overview':
      await translateOverview();
      break;
    case 'quotes':
      await translateQuotes();
      break;
    case 'remix':
      await translateRemix();
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
    case 'transcript':
      return !!(currentEnhancedTranscript || currentTranscriptText);
    case 'overview':
      return !!currentAnalysis;
    case 'quotes':
      return !!(currentAnalysis?.keyQuotes?.length);
    case 'remix':
      return !!currentRemixContent;
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
  const spinner = document.getElementById('langSpinner');
  if (spinner) {
    spinner.classList.toggle('visible', show);
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

  // --- ENHANCED TRANSCRIPT MODE ---
  // No timestamps to preserve — use paragraph-based lazy translation
  if (isTranscriptEnhanced && currentEnhancedTranscript) {
    const sourceText = currentEnhancedTranscript;
    const lang = currentLanguage;
    const paragraphCachePrefix = `${currentVideoId}:${lang}:para:`;
    const paragraphs = sourceText.split(/\n\n+/).filter(p => p.trim());

    if (transcriptScrollObserver) {
      transcriptScrollObserver.disconnect();
      transcriptScrollObserver = null;
    }

    const transcriptList = document.getElementById('transcriptList');
    transcriptList.innerHTML = '';

    paragraphs.forEach((para, index) => {
      const div = document.createElement('div');
      div.className = 'transcript-paragraph';
      div.dataset.paraIndex = index;

      const cached = transcriptParagraphCache.get(paragraphCachePrefix + index);
      if (cached) {
        div.textContent = cached;
        div.classList.add('translated');
      } else {
        div.textContent = para.trim();
        div.classList.add('translating');
      }

      transcriptList.appendChild(div);
    });

    const scrollContainer = document.getElementById('contentArea');
    const pendingBatches = new Set();

    transcriptScrollObserver = new IntersectionObserver((entries) => {
      const needsTranslation = [];

      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const div = entry.target;
        const index = parseInt(div.dataset.paraIndex);
        if (div.classList.contains('translated')) return;
        if (pendingBatches.has(index)) return;
        needsTranslation.push(index);
      });

      if (needsTranslation.length === 0) return;

      const maxIndex = Math.max(...needsTranslation);
      const bufferCount = 3;
      const batchIndices = [];

      for (let i = Math.min(...needsTranslation); i <= Math.min(maxIndex + bufferCount, paragraphs.length - 1); i++) {
        if (!transcriptParagraphCache.has(paragraphCachePrefix + i) && !pendingBatches.has(i)) {
          batchIndices.push(i);
          pendingBatches.add(i);
        }
      }

      if (batchIndices.length === 0) return;

      translateParagraphBatch(batchIndices, paragraphs, lang, paragraphCachePrefix, pendingBatches);
    }, {
      root: scrollContainer,
      rootMargin: '200px 0px',
      threshold: 0
    });

    transcriptList.querySelectorAll('.transcript-paragraph:not(.translated)').forEach(div => {
      transcriptScrollObserver.observe(div);
    });

    return; // Done — enhanced mode handled
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
  const originalTexts = grouped.map(g => g.texts.join(' '));

  // Re-render the raw transcript to get fresh .transcript-entry elements
  renderTranscript();

  // Get all rendered entries and add index + translation state
  const transcriptList = document.getElementById('transcriptList');
  const entries = transcriptList.querySelectorAll('.transcript-entry');

  entries.forEach((entry, index) => {
    entry.dataset.entryIndex = index;

    const cached = transcriptParagraphCache.get(entryCachePrefix + index);
    if (cached) {
      // Replace just the text portion, keep timestamp intact
      const textSpan = entry.querySelector('.transcript-text');
      if (textSpan) textSpan.textContent = cached;
      entry.classList.add('translated');
    } else {
      // Mark as pending translation (dimmed with pulsing indicator)
      entry.classList.add('translating');
    }
  });

  // Set up queue-based sequential translation.
  // Instead of firing API calls for ALL visible entries at once (which floods
  // the API and makes everything slow), we queue them and process 5 at a time.
  // This way results appear progressively — first 5 entries translate, then next 5, etc.
  const scrollContainer = document.getElementById('contentArea');
  const pendingBatches = new Set();
  const batchQueue = [];       // Queue of entry indices waiting to be translated
  let isProcessingQueue = false;

  // Pulls up to 5 entries from the queue and translates them, then repeats
  async function processNextBatch() {
    if (isProcessingQueue || batchQueue.length === 0) return;
    if (lang !== lastRequestedLanguage) return; // Language changed, abort

    isProcessingQueue = true;
    const batch = batchQueue.splice(0, 1); // Translate 1 entry per API call — fast response
    await translateEntryBatch(batch, originalTexts, lang, entryCachePrefix, pendingBatches);
    isProcessingQueue = false;

    // If there are more entries queued, process the next batch
    if (batchQueue.length > 0) {
      processNextBatch();
    } else {
      // Queue empty — persist translations to storage so reopening this video is instant
      updateCache();
    }
  }

  transcriptScrollObserver = new IntersectionObserver((observerEntries) => {
    let addedNew = false;

    observerEntries.forEach(obsEntry => {
      if (!obsEntry.isIntersecting) return;
      const div = obsEntry.target;
      const index = parseInt(div.dataset.entryIndex);
      if (div.classList.contains('translated')) return;
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
  }, {
    root: scrollContainer,
    rootMargin: '300px 0px', // 300px ahead for smooth pre-loading
    threshold: 0
  });

  // Start observing all untranslated entries
  entries.forEach(entry => {
    if (!entry.classList.contains('translated')) {
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
async function translateEntryBatch(indices, originalTexts, lang, cachePrefix, pendingBatches) {
  // Join batch entries with delimiter so we translate them in one API call
  const DELIMITER = '\n\n---PARAGRAPH_BREAK---\n\n';
  const batchText = indices.map(i => originalTexts[i]).join(DELIMITER);

  setTranslatingSpinner(true);

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'translateContent',
      content: batchText,
      contentType: 'transcript',
      targetLanguage: lang,
      videoTitle: currentVideoTitle
    });

    // Guard: if user switched language while we were translating, discard result
    if (lang !== lastRequestedLanguage) return;

    if (result.success && result.translatedContent) {
      // Split translated text back into individual entries
      const translatedParts = result.translatedContent.split(/---PARAGRAPH_BREAK---/);

      indices.forEach((entryIndex, i) => {
        const translatedText = (translatedParts[i] || '').trim();
        if (!translatedText) return;

        // Cache this entry's translation
        transcriptParagraphCache.set(cachePrefix + entryIndex, translatedText);

        // Update the DOM: replace text span content, keep timestamp
        const entry = document.querySelector(
          `.transcript-entry[data-entry-index="${entryIndex}"]`
        );
        if (entry) {
          const textSpan = entry.querySelector('.transcript-text');
          if (textSpan) textSpan.textContent = translatedText;
          entry.classList.remove('translating');
          entry.classList.add('translated');

          // Stop observing — this entry is done
          if (transcriptScrollObserver) {
            transcriptScrollObserver.unobserve(entry);
          }
        }
      });

      // Update the full transcript cache for instant tab-switching
      updateFullTranscriptCache(lang);
    } else {
      console.error('[YT Digest] Entry batch translation failed:', result.error);
    }
  } catch (error) {
    console.error('[YT Digest] Entry batch translation error:', error);
  } finally {
    indices.forEach(i => pendingBatches.delete(i));
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
async function translateParagraphBatch(indices, paragraphs, lang, cachePrefix, pendingBatches) {
  // Combine the batch paragraphs into one string separated by a unique delimiter
  // The API translates them as one block, then we split them back apart
  const DELIMITER = '\n\n---PARAGRAPH_BREAK---\n\n';
  const batchText = indices.map(i => paragraphs[i].trim()).join(DELIMITER);

  setTranslatingSpinner(true);

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'translateContent',
      content: batchText,
      contentType: 'transcript',
      targetLanguage: lang,
      videoTitle: currentVideoTitle
    });

    // Guard: if user switched language while translating, discard
    if (lang !== lastRequestedLanguage) return;

    if (result.success && result.translatedContent) {
      // Split the translated text back into individual paragraphs
      const translatedParts = result.translatedContent.split(/---PARAGRAPH_BREAK---/);

      indices.forEach((paraIndex, i) => {
        const translatedText = (translatedParts[i] || '').trim();
        if (!translatedText) return;

        // Cache the translated paragraph
        transcriptParagraphCache.set(cachePrefix + paraIndex, translatedText);

        // Update the DOM element
        const div = document.querySelector(
          `.transcript-paragraph[data-para-index="${paraIndex}"]`
        );
        if (div) {
          div.textContent = translatedText;
          div.classList.remove('translating');
          div.classList.add('translated');

          // Stop observing this paragraph (it's done)
          if (transcriptScrollObserver) {
            transcriptScrollObserver.unobserve(div);
          }
        }
      });

      // Also update the full transcript cache so switching back and forth is instant
      updateFullTranscriptCache(lang);
    } else {
      console.error('[YT Digest] Paragraph batch translation failed:', result.error);
    }
  } catch (error) {
    console.error('[YT Digest] Paragraph batch translation error:', error);
  } finally {
    // Remove from pending set
    indices.forEach(i => pendingBatches.delete(i));
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

  if (!isTranscriptEnhanced && currentTranscript) {
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
      translationCache.set(fullCacheKey, JSON.stringify({ type: 'entries', entries: translatedEntries }));
    }
  } else {
    // Enhanced transcript mode: collect per-paragraph translations
    const paraPrefix = `${currentVideoId}:${lang}:para:`;
    const translatedParagraphs = [];
    let index = 0;
    while (transcriptParagraphCache.has(paraPrefix + index)) {
      translatedParagraphs.push(transcriptParagraphCache.get(paraPrefix + index));
      index++;
    }
    if (translatedParagraphs.length > 0) {
      translationCache.set(fullCacheKey, translatedParagraphs.join('\n\n'));
    }
  }
}

/**
 * Translates the overview tab content (summary, worth-watching, tags, chapters).
 * Sends the entire analysis object as JSON and gets back translated JSON.
 */
async function translateOverview() {
  if (!currentAnalysis) return;

  const lang = currentLanguage;
  const cacheKey = `${currentVideoId}:${lang}:overview`;

  setTranslatingSpinner(true);

  try {
    // Build a JSON payload with just the translatable fields
    const overviewPayload = {
      summary: currentAnalysis.summary,
      worthWatchingIf: currentAnalysis.worthWatchingIf,
      tags: currentAnalysis.tags,
      chapters: (currentAnalysis.chapters || []).map(ch => ({
        title: ch.title,
        summary: ch.summary || '',
        timestamp: ch.timestamp,
        timestampSeconds: ch.timestampSeconds
      }))
    };

    const result = await chrome.runtime.sendMessage({
      action: 'translateContent',
      content: overviewPayload,
      contentType: 'overview',
      targetLanguage: lang,
      videoTitle: currentVideoTitle
    });

    if (lang !== lastRequestedLanguage) return;

    if (result.success && result.translatedContent) {
      translationCache.set(cacheKey, result.translatedContent);
      renderTranslatedContent('overview', result.translatedContent);
      await updateCache(); // Persist translation to storage
    } else {
      console.error('[YT Digest] Overview translation failed:', result.error);
    }
  } catch (error) {
    console.error('[YT Digest] Overview translation error:', error);
  } finally {
    setTranslatingSpinner(false);
  }
}

/**
 * Translates the quotes tab content.
 * Sends the quotes array as JSON and gets back translated JSON.
 */
async function translateQuotes() {
  if (!currentAnalysis?.keyQuotes?.length) return;

  const lang = currentLanguage;
  const cacheKey = `${currentVideoId}:${lang}:quotes`;

  setTranslatingSpinner(true);

  try {
    // Send only the translatable fields (quote text), keep timestamps intact
    const quotesPayload = currentAnalysis.keyQuotes.map(q => ({
      quote: q.quote,
      timestamp: q.timestamp,
      timestampSeconds: q.timestampSeconds
    }));

    const result = await chrome.runtime.sendMessage({
      action: 'translateContent',
      content: quotesPayload,
      contentType: 'quotes',
      targetLanguage: lang,
      videoTitle: currentVideoTitle
    });

    if (lang !== lastRequestedLanguage) return;

    if (result.success && result.translatedContent) {
      translationCache.set(cacheKey, result.translatedContent);
      renderTranslatedContent('quotes', result.translatedContent);
      await updateCache(); // Persist translation to storage
    } else {
      console.error('[YT Digest] Quotes translation failed:', result.error);
    }
  } catch (error) {
    console.error('[YT Digest] Quotes translation error:', error);
  } finally {
    setTranslatingSpinner(false);
  }
}

/**
 * Translates the remix tab content (markdown string).
 */
async function translateRemix() {
  if (!currentRemixContent) return;

  const lang = currentLanguage;
  const cacheKey = `${currentVideoId}:${lang}:remix`;

  setTranslatingSpinner(true);

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'translateContent',
      content: currentRemixContent,
      contentType: 'remix',
      targetLanguage: lang,
      videoTitle: currentVideoTitle
    });

    if (lang !== lastRequestedLanguage) return;

    if (result.success) {
      translationCache.set(cacheKey, result.translatedContent);
      renderTranslatedContent('remix', result.translatedContent);
      await updateCache(); // Persist translation to storage
    } else {
      console.error('[YT Digest] Remix translation failed:', result.error);
    }
  } catch (error) {
    console.error('[YT Digest] Remix translation error:', error);
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
    case 'transcript':
      renderTranslatedTranscript(translatedContent);
      break;
    case 'overview':
      renderTranslatedOverview(translatedContent);
      break;
    case 'quotes':
      renderTranslatedQuotes(translatedContent);
      break;
    case 'remix':
      renderTranslatedRemix(translatedContent);
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
  const transcriptList = document.getElementById('transcriptList');
  transcriptList.innerHTML = '';

  // Try to parse as structured data (raw transcript mode stores as JSON with type marker)
  let parsed = null;
  if (typeof translatedData === 'string') {
    try {
      const obj = JSON.parse(translatedData);
      if (obj && obj.type === 'entries') {
        parsed = obj;
      }
    } catch (e) {
      // Not JSON — it's an enhanced transcript (plain text)
    }
  }

  // Raw transcript mode: render with timestamps
  if (parsed && parsed.type === 'entries' && currentTranscript && currentTranscript.length) {
    // Re-compute groups using the same smart chunking logic
    const grouped = groupTranscriptEntries(currentTranscript);

    grouped.forEach((group, index) => {
      const div = document.createElement('div');
      div.className = 'transcript-entry translated';
      div.dataset.seconds = group.start;
      div.dataset.entryIndex = index;

      const minutes = Math.floor(group.start / 60);
      const seconds = group.start % 60;
      const timestamp = `${minutes}:${String(seconds).padStart(2, '0')}`;

      // Use translated text if available, fall back to original
      const translatedText = parsed.entries[index] || group.texts.join(' ');

      div.innerHTML = `
        <span class="transcript-time">${timestamp}</span>
        <span class="transcript-text">${escapeHtml(translatedText)}</span>
      `;

      div.addEventListener('click', () => seekTo(group.start));
      transcriptList.appendChild(div);
    });

    return;
  }

  // Enhanced transcript mode: render as paragraphs
  const text = typeof translatedData === 'string' ? translatedData : '';
  const paragraphs = text.split(/\n\n+/);

  paragraphs.forEach((para, index) => {
    if (!para.trim()) return;

    const div = document.createElement('div');
    div.className = 'transcript-paragraph translated';
    div.dataset.paraIndex = index;
    div.textContent = para.trim();
    transcriptList.appendChild(div);
  });
}

/**
 * Renders translated overview content.
 * Merges translated text fields with original timestamps/structure.
 *
 * @param {Object} translatedOverview - Object with summary, worthWatchingIf, tags, chapters
 */
function renderTranslatedOverview(translatedOverview) {
  // Summary
  if (translatedOverview.summary) {
    document.getElementById('summaryText').textContent = translatedOverview.summary;
  }

  // Worth watching if
  if (translatedOverview.worthWatchingIf) {
    const worthList = document.getElementById('worthWatchingList');
    worthList.innerHTML = '';
    translatedOverview.worthWatchingIf.forEach(statement => {
      const li = document.createElement('li');
      li.className = 'worth-item';
      li.textContent = statement;
      worthList.appendChild(li);
    });
  }

  // Tags
  if (translatedOverview.tags) {
    const tagsContainer = document.getElementById('tagsContainer');
    tagsContainer.innerHTML = '';
    translatedOverview.tags.forEach(tag => {
      const tagEl = document.createElement('span');
      tagEl.className = 'tag';
      tagEl.textContent = tag;
      tagsContainer.appendChild(tagEl);
    });
  }

  // Chapters — use translated title/summary but keep original timestamps
  if (translatedOverview.chapters) {
    const chapterList = document.getElementById('chapterList');
    chapterList.innerHTML = '';

    translatedOverview.chapters.forEach((chapter, index) => {
      // Grab the original timestamp data (fallback to translated data if same structure)
      const origChapter = currentAnalysis?.chapters?.[index] || chapter;
      const li = document.createElement('li');
      li.className = 'chapter-item';
      li.dataset.seconds = origChapter.timestampSeconds || chapter.timestampSeconds;
      li.innerHTML = `
        <span class="chapter-timestamp">${origChapter.timestamp || chapter.timestamp}</span>
        <div class="chapter-content">
          <span class="chapter-title">${escapeHtml(chapter.title)}</span>
          <span class="chapter-summary">${escapeHtml(chapter.summary || '')}</span>
        </div>
      `;
      li.addEventListener('click', () => {
        seekTo(origChapter.timestampSeconds || chapter.timestampSeconds);
      });
      chapterList.appendChild(li);
    });
  }
}

/**
 * Renders translated quotes.
 * Merges translated quote text with original timestamps.
 *
 * @param {Array} translatedQuotes - Array of {quote, timestamp, timestampSeconds}
 */
function renderTranslatedQuotes(translatedQuotes) {
  const quotesList = document.getElementById('quotesList');
  quotesList.innerHTML = '';

  // Sort by timestamp (chronological order) — same as original rendering
  const sorted = [...translatedQuotes].sort((a, b) =>
    (a.timestampSeconds || 0) - (b.timestampSeconds || 0)
  );

  sorted.forEach((quote, index) => {
    // Use original timestamp data for reliability
    const origQuote = currentAnalysis?.keyQuotes?.[index] || quote;
    const div = document.createElement('div');
    div.className = 'quote-item';
    div.dataset.seconds = origQuote.timestampSeconds || quote.timestampSeconds;
    div.innerHTML = `
      <div class="quote-text">${escapeHtml(quote.quote)}</div>
      <div class="quote-meta">
        <span class="quote-timestamp">${origQuote.timestamp || quote.timestamp}</span>
      </div>
    `;
    div.addEventListener('click', () => {
      seekTo(origQuote.timestampSeconds || quote.timestampSeconds);
    });
    quotesList.appendChild(div);
  });
}

/**
 * Renders a translated remix (markdown string).
 *
 * @param {string} translatedRemix - The translated markdown text
 */
function renderTranslatedRemix(translatedRemix) {
  const remixContent = document.getElementById('remixContent');
  if (remixContent) {
    remixContent.innerHTML = renderMarkdown(translatedRemix);
  }
}

/**
 * Clears translation cache entries for a specific content type.
 * Called when content changes (e.g., after enhancing transcript).
 *
 * @param {string} contentType - 'transcript', 'overview', 'quotes', or 'remix'
 */
function clearTranslationCacheForType(contentType) {
  // Delete all cache entries that match this content type
  for (const key of translationCache.keys()) {
    if (key.endsWith(`:${contentType}`)) {
      translationCache.delete(key);
    }
  }

  // If clearing transcript, also clear the per-paragraph cache
  if (contentType === 'transcript') {
    transcriptParagraphCache.clear();
  }
}

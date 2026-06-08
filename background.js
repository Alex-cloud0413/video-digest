/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching YouTube transcripts via Supadata API
 * 3. Calling the Claude API to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import config (API keys are stored in config.js)
importScripts('config.js');
importScripts('remix-prompts.js');


// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.action.onClicked.addListener((tab) => {
  // Re-enable + open without awaiting — preserves user gesture context
  chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true });
  chrome.sidePanel.open({ tabId: tab.id });
});

/**
 * Allow the side panel to open on any page, but it's designed for YouTube.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

/**
 * Auto-close side panel when the user navigates away from YouTube.
 *
 * We use chrome.sidePanel.setOptions() to enable/disable the panel per tab.
 * When disabled on a tab, Chrome automatically closes the panel for that tab.
 * When the user returns to YouTube, we re-enable it (they can reopen with the icon).
 *
 * Important: We ONLY disable on non-YouTube navigation. We never proactively
 * set enabled:true here — that's handled by the open handlers (Digest button,
 * extension icon) right before opening. This avoids race conditions.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only react to URL changes (not title changes, favicon, etc.)
  if (!changeInfo.url) return;

  const isYouTube = changeInfo.url.startsWith('https://www.youtube.com');

  if (!isYouTube) {
    // Disable panel on non-YouTube pages — this auto-closes it
    chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: false });
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
  if (message.action === 'fetchTranscript') {
    handleFetchTranscript(message.videoId, message.videoUrl)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true; // Keep the message channel open for async response
  }

  if (message.action === 'analyzeTranscript') {
    // Pass video duration to help Claude validate timestamps
    handleAnalyzeTranscript(message.transcriptText, message.videoTitle, message.channelName, message.videoDescription, message.videoDuration)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === 'explainSelection') {
    // New: Explain selected text using Claude
    handleExplainSelection(message.selectedText, message.transcriptContext, message.videoTitle)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === 'enhanceTranscript') {
    handleEnhanceTranscript(message.transcriptText, message.videoTitle, message.videoDescription)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === 'remixTranscript') {
    handleRemixTranscript(message.transcriptText, message.videoTitle, message.channelName, message.videoDescription, message.style)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === 'getRemixStyles') {
    // Return available remix styles
    const styles = Object.entries(REMIX_PROMPTS).map(([key, value]) => ({
      id: key,
      name: value.name,
      description: value.description
    }));
    sendResponse({ success: true, styles });
    return false;
  }

  if (message.action === 'saveNote') {
    // Save a note at the current timestamp
    handleSaveNote(message.videoId, message.timestamp, message.videoTitle, message.channelName, message.videoUrl)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'getNotes') {
    // Get all saved notes
    handleGetNotes(message.videoId)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'deleteNote') {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'getVideoInfo') {
    handleGetVideoInfo(message.tabId)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  // Translation: send content to DeepSeek for translation into ZH or JA
  if (message.action === 'translateContent') {
    handleTranslateContent(message.content, message.contentType, message.targetLanguage, message.videoTitle)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'checkConfig') {
    // Check if API keys are configured
    sendResponse({
      hasSupadataKey: !!CONFIG.SUPADATA_API_KEY,
      hasAnthropicKey: !!CONFIG.ANTHROPIC_API_KEY
    });
    return false;
  }

  if (message.action === 'openSidePanel') {
    const tabId = sender.tab?.id;
    console.log('[YT Digest BG] openSidePanel requested from tab:', tabId);

    // Re-enable the panel (it may have been disabled by auto-close) and open it.
    // IMPORTANT: we call setOptions + open synchronously (no await between them)
    // to preserve the user gesture context. Chrome requires sidePanel.open()
    // to be called within a user gesture — awaiting anything first can expire it.
    if (tabId) {
      chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
      chrome.sidePanel.open({ tabId }).then(() => {
        // Broadcast to side panel to start digest (in case it's already open)
        setTimeout(() => {
          chrome.runtime.sendMessage({ action: 'startDigestFromButton' }).catch(() => {});
        }, 300);
      }).catch(err => {
        console.error('[YT Digest BG] openSidePanel error:', err);
      });
    } else {
      // Fallback: find the active tab
      chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(tabs => {
        if (tabs[0]) {
          chrome.sidePanel.setOptions({ tabId: tabs[0].id, path: 'sidepanel.html', enabled: true });
          chrome.sidePanel.open({ tabId: tabs[0].id }).catch(err => {
            console.error('[YT Digest BG] openSidePanel fallback error:', err);
          });
        }
      });
    }

    sendResponse({ success: true });
    return false;
  }

  // Relay messages from side panel to content script
  if (message.action === 'relayToContent') {
    console.log('[YT Digest BG] Relay request:', message.payload?.action);
    (async () => {
      try {
        // Query specifically for YouTube tabs to avoid side panel context issues
        // Try multiple query strategies to find the right tab
        let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        console.log('[YT Digest BG] Active tab in last focused window:', tabs.length, tabs[0]?.url);

        // If no YouTube tab found, try broader query
        if (!tabs[0] || !tabs[0].url?.includes('youtube.com')) {
          tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*', active: true });
          console.log('[YT Digest BG] Active YouTube tabs:', tabs.length);
        }

        // Still nothing? Try any YouTube tab
        if (!tabs[0]) {
          tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
          console.log('[YT Digest BG] Any YouTube tabs:', tabs.length);
        }

        if (tabs[0]) {
          console.log('[YT Digest BG] Sending to tab:', tabs[0].id, 'URL:', tabs[0].url);
          const response = await chrome.tabs.sendMessage(tabs[0].id, message.payload);
          console.log('[YT Digest BG] Got response from content:', response);
          sendResponse({ success: true, response });
        } else {
          console.log('[YT Digest BG] No YouTube tab found');
          sendResponse({ success: false, error: 'No YouTube tab found' });
        }
      } catch (err) {
        console.error('[YT Digest BG] Relay error:', err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }
});


// ============================================================
// TRANSCRIPT FETCHING VIA SUPADATA API
// ============================================================

/**
 * Fetches the transcript for a YouTube video using Supadata API.
 *
 * Supadata is a specialized service that reliably extracts transcripts
 * from YouTube videos. It handles all the complexity of parsing YouTube's
 * internal data structures, dealing with different caption formats, etc.
 *
 * API Docs: https://docs.supadata.ai
 *
 * @param {string} videoId - The YouTube video ID (e.g., "dQw4w9WgXcQ")
 * @param {string} videoUrl - The full YouTube URL
 * @returns {Object} - { success, transcript, transcriptText, language } or { success: false, error }
 */
async function handleFetchTranscript(videoId, videoUrl) {
  try {
    // Check if Supadata API key is configured
    if (!CONFIG.SUPADATA_API_KEY) {
      return {
        success: false,
        error: 'NO_SUPADATA_KEY',
        message: 'Supadata API key not configured. Please add it to config.js'
      };
    }

    // Build the Supadata API URL
    // Using the universal transcript endpoint with text=false to get timestamped chunks
    const apiUrl = new URL('https://api.supadata.ai/v1/transcript');
    apiUrl.searchParams.set('url', videoUrl || `https://www.youtube.com/watch?v=${videoId}`);
    apiUrl.searchParams.set('text', 'false'); // Get timestamped chunks, not plain text
    apiUrl.searchParams.set('lang', 'en'); // Prefer English

    // Make the API request
    const response = await fetch(apiUrl.toString(), {
      method: 'GET',
      headers: {
        'x-api-key': CONFIG.SUPADATA_API_KEY
      }
    });

    // Handle async jobs (for videos > 20 minutes, Supadata returns a job ID)
    if (response.status === 202) {
      const jobData = await response.json();
      // Poll for the result
      return await pollTranscriptJob(jobData.jobId);
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 401) {
        return {
          success: false,
          error: 'INVALID_SUPADATA_KEY',
          message: 'Your Supadata API key is invalid. Please check config.js'
        };
      }
      if (response.status === 404) {
        return {
          success: false,
          error: 'NO_TRANSCRIPT',
          message: 'No subtitles found for this video.'
        };
      }
      if (response.status === 429) {
        return {
          success: false,
          error: 'RATE_LIMITED',
          message: 'Supadata rate limit reached. Please wait a minute and try again.'
        };
      }
      throw new Error(errorData.message || `Supadata API error: ${response.status}`);
    }

    const data = await response.json();

    // Parse the response into our internal format
    // Supadata returns: { content: [{ text, offset, duration, lang }], lang, availableLangs }
    const transcript = [];
    let transcriptTextPlain = '';      // Plain text for display/export
    let transcriptTextTimestamped = ''; // Timestamped text for Claude analysis

    if (data.content && Array.isArray(data.content)) {
      for (const chunk of data.content) {
        if (chunk.text) {
          // Clean up caption artifacts:
          // ">>" = speaker change marker from YouTube auto-captions
          const cleanText = chunk.text.replace(/>> ?/g, '').trim();
          if (!cleanText) continue; // Skip if nothing left after cleanup

          // offset is in milliseconds, convert to seconds
          const startSeconds = Math.floor((chunk.offset || 0) / 1000);
          const minutes = Math.floor(startSeconds / 60);
          const seconds = startSeconds % 60;
          const timestamp = `${minutes}:${String(seconds).padStart(2, '0')}`;

          transcript.push({
            text: cleanText,
            start: startSeconds,
            duration: Math.floor((chunk.duration || 0) / 1000)
          });

          // Plain text without timestamps (for display/export)
          transcriptTextPlain += cleanText + ' ';

          // Timestamped text for Claude (format: [MM:SS] text)
          // This allows Claude to reference actual timestamps from the transcript
          transcriptTextTimestamped += `[${timestamp}] ${cleanText}\n`;
        }
      }
    }

    if (transcript.length === 0) {
      return {
        success: false,
        error: 'EMPTY_TRANSCRIPT',
        message: 'Supadata returned an empty transcript for this video.'
      };
    }

    return {
      success: true,
      transcript: transcript,
      transcriptText: transcriptTextPlain.trim(),           // For display
      transcriptTextTimestamped: transcriptTextTimestamped.trim(), // For Claude
      language: data.lang || 'en',
      videoId: videoId
    };

  } catch (error) {
    console.error('Transcript fetch error:', error);
    return {
      success: false,
      error: error.message || 'Failed to fetch transcript'
    };
  }
}


/**
 * Polls for transcript job completion (for long videos).
 * Supadata processes videos > 20 minutes asynchronously.
 *
 * @param {string} jobId - The job ID returned by the initial request
 * @returns {Object} - Same format as handleFetchTranscript
 */
async function pollTranscriptJob(jobId) {
  const maxAttempts = 60; // Max 60 seconds of polling
  const pollInterval = 1000; // Poll every 1 second

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Wait before polling
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const response = await fetch(`https://api.supadata.ai/v1/transcript/${jobId}`, {
      headers: { 'x-api-key': CONFIG.SUPADATA_API_KEY }
    });

    if (!response.ok) {
      throw new Error(`Job polling failed: ${response.status}`);
    }

    const data = await response.json();

    if (data.status === 'completed') {
      // Parse the completed transcript
      const transcript = [];
      let transcriptTextPlain = '';
      let transcriptTextTimestamped = '';

      if (data.content && Array.isArray(data.content)) {
        for (const chunk of data.content) {
          if (chunk.text) {
            // Clean up caption artifacts (">>" = speaker change marker)
            const cleanText = chunk.text.replace(/>> ?/g, '').trim();
            if (!cleanText) continue;

            const startSeconds = Math.floor((chunk.offset || 0) / 1000);
            const minutes = Math.floor(startSeconds / 60);
            const seconds = startSeconds % 60;
            const timestamp = `${minutes}:${String(seconds).padStart(2, '0')}`;

            transcript.push({
              text: cleanText,
              start: startSeconds,
              duration: Math.floor((chunk.duration || 0) / 1000)
            });
            transcriptTextPlain += cleanText + ' ';
            transcriptTextTimestamped += `[${timestamp}] ${chunk.text}\n`;
          }
        }
      }

      return {
        success: true,
        transcript: transcript,
        transcriptText: transcriptTextPlain.trim(),
        transcriptTextTimestamped: transcriptTextTimestamped.trim(),
        language: data.lang || 'en'
      };
    }

    if (data.status === 'failed') {
      throw new Error('Transcript processing failed');
    }

    // Status is 'queued' or 'active' — keep polling
  }

  throw new Error('Transcript processing timed out');
}


// ============================================================
// CLAUDE API ANALYSIS
// ============================================================

/**
 * Sends the transcript to Claude for analysis using a custom prompt.
 *
 * The prompt asks Claude to act as an executive assistant and determine
 * if the video is worth watching, outputting a concise summary and
 * 3 "worth watching if you're..." statements.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(transcriptText, videoTitle, channelName, videoDescription, videoDuration) {
  try {
    // Require DeepSeek for analysis (cheap and handles long context)
    if (!CONFIG.DEEPSEEK_API_KEY) {
      return {
        success: false,
        error: 'NO_DEEPSEEK_KEY',
        message: 'DeepSeek API key not configured. Please add it to config.js'
      };
    }

    // Convert duration to MM:SS format for context
    const durationMinutes = Math.floor((videoDuration || 0) / 60);
    const durationSeconds = Math.floor((videoDuration || 0) % 60);
    const durationFormatted = `${durationMinutes}:${String(durationSeconds).padStart(2, '0')}`;
    const maxTimestampSeconds = Math.floor(videoDuration || 0);

    // Custom "executive assistant" prompt
    const systemPrompt = `You're my executive assistant. I'm interested in this YouTube video but not sure if it's worth me investing a whole lot of time into. Your task is to read the transcript attached, thoroughly understand this content and what makes it appealing/engaging, define the type of person that would find this content worth their time and the specific jobs to be done this video can fulfill. Ask yourself: for a person to find this content engaging and interesting, what kind of interests would they have? What kind of job would they have? What would they want to understand or learn specifically? Answer in 3 statements.

Important: Each statement should be 1 SHORT line only. Make sure every line is extremely concise and readable. Use simple language accessible to a general audience. Do not regurgitate the content. Do not give away details from the content (that would spoil it for me). Just tell me if this is worth my time. Do not cite any part of the content (including phrases) directly. Keep in mind I have no idea what the content is about; do not assume any prior knowledge in this field or in the content.

You must also provide:
- A list of 3-6 topic tags for this video
- 4-8 chapters with timestamps (find logical topic shifts in the transcript)
- 3-5 key quotes from the transcript with their timestamps

For quotes, focus on:
- Unique or contrarian insights that challenge conventional thinking
- Surprising facts or statistics that make you go "wow, I didn't know that"
- Interesting anecdotes or stories that illustrate a point memorably
- Quotable one-liners that capture the essence of an argument

The quotes should be exactly what the speaker said, but clean up:
- Transcription errors and typos (use the video title & description to correctly spell people's names and proper nouns)
- Missing or incorrect punctuation
- Filler words (um, uh, like, you know, sort of, kind of)
- Speech tics and false starts
- Repeated words from stuttering
Keep the speaker's voice and word choices intact — just polish for readability.

IMPORTANT: Use the video title and description as context to:
- Correctly spell people's names, company names, and proper nouns
- Fix transcription errors for technical terms or jargon
- Understand acronyms and abbreviations used in the video

⚠️ CRITICAL: TIMESTAMP EXTRACTION ⚠️
The transcript is formatted EXACTLY like this:
[0:00] Welcome to today's video
[0:15] Let me tell you about our project
[0:32] We wanted to think outside the box
[1:05] The results were incredible

RULES FOR EXTRACTING TIMESTAMPS:
1. Every line starts with a timestamp in [M:SS] or [MM:SS] format
2. To get the timestamp for a quote, find the LINE containing those words
3. The timestamp is the [X:XX] at the START of that line
4. Convert M:SS to seconds: [2:30] = 150 seconds, [0:45] = 45 seconds

EXAMPLE: If the transcript shows:
[2:30] We wanted to think outside the box and play with animations

Then the timestamp for "We wanted to think outside the box" is:
- timestamp: "2:30"
- timestampSeconds: 150

DO NOT:
- Make up timestamps that don't exist in the transcript
- Use 0:00 as a default — find the actual timestamp
- Use timestamps > ${durationFormatted} (video is only ${maxTimestampSeconds} seconds)

For CHAPTERS: Find where a topic begins, use that line's timestamp
For QUOTES: Find the line containing the quote, use that line's timestamp
Output JSON (no markdown fences):
{
  "summary": "1 sentence about the video",
  "worthWatchingIf": ["statement 1", "statement 2", "statement 3"],
  "tags": ["tag1", "tag2", "tag3"],
  "chapters": [
    {"title": "Title", "timestamp": "0:00", "timestampSeconds": 0, "summary": "What this section covers"}
  ],
  "keyQuotes": [
    {"quote": "Exact quote from transcript", "timestamp": "2:30", "timestampSeconds": 150}
  ],
  "keyMoments": [0, 150, 300]
}

CRITICAL:
- timestamp: The [M:SS] from the transcript line (e.g., "2:30")
- timestampSeconds: Convert to seconds (2:30 = 2*60+30 = 150)
- NEVER use 0:00/0 unless the content actually starts at [0:00]
- EVERY timestamp must exist in the transcript — look it up!`;

    const userPrompt = `Video title: ${videoTitle || 'Unknown'}
Channel: ${channelName || 'Unknown'}
VIDEO DURATION: ${durationFormatted} (${maxTimestampSeconds} seconds) — do not use any timestamp beyond this!

VIDEO DESCRIPTION (use this to correctly spell names and terms):
${videoDescription || 'No description available'}

TRANSCRIPT:
${transcriptText}`;

    // Call the DeepSeek API (OpenAI-compatible format)
    console.log('[YT Digest] Using DeepSeek for video analysis');
    const apiResponse = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 4096,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!apiResponse.ok) {
      const errorData = await apiResponse.json().catch(() => ({}));
      if (apiResponse.status === 401) {
        return {
          success: false,
          error: 'INVALID_DEEPSEEK_KEY',
          message: 'Your DeepSeek API key is invalid. Please check config.js'
        };
      }
      if (apiResponse.status === 429) {
        return {
          success: false,
          error: 'RATE_LIMITED',
          message: 'Too many requests. Please wait a moment and try again.'
        };
      }
      throw new Error(errorData.error?.message || `API error: ${apiResponse.status}`);
    }

    const data = await apiResponse.json();

    // Extract the text content from DeepSeek's response (OpenAI format)
    const responseText = data.choices?.[0]?.message?.content;

    if (!responseText) {
      throw new Error('DeepSeek returned an empty response.');
    }

    // Parse the JSON from Claude's response
    // Sometimes Claude wraps it in markdown code fences, so we strip those
    let cleanJson = responseText.trim();
    if (cleanJson.startsWith('```')) {
      cleanJson = cleanJson.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    let analysis = JSON.parse(cleanJson);

    // POST-PROCESSING: Validate and fix timestamps that exceed video duration
    // This is a safety net in case Claude still hallucinates timestamps
    if (maxTimestampSeconds > 0) {
      analysis = validateAndFixTimestamps(analysis, maxTimestampSeconds);
    }

    return {
      success: true,
      analysis: analysis
    };

  } catch (error) {
    console.error('Analysis error:', error);
    return {
      success: false,
      error: error.message || 'Failed to analyze transcript'
    };
  }
}


/**
 * Validates all timestamps in the analysis and fixes any that exceed video duration.
 * This is a safety net to prevent hallucinated timestamps from reaching the UI.
 *
 * @param {Object} analysis - The parsed analysis from Claude
 * @param {number} maxSeconds - Maximum valid timestamp in seconds
 * @returns {Object} - Analysis with validated timestamps
 */
function validateAndFixTimestamps(analysis, maxSeconds) {
  // Helper to format seconds as MM:SS
  const formatTimestamp = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  };

  // Fix chapters
  if (analysis.chapters && Array.isArray(analysis.chapters)) {
    analysis.chapters = analysis.chapters
      .filter(ch => ch.timestampSeconds <= maxSeconds) // Remove invalid chapters
      .map(ch => {
        if (ch.timestampSeconds > maxSeconds) {
          ch.timestampSeconds = maxSeconds - 10; // Clamp to near end
          ch.timestamp = formatTimestamp(ch.timestampSeconds);
        }
        return ch;
      });
  }

  // Fix key quotes
  if (analysis.keyQuotes && Array.isArray(analysis.keyQuotes)) {
    analysis.keyQuotes = analysis.keyQuotes
      .filter(q => q.timestampSeconds <= maxSeconds) // Remove invalid quotes
      .map(q => {
        if (q.timestampSeconds > maxSeconds) {
          q.timestampSeconds = maxSeconds - 10;
          q.timestamp = formatTimestamp(q.timestampSeconds);
        }
        return q;
      });
  }

  // Fix key moments
  if (analysis.keyMoments && Array.isArray(analysis.keyMoments)) {
    analysis.keyMoments = analysis.keyMoments
      .filter(m => m <= maxSeconds);
  }

  return analysis;
}


// ============================================================
// TRANSCRIPT ENHANCEMENT (using Haiku for cost efficiency)
// ============================================================

/**
 * Enhances the transcript using Claude Haiku (cheap and fast).
 * Cleans up:
 * - Transcription errors (especially names and proper nouns)
 * - Filler words and speech tics
 * - Punctuation and formatting
 *
 * Uses video title and description as context for correct spelling.
 *
 * @param {string} transcriptText - The raw transcript
 * @param {string} videoTitle - Video title for context
 * @param {string} videoDescription - Video description for context
 * @returns {Object} - { success, enhancedTranscript } or { success: false, error }
 */
async function handleEnhanceTranscript(transcriptText, videoTitle, videoDescription) {
  try {
    // Require DeepSeek for transcript enhancement (cheap and handles long context)
    if (!CONFIG.DEEPSEEK_API_KEY) {
      return {
        success: false,
        error: 'NO_DEEPSEEK_KEY',
        message: 'DeepSeek API key not configured. Add DEEPSEEK_API_KEY to config.js'
      };
    }

    // DeepSeek max output is 8192 tokens (~6000 words / ~30k chars)
    // If transcript is longer, we need to chunk it
    const CHUNK_SIZE = 15000; // ~15k chars per chunk to stay safe with output limit
    const needsChunking = transcriptText.length > CHUNK_SIZE;

    console.log(`[YT Digest] Transcript length: ${transcriptText.length} chars, chunking: ${needsChunking}`);

    if (needsChunking) {
      // Split transcript into chunks and process each
      return await enhanceTranscriptInChunks(transcriptText, videoTitle, videoDescription, CHUNK_SIZE);
    }

    // Single chunk - process normally
    return await enhanceSingleChunk(transcriptText, videoTitle, videoDescription);

  } catch (error) {
    console.error('Transcript enhancement error:', error);
    return {
      success: false,
      error: error.message || 'Failed to enhance transcript'
    };
  }
}


/**
 * Enhances a long transcript by splitting it into chunks.
 * Each chunk is processed separately, then combined.
 */
async function enhanceTranscriptInChunks(transcriptText, videoTitle, videoDescription, chunkSize) {
  // Split by paragraphs/sentences to avoid cutting mid-sentence
  const chunks = [];
  let currentChunk = '';

  // Split by lines first
  const lines = transcriptText.split('\n');

  for (const line of lines) {
    if ((currentChunk + line).length > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = line + '\n';
    } else {
      currentChunk += line + '\n';
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  console.log(`[YT Digest] Split transcript into ${chunks.length} chunks`);

  // Process each chunk
  const enhancedChunks = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`[YT Digest] Processing chunk ${i + 1}/${chunks.length}`);

    const result = await enhanceSingleChunk(
      chunks[i],
      videoTitle,
      videoDescription,
      i > 0 ? `(Continuing from previous section...)` : null
    );

    if (!result.success) {
      return result; // Return error if any chunk fails
    }

    enhancedChunks.push(result.enhancedTranscript);
  }

  // Combine all chunks with paragraph breaks
  const combinedTranscript = enhancedChunks.join('\n\n');

  return {
    success: true,
    enhancedTranscript: combinedTranscript
  };
}


/**
 * Enhances a single chunk of transcript using DeepSeek.
 */
async function enhanceSingleChunk(transcriptText, videoTitle, videoDescription, continuationNote = null) {
  const systemPrompt = `You are a transcript editor. Clean up this auto-generated YouTube transcript.

ONLY fix these issues:
1. SPELLING: Fix transcription errors for names, companies, proper nouns. Use video title/description for correct spellings.
2. FILLER WORDS: Remove "um", "uh", "like", "you know", "sort of", "kind of", "I mean", "right", "actually" (when filler).
3. SPEECH TICS: Remove false starts, stuttering, repeated words, self-corrections.
4. PUNCTUATION: Add proper periods, commas, question marks. Capitalize correctly.
5. PARAGRAPHS: Add blank lines between distinct topics or thoughts.

CRITICAL RULES:
- Return the COMPLETE text - every single sentence must be included
- Do NOT summarize, condense, or shorten the text in any way
- Do NOT add any words, ideas, or commentary that weren't spoken
- Do NOT change the speaker's vocabulary or make it more formal
- Do NOT include ANY preamble like "Here's the cleaned transcript:"

Output ONLY the cleaned transcript text. Nothing else.`;

  let userPrompt = `VIDEO TITLE: ${videoTitle || 'Unknown'}

VIDEO DESCRIPTION (for correct spelling):
${videoDescription || 'No description'}

RAW TRANSCRIPT TO CLEAN (return the FULL text, cleaned):
${transcriptText}`;

  if (continuationNote) {
    userPrompt = continuationNote + '\n\n' + userPrompt;
  }

  const apiResponse = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 8192,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  if (!apiResponse.ok) {
    const errorData = await apiResponse.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `API error: ${apiResponse.status}`);
  }

  const data = await apiResponse.json();
  let responseText = data.choices?.[0]?.message?.content;

  if (!responseText) {
    throw new Error('No response from DeepSeek');
  }

  // Clean up any preambles that might slip through
  let enhancedTranscript = responseText.trim();
  enhancedTranscript = enhancedTranscript
    .replace(/^(Here'?s?( the)?( cleaned)?( transcript)?:?\s*\n?)/i, '')
    .replace(/^(The cleaned transcript:?\s*\n?)/i, '')
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  return {
    success: true,
    enhancedTranscript: enhancedTranscript
  };
}


// ============================================================
// REMIX TRANSCRIPT (transform into different formats)
// ============================================================

/**
 * Transforms the transcript into a different written format using Sonnet.
 *
 * @param {string} transcriptText - The transcript
 * @param {string} videoTitle - Video title
 * @param {string} channelName - Channel name
 * @param {string} videoDescription - Video description
 * @param {string} style - The remix style ID (magazine, biography, briefing)
 * @returns {Object} - { success, remixedContent } or { success: false, error }
 */
async function handleRemixTranscript(transcriptText, videoTitle, channelName, videoDescription, style) {
  try {
    if (!CONFIG.ANTHROPIC_API_KEY) {
      return {
        success: false,
        error: 'NO_ANTHROPIC_KEY',
        message: 'Anthropic API key not configured.'
      };
    }

    // Get the prompt for this style
    const styleConfig = REMIX_PROMPTS[style];
    if (!styleConfig) {
      return {
        success: false,
        error: 'INVALID_STYLE',
        message: `Unknown remix style: ${style}`
      };
    }

    const systemPrompt = styleConfig.prompt;

    const userPrompt = `VIDEO TITLE: ${videoTitle || 'Unknown'}
CHANNEL: ${channelName || 'Unknown'}

VIDEO DESCRIPTION:
${videoDescription || 'No description available'}

TRANSCRIPT:
${transcriptText}`;

    const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', // Using Sonnet for quality
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!apiResponse.ok) {
      const errorData = await apiResponse.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `API error: ${apiResponse.status}`);
    }

    const data = await apiResponse.json();
    const remixedContent = data.content[0]?.text;

    if (!remixedContent) {
      throw new Error('No response from Claude');
    }

    return {
      success: true,
      remixedContent: remixedContent.trim(),
      styleName: styleConfig.name
    };

  } catch (error) {
    console.error('Remix error:', error);
    return {
      success: false,
      error: error.message || 'Failed to remix transcript'
    };
  }
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
    const response = await chrome.tabs.sendMessage(tabId, { action: 'getVideoInfo' });
    return response;
  } catch (error) {
    return { title: '', channelName: '', description: '' };
  }
}


// ============================================================
// EXPLAIN SELECTION (using Haiku for speed and cost)
// ============================================================

/**
 * Explains selected text from the transcript using Claude Haiku.
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
 * Fetches transcript if needed, finds the relevant line, cleans it up with Claude.
 */
async function handleSaveNote(videoId, timestamp, videoTitle, channelName, videoUrl) {
  try {
    // First, try to get the transcript from cache
    let transcript = null;
    try {
      const cached = await chrome.storage.session.get(`digest_${videoId}`);
      if (cached[`digest_${videoId}`]?.transcript) {
        transcript = cached[`digest_${videoId}`].transcript;
      }
    } catch (e) {
      console.log('[YT Digest] No cached transcript, fetching...');
    }

    // If no cached transcript, fetch it
    if (!transcript) {
      const transcriptResult = await handleFetchTranscript(videoId, videoUrl);
      if (!transcriptResult.success) {
        return { success: false, error: 'Could not fetch transcript' };
      }
      transcript = transcriptResult.transcript;
    }

    // Find the transcript line at the current timestamp
    // Look for the line that contains this timestamp (or the closest one before)
    let matchedLine = null;
    let matchedIndex = 0;
    let contextLines = [];
    let beforeLine = null;  // 1 sentence before
    let afterLine = null;   // 1 sentence after

    for (let i = 0; i < transcript.length; i++) {
      const line = transcript[i];
      if (line.start <= timestamp && (!transcript[i + 1] || transcript[i + 1].start > timestamp)) {
        matchedLine = line;
        matchedIndex = i;

        // Get buffer sentences (1 before, 1 after)
        if (i > 0) {
          beforeLine = transcript[i - 1].text;
        }
        if (i < transcript.length - 1) {
          afterLine = transcript[i + 1].text;
        }

        // Get broader context (4 lines before and 4 after) for understanding
        const startIdx = Math.max(0, i - 4);
        const endIdx = Math.min(transcript.length - 1, i + 4);
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
      if (matchedIndex > 0) {
        beforeLine = transcript[matchedIndex - 1].text;
      }

      const startIdx = Math.max(0, matchedIndex - 4);
      for (let j = startIdx; j <= matchedIndex; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    // Clean up the text with Claude (includes 1 sentence before and 1 after)
    const cleanedText = await cleanupNoteText(matchedLine.text, beforeLine, afterLine, contextLines.join(' '), videoTitle);

    // Format timestamp as MM:SS
    const minutes = Math.floor(timestamp / 60);
    const seconds = timestamp % 60;
    const formattedTimestamp = `${minutes}:${String(seconds).padStart(2, '0')}`;

    // Create timestamped URL
    const timestampedUrl = `https://youtube.com/watch?v=${videoId}&t=${timestamp}s`;

    // Create the note object
    const note = {
      id: `note_${Date.now()}`,
      videoId: videoId,
      videoTitle: videoTitle || 'Untitled Video',
      channelName: channelName || '',
      timestamp: formattedTimestamp,
      timestampSeconds: timestamp,
      timestampedUrl: timestampedUrl,
      text: cleanedText,
      rawText: matchedLine.text,
      createdAt: Date.now()
    };

    // Save to storage
    await saveNoteToStorage(note);

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: 'noteSaved', note }).catch(() => {});

    return { success: true, note };

  } catch (error) {
    console.error('[YT Digest] Save note error:', error);
    return { success: false, error: error.message };
  }
}


/**
 * Cleans up the transcript lines using DeepSeek.
 * Takes the target line plus buffer sentences (1 before, 1 after).
 * Uses JSON output to prevent any preambles from appearing.
 */
async function cleanupNoteText(targetText, beforeText, afterText, fullContext, videoTitle) {
  if (!CONFIG.DEEPSEEK_API_KEY) {
    // Return combined raw text if no API key
    return [beforeText, targetText, afterText].filter(Boolean).join(' ');
  }

  try {
    console.log('[YT Digest] Using DeepSeek for note cleanup');
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 512,
        messages: [
          {
            role: 'system',
            content: `Clean up a video transcript excerpt (3 sentences: before, target, after).

Your task:
1. Combine the BEFORE, TARGET, and AFTER lines into a coherent passage
2. Fix: spelling errors, filler words (um, uh, like, you know), punctuation
3. Use video title to spell names/terms correctly
4. Keep ALL 3 sentences - do not remove any content
5. Make sure sentences flow naturally together

Output ONLY valid JSON: {"quote": "The cleaned 3-sentence passage here"}
No other text, no explanation, no markdown - just the JSON object.`
          },
          {
            role: 'user',
            content: `Video: ${videoTitle}

FULL CONTEXT (for understanding):
${fullContext}

SENTENCES TO CLEAN:
BEFORE: "${beforeText || '(none)'}"
TARGET: "${targetText}"
AFTER: "${afterText || '(none)'}"

Return JSON with all sentences combined and cleaned:`
          }
        ]
      })
    });

    if (response.ok) {
      const data = await response.json();
      let result = data.choices?.[0]?.message?.content?.trim() || targetText;

      // Parse the JSON response
      try {
        // Remove any markdown code fences if present
        let cleanJson = result;
        if (cleanJson.startsWith('```')) {
          cleanJson = cleanJson.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        }
        const parsed = JSON.parse(cleanJson);
        if (parsed.quote) {
          return parsed.quote;
        }
      } catch (parseError) {
        console.warn('[YT Digest] JSON parse failed for note, stripping preambles:', parseError);
        // Fallback: strip common preambles
        result = result.replace(/^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i, '');
        result = result.replace(/^(The cleaned (quote|text|version)( is)?:?\s*)/i, '');
        result = result.replace(/^(I will.*?:?\s*)/i, '');
        result = result.replace(/^(Cleaned:?\s*)/i, '');
        result = result.replace(/^["']|["']$/g, ''); // Remove wrapping quotes
        return result;
      }

      return result;
    }
  } catch (e) {
    console.error('[YT Digest] Cleanup error:', e);
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(' ');
}


/**
 * Saves a note to chrome.storage.local
 */
async function saveNoteToStorage(note) {
  const result = await chrome.storage.local.get('ytd_notes');
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
async function handleGetNotes(videoId) {
  try {
    const result = await chrome.storage.local.get('ytd_notes');
    let notes = result.ytd_notes || [];

    if (videoId) {
      notes = notes.filter(n => n.videoId === videoId);
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
    const result = await chrome.storage.local.get('ytd_notes');
    let notes = result.ytd_notes || [];
    notes = notes.filter(n => n.id !== noteId);
    await chrome.storage.local.set({ ytd_notes: notes });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}


async function handleExplainSelection(selectedText, transcriptContext, videoTitle) {
  try {
    if (!CONFIG.DEEPSEEK_API_KEY) {
      return {
        success: false,
        error: 'NO_DEEPSEEK_KEY',
        message: 'DeepSeek API key not configured.'
      };
    }

    const systemPrompt = `You explain selected text from video transcripts. Be extremely concise.

Rules:
- 1-3 sentences MAX
- If it's a word/term: give a brief definition
- If it's a phrase/claim: explain what it means in context
- No fluff, no "This refers to...", just the explanation
- Use simple language`;

    const userPrompt = `VIDEO: ${videoTitle || 'Unknown'}

SELECTED: "${selectedText}"

CONTEXT: ${transcriptContext || 'None'}

Explain briefly.`;

    console.log('[YT Digest] Using DeepSeek for explain selection');
    const apiResponse = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!apiResponse.ok) {
      const errorData = await apiResponse.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `API error: ${apiResponse.status}`);
    }

    const data = await apiResponse.json();
    const explanation = data.choices?.[0]?.message?.content;

    if (!explanation) {
      throw new Error('No response from DeepSeek');
    }

    return {
      success: true,
      explanation: explanation.trim()
    };

  } catch (error) {
    console.error('Explain selection error:', error);
    return {
      success: false,
      error: error.message || 'Failed to explain selection'
    };
  }
}


// ============================================================
// TRANSLATION — Translate content into Chinese or Japanese
// ============================================================
// Uses DeepSeek with temperature 0.3 for consistent, natural translations.
// Different content types get different prompts so the translation
// matches the format and tone of each section (transcript vs summary etc.)

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - 'zh' or 'ja'
 * @returns {string} - The base translation rules
 */
function getTranslationBaseRules(targetLanguage) {
  const langSpecific = targetLanguage === 'zh'
    ? `- Use modern colloquial Simplified Chinese (简体中文). Avoid stiff 书面语 unless the original is formal.
- Use natural Chinese sentence structures — do NOT mirror English syntax.`
    : `- Use natural Japanese with appropriate politeness level matching the source.
- Use kanji where standard, but don't over-kanji casual speech.`;

  return `TRANSLATION RULES (follow strictly):
- Match the EXACT tone and register of the original (casual stays casual, formal stays formal)
- Use natural ${targetLanguage === 'zh' ? 'Chinese' : 'Japanese'} sentence structures — NOT English syntax translated word-by-word
- Do NOT translate: proper nouns, brand names, technical terms commonly kept in English (API, AI, etc.), timestamps
- Preserve ALL formatting: paragraph breaks, bullet points, markdown, timestamps
${langSpecific}`;
}


/**
 * Translates content using DeepSeek API.
 * Routes to different prompts based on the content type.
 *
 * @param {string|Object} content - The content to translate (string or JSON object)
 * @param {string} contentType - One of: 'transcript', 'overview', 'quotes', 'remix', 'explanation'
 * @param {string} targetLanguage - 'zh' for Chinese, 'ja' for Japanese
 * @param {string} videoTitle - The video title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(content, contentType, targetLanguage, videoTitle) {
  try {
    if (!CONFIG.DEEPSEEK_API_KEY) {
      return { success: false, error: 'DeepSeek API key not configured' };
    }

    // Skip if content is empty
    if (!content || (typeof content === 'string' && !content.trim())) {
      return { success: true, translatedContent: content };
    }

    const baseRules = getTranslationBaseRules(targetLanguage);
    const langName = targetLanguage === 'zh' ? 'Simplified Chinese' : 'Japanese';

    // Build the system prompt based on content type
    let systemPrompt = '';
    let userContent = '';

    switch (contentType) {
      case 'transcript':
        // Transcripts can be long — we handle chunking in the caller (sidepanel.js)
        // Each chunk arrives here as a string of paragraphs
        systemPrompt = `You are a professional translator. Translate the following video transcript into ${langName}.
The video is titled "${videoTitle || 'Unknown'}" — use this ONLY as context for proper nouns and terminology. Do NOT include the title in your output.

${baseRules}

- This is a spoken transcript. Keep the conversational tone.
- Preserve paragraph breaks exactly as they appear.
- CRITICAL: If you see ---PARAGRAPH_BREAK--- in the text, keep it EXACTLY as-is (do NOT translate or remove it). It is a structural delimiter.
- Output ONLY the translated transcript text. No preamble, no title, no labels, no explanation.`;
        userContent = content;
        break;

      case 'overview':
        // Overview arrives as a JSON object with summary, worthWatchingIf, tags, chapters
        systemPrompt = `You are a professional translator. Translate the following video analysis JSON into ${langName}.

${baseRules}

- Translate the values ONLY — keep all JSON keys in English exactly as they are
- "summary": translate the summary text
- "worthWatchingIf": translate each statement in the array
- "tags": translate tags into ${langName} equivalents (keep technical terms in English)
- "chapters": translate "title" and "summary" — keep "timestamp" and "timestampSeconds" unchanged
- Output ONLY valid JSON. No markdown fences, no explanation.`;
        userContent = `Video: ${videoTitle || 'Unknown'}\n\nJSON TO TRANSLATE:\n${typeof content === 'string' ? content : JSON.stringify(content)}`;
        break;

      case 'quotes':
        // Quotes arrives as a JSON array of {quote, timestamp, timestampSeconds}
        systemPrompt = `You are a professional translator. Translate these video quotes into ${langName}.

${baseRules}

- Translate the "quote" field ONLY — keep "timestamp" and "timestampSeconds" unchanged
- Preserve the speaker's voice and style in the translation
- Output ONLY a valid JSON array. No markdown fences, no explanation.`;
        userContent = `Video: ${videoTitle || 'Unknown'}\n\nQUOTES JSON:\n${typeof content === 'string' ? content : JSON.stringify(content)}`;
        break;

      case 'remix':
        // Remix is a markdown string
        systemPrompt = `You are a professional translator. Translate this remixed article into ${langName}.

${baseRules}

- Preserve ALL markdown formatting: headers (##), bold (**), italic (*), blockquotes (>), horizontal rules (---)
- This is a polished written piece — maintain its literary quality in translation
- Output ONLY the translated text with markdown intact. No preamble.`;
        userContent = `Video: ${videoTitle || 'Unknown'}\n\nARTICLE:\n${content}`;
        break;

      case 'explanation':
        // Short explanation text
        systemPrompt = `You are a professional translator. Translate this brief explanation into ${langName}.

${baseRules}

- Keep it concise — this is a short explanation of a concept.
- Output ONLY the translated text. No preamble.`;
        userContent = content;
        break;

      default:
        // Generic fallback
        systemPrompt = `Translate the following text into ${langName}.\n\n${baseRules}\n\nOutput ONLY the translation.`;
        userContent = content;
    }

    // For long transcripts, chunk them (reuse the same chunking logic as enhance)
    if (contentType === 'transcript' && typeof content === 'string' && content.length > 12000) {
      return await translateTranscriptInChunks(content, targetLanguage, videoTitle, systemPrompt);
    }

    // Single API call for everything else
    const result = await callDeepSeekTranslation(systemPrompt, userContent);

    if (!result.success) {
      return result;
    }

    // For JSON content types, validate the response is valid JSON
    if (contentType === 'overview' || contentType === 'quotes') {
      let cleaned = result.text.trim();
      // Strip markdown fences if DeepSeek wrapped them
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      try {
        const parsed = JSON.parse(cleaned);
        return { success: true, translatedContent: parsed };
      } catch (parseError) {
        console.error('[YT Digest] Translation JSON parse error:', parseError);
        // Return raw text as fallback — sidepanel.js will handle gracefully
        return { success: false, error: 'Translation returned invalid JSON' };
      }
    }

    return { success: true, translatedContent: result.text.trim() };

  } catch (error) {
    console.error('[YT Digest] Translation error:', error);
    return { success: false, error: error.message || 'Translation failed' };
  }
}


/**
 * Translates a long transcript by splitting it into chunks.
 * Same approach as enhanceTranscriptInChunks() — split by paragraphs,
 * translate each chunk separately, then combine.
 *
 * @param {string} transcriptText - The full transcript
 * @param {string} targetLanguage - 'zh' or 'ja'
 * @param {string} videoTitle - Video title for context
 * @param {string} systemPrompt - The system prompt to use
 * @returns {Object} - { success, translatedContent }
 */
async function translateTranscriptInChunks(transcriptText, targetLanguage, videoTitle, systemPrompt) {
  const CHUNK_SIZE = 12000; // ~12k chars per chunk
  const chunks = [];
  let currentChunk = '';

  // Split by paragraph breaks to avoid cutting mid-sentence
  const paragraphs = transcriptText.split(/\n\n+/);

  for (const para of paragraphs) {
    if ((currentChunk + para).length > CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = para + '\n\n';
    } else {
      currentChunk += para + '\n\n';
    }
  }
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  console.log(`[YT Digest] Translating transcript in ${chunks.length} chunks`);

  const translatedChunks = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`[YT Digest] Translating chunk ${i + 1}/${chunks.length}`);
    const userContent = `Video: ${videoTitle || 'Unknown'}\n\nTRANSCRIPT (part ${i + 1} of ${chunks.length}):\n${chunks[i]}`;
    const result = await callDeepSeekTranslation(systemPrompt, userContent);

    if (!result.success) {
      return { success: false, error: `Chunk ${i + 1} failed: ${result.error}` };
    }

    translatedChunks.push(result.text.trim());
  }

  return {
    success: true,
    translatedContent: translatedChunks.join('\n\n')
  };
}


/**
 * Makes a single DeepSeek API call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callDeepSeekTranslation(systemPrompt, userContent) {
  try {
    const apiResponse = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.3, // Low temperature = consistent, faithful translations
        max_tokens: 8192,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ]
      })
    });

    if (!apiResponse.ok) {
      const errorData = await apiResponse.json().catch(() => ({}));
      if (apiResponse.status === 429) {
        return { success: false, error: 'Rate limited — try again in a moment' };
      }
      return { success: false, error: errorData.error?.message || `API error: ${apiResponse.status}` };
    }

    const data = await apiResponse.json();
    const text = data.choices?.[0]?.message?.content;

    if (!text) {
      return { success: false, error: 'Empty response from DeepSeek' };
    }

    return { success: true, text };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

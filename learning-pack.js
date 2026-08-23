(function initializeLearningPack(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.YTD_LEARNING_PACK = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  const TOP_LEVEL_KEYS = new Set([
    "schemaVersion",
    "kind",
    "state",
    "articleIntent",
    "createdAt",
    "source",
    "digest",
    "notes",
    "reflection",
    "provenance",
  ]);
  const TRANSCRIPT_FIELD = /^(?:full)?transcript(?:text|timestamped|entries|segments)?$/i;

  function cleanString(value, maxLength) {
    return typeof value === "string"
      ? value.replace(/\u0000/g, "").trim().slice(0, maxLength)
      : "";
  }

  function cleanSeconds(value, max = 172_800) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > max) return 0;
    return Math.floor(seconds);
  }

  function formatTimestamp(seconds) {
    const safeSeconds = cleanSeconds(seconds);
    return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`;
  }

  function normalizeIso(value, fallback = new Date().toISOString()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }

  function assertNoTranscriptFields(value, path = "pack") {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (TRANSCRIPT_FIELD.test(key)) {
        throw new Error(`Full transcript fields are not allowed in Learning Pack (${path}.${key})`);
      }
      assertNoTranscriptFields(child, `${path}.${key}`);
    }
  }

  function assertExactTopLevelKeys(pack) {
    for (const key of Object.keys(pack || {})) {
      if (!TOP_LEVEL_KEYS.has(key)) {
        throw new Error(`Unsupported Learning Pack field: ${key}`);
      }
    }
  }

  function canonicalYouTubeSource(source) {
    const videoId = cleanString(source?.videoId, 32);
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
      throw new Error("Learning Pack requires a valid YouTube video ID");
    }
    return {
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: cleanString(source?.title, 500) || "Untitled YouTube video",
      channelName: cleanString(source?.channelName, 300),
      language: cleanString(source?.language, 40),
      durationSeconds: cleanSeconds(source?.durationSeconds),
    };
  }

  function normalizeChapter(chapter) {
    const title = cleanString(chapter?.title, 300);
    if (!title) return null;
    const timestampSeconds = cleanSeconds(chapter?.timestampSeconds);
    return {
      title,
      summary: cleanString(chapter?.summary, 1500),
      timestampSeconds,
      timestamp: formatTimestamp(timestampSeconds),
    };
  }

  function normalizeQuote(quote) {
    const text = cleanString(quote?.quote, 3000);
    if (!text) return null;
    const timestampSeconds = cleanSeconds(quote?.timestampSeconds);
    return {
      quote: text,
      timestampSeconds,
      timestamp: formatTimestamp(timestampSeconds),
    };
  }

  function normalizeDigest(digest) {
    const generated = digest?.status === "generated";
    return {
      status: generated ? "generated" : "not_generated",
      summary: cleanString(digest?.summary, 20_000),
      worthWatchingIf: (Array.isArray(digest?.worthWatchingIf)
        ? digest.worthWatchingIf
        : []
      )
        .slice(0, 20)
        .map((item) => cleanString(item, 1000))
        .filter(Boolean),
      tags: (Array.isArray(digest?.tags) ? digest.tags : [])
        .slice(0, 30)
        .map((item) => cleanString(item, 100))
        .filter(Boolean),
      chapters: (Array.isArray(digest?.chapters) ? digest.chapters : [])
        .slice(0, 100)
        .map(normalizeChapter)
        .filter(Boolean)
        .sort((a, b) => a.timestampSeconds - b.timestampSeconds),
      keyQuotes: (Array.isArray(digest?.keyQuotes) ? digest.keyQuotes : [])
        .slice(0, 50)
        .map(normalizeQuote)
        .filter(Boolean)
        .sort((a, b) => a.timestampSeconds - b.timestampSeconds),
      keyMoments: (Array.isArray(digest?.keyMoments)
        ? digest.keyMoments
        : []
      )
        .slice(0, 100)
        .map((seconds) => cleanSeconds(seconds)),
    };
  }

  function normalizeNote(note, source) {
    const text = cleanString(note?.text, 10_000);
    if (!text) return null;
    const timestampSeconds = cleanSeconds(note?.timestampSeconds);
    return {
      id: cleanString(note?.id, 120),
      text,
      rawText: cleanString(note?.rawText, 10_000),
      timestampSeconds,
      timestamp: formatTimestamp(timestampSeconds),
      timestampedUrl: `${source.url}&t=${timestampSeconds}s`,
      createdAt: normalizeIso(note?.createdAt),
    };
  }

  function normalizeReflection(reflection) {
    return {
      myTake: cleanString(reflection?.myTake, 10_000),
      agreeDisagree: cleanString(reflection?.agreeDisagree, 10_000),
      connections: cleanString(reflection?.connections, 10_000),
      coreClaim: cleanString(reflection?.coreClaim, 2000),
    };
  }

  function validateLearningPack(pack) {
    if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
      throw new Error("Learning Pack must be an object");
    }
    assertNoTranscriptFields(pack);
    assertExactTopLevelKeys(pack);
    if (pack.schemaVersion !== 1) {
      throw new Error("Learning Pack schemaVersion must be 1");
    }
    if (pack.kind !== "youtube-learning-pack") {
      throw new Error("Learning Pack kind is invalid");
    }
    if (pack.state !== "learning_complete") {
      throw new Error("Learning Pack state must be learning_complete");
    }
    if (pack.articleIntent !== false) {
      throw new Error("Learning Pack cannot start an article");
    }

    const source = canonicalYouTubeSource(pack.source);
    const notes = (Array.isArray(pack.notes) ? pack.notes : [])
      .slice(0, 200)
      .map((note) => normalizeNote(note, source))
      .filter(Boolean);
    const digest = normalizeDigest(pack.digest);
    const extensionVersion = cleanString(pack.provenance?.extensionVersion, 40);
    return {
      schemaVersion: 1,
      kind: "youtube-learning-pack",
      state: "learning_complete",
      articleIntent: false,
      createdAt: normalizeIso(pack.createdAt),
      source,
      digest,
      notes,
      reflection: normalizeReflection(pack.reflection),
      provenance: {
        producer: "youtube-digest-codex-local",
        extensionVersion,
        transcriptIncluded: false,
        transcriptLanguage: cleanString(
          pack.provenance?.transcriptLanguage || source.language,
          40,
        ),
        transcriptSegmentCount: Math.min(
          50_000,
          cleanSeconds(pack.provenance?.transcriptSegmentCount, 50_000),
        ),
        digestGenerated: digest.status === "generated",
        notesCount: notes.length,
      },
    };
  }

  function buildLearningPack(input) {
    const analysis = input?.analysis || null;
    return validateLearningPack({
      schemaVersion: 1,
      kind: "youtube-learning-pack",
      state: "learning_complete",
      articleIntent: false,
      createdAt: input?.createdAt || new Date().toISOString(),
      source: input?.source,
      digest: {
        status: analysis ? "generated" : "not_generated",
        summary: analysis?.summary,
        worthWatchingIf: analysis?.worthWatchingIf,
        tags: analysis?.tags,
        chapters: analysis?.chapters,
        keyQuotes: analysis?.keyQuotes,
        keyMoments: analysis?.keyMoments,
      },
      notes: input?.notes,
      reflection: input?.reflection,
      provenance: {
        extensionVersion: input?.extensionVersion,
        transcriptLanguage: input?.transcriptLanguage,
        transcriptSegmentCount: Array.isArray(input?.transcript)
          ? input.transcript.length
          : Number(input?.transcriptSegmentCount) || 0,
      },
    });
  }

  function draftStorageKey(videoId) {
    const safeVideoId = cleanString(videoId, 32);
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(safeVideoId)) {
      throw new Error("A valid video ID is required for a Learning Pack draft");
    }
    return `learning_pack_draft_${safeVideoId}`;
  }

  return {
    buildLearningPack,
    draftStorageKey,
    formatTimestamp,
    validateLearningPack,
  };
});

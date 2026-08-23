(function initializeQuestionAnswer(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.YTD_QUESTION_ANSWER = api;
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function createQuestionAnswerApi() {
    "use strict";

    const SOURCE_TYPES = new Set(["transcript", "overview", "note"]);

    function cleanString(value, maxLength) {
      return typeof value === "string"
        ? value.replace(/\u0000/g, "").trim().slice(0, maxLength)
        : "";
    }

    function cleanSeconds(value) {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 172_800) {
        return 0;
      }
      return Math.floor(seconds);
    }

    function formatTimestamp(seconds) {
      const safeSeconds = cleanSeconds(seconds);
      return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`;
    }

    function normalizeQuestionRequest(payload) {
      const sourceType = cleanString(payload?.sourceType, 20);
      const sourceText = cleanString(payload?.sourceText, 12_000);
      const question = cleanString(payload?.question, 2_000);
      const videoId = cleanString(payload?.videoId, 32);

      if (!SOURCE_TYPES.has(sourceType)) {
        throw new Error("Question source must be transcript, overview, or note");
      }
      if (!sourceText) throw new Error("Question source text is required");
      if (!question) throw new Error("Question is required");
      if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
        throw new Error("Question requires a valid YouTube video ID");
      }

      return {
        sourceType,
        sourceLabel:
          cleanString(payload?.sourceLabel, 80) ||
          sourceType[0].toUpperCase() + sourceType.slice(1),
        sourceText,
        surroundingContext: cleanString(payload?.surroundingContext, 16_000),
        question,
        videoId,
        videoTitle:
          cleanString(payload?.videoTitle, 500) || "Untitled YouTube video",
        channelName: cleanString(payload?.channelName, 300),
        timestampSeconds: cleanSeconds(payload?.timestampSeconds),
      };
    }

    function buildQuestionAnswerNote({
      request,
      answer,
      canonicalVideoUrl,
      now = Date.now(),
    }) {
      const normalized = normalizeQuestionRequest(request);
      const safeAnswer = cleanString(answer, 8_000);
      if (!safeAnswer) throw new Error("Codex answer is required");
      const safeCanonicalUrl = cleanString(canonicalVideoUrl, 500);
      if (
        safeCanonicalUrl !==
        `https://www.youtube.com/watch?v=${normalized.videoId}`
      ) {
        throw new Error("Question answer note requires a canonical YouTube URL");
      }

      const createdAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
      const timestamp = formatTimestamp(normalized.timestampSeconds);
      return {
        id: `qa_${Math.floor(createdAt)}`,
        noteType: "question_answer",
        sourceType: normalized.sourceType,
        sourceLabel: normalized.sourceLabel,
        videoId: normalized.videoId,
        videoTitle: normalized.videoTitle,
        channelName: normalized.channelName,
        timestamp,
        timestampSeconds: normalized.timestampSeconds,
        timestampedUrl: `${safeCanonicalUrl}&t=${normalized.timestampSeconds}s`,
        question: normalized.question,
        answer: safeAnswer,
        text: `Question\n${normalized.question}\n\nAnswer\n${safeAnswer}`,
        rawText: normalized.sourceText.slice(0, 3_000),
        createdAt,
      };
    }

    return {
      SOURCE_TYPES,
      buildQuestionAnswerNote,
      cleanString,
      formatTimestamp,
      normalizeQuestionRequest,
    };
  },
);

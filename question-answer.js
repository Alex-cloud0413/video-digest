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
      const platform = cleanString(payload?.platform, 20) || "youtube";
      const pageNumber = Math.min(
        10_000,
        Math.max(1, Math.floor(Number(payload?.pageNumber) || 1)),
      );

      if (!SOURCE_TYPES.has(sourceType)) {
        throw new Error("Question source must be transcript, overview, or note");
      }
      if (!sourceText) throw new Error("Question source text is required");
      if (!question) throw new Error("Question is required");
      const validVideoId =
        platform === "youtube"
          ? /^[A-Za-z0-9_-]{6,20}$/.test(videoId)
          : platform === "bilibili"
            ? /^BV[A-Za-z0-9]{10,18}$/.test(videoId)
            : false;
      if (!validVideoId) {
        throw new Error("Question requires a valid supported video ID");
      }

      return {
        sourceType,
        sourceLabel:
          cleanString(payload?.sourceLabel, 80) ||
          sourceType[0].toUpperCase() + sourceType.slice(1),
        sourceText,
        surroundingContext: cleanString(payload?.surroundingContext, 16_000),
        question,
        platform,
        videoId,
        pageNumber,
        videoTitle:
          cleanString(payload?.videoTitle, 500) || "Untitled video",
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
      let parsedCanonicalUrl;
      try {
        parsedCanonicalUrl = new URL(safeCanonicalUrl);
      } catch {
        throw new Error("Question answer note requires a canonical video URL");
      }
      const isCanonical =
        normalized.platform === "youtube"
          ? parsedCanonicalUrl.hostname === "www.youtube.com" &&
            parsedCanonicalUrl.pathname === "/watch" &&
            parsedCanonicalUrl.searchParams.get("v") === normalized.videoId
          : parsedCanonicalUrl.hostname === "www.bilibili.com" &&
            parsedCanonicalUrl.pathname === `/video/${normalized.videoId}/` &&
            (normalized.pageNumber === 1 ||
              parsedCanonicalUrl.searchParams.get("p") === String(normalized.pageNumber));
      if (!isCanonical) {
        throw new Error("Question answer note requires a canonical video URL");
      }

      const createdAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
      const timestamp = formatTimestamp(normalized.timestampSeconds);
      return {
        id: `qa_${Math.floor(createdAt)}`,
        noteType: "question_answer",
        sourceType: normalized.sourceType,
        sourceLabel: normalized.sourceLabel,
        platform: normalized.platform,
        videoId: normalized.videoId,
        pageNumber: normalized.pageNumber,
        videoTitle: normalized.videoTitle,
        channelName: normalized.channelName,
        timestamp,
        timestampSeconds: normalized.timestampSeconds,
        timestampedUrl: (() => {
          parsedCanonicalUrl.searchParams.set(
            "t",
            normalized.platform === "youtube"
              ? `${normalized.timestampSeconds}s`
              : String(normalized.timestampSeconds),
          );
          return parsedCanonicalUrl.toString();
        })(),
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

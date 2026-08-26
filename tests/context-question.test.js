const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildQuestionAnswerNote,
  normalizeQuestionRequest,
} = require("../question-answer.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const request = {
  sourceType: "transcript",
  sourceLabel: "Transcript selection",
  sourceText: "A neural network is a function with many adjustable weights.",
  surroundingContext: "The speaker is introducing layers and activations.",
  question: "Why do the weights matter?",
  platform: "youtube",
  videoId: "aircAruvnKk",
  pageNumber: 1,
  videoTitle: "But what is a neural network?",
  channelName: "3Blue1Brown",
  timestampSeconds: 172,
};

test("focused question requests are bounded and source-aware", () => {
  assert.deepEqual(normalizeQuestionRequest(request), request);
  assert.throws(
    () => normalizeQuestionRequest({ ...request, sourceType: "web" }),
    /Question source/,
  );
  assert.throws(
    () => normalizeQuestionRequest({ ...request, question: "" }),
    /Question is required/,
  );
  assert.throws(
    () => normalizeQuestionRequest({ ...request, videoId: "../escape" }),
    /valid supported video ID/,
  );
});

test("focused questions accept Bilibili video sources", () => {
  const bilibili = normalizeQuestionRequest({
    ...request,
    platform: "bilibili",
    videoId: "BV1zu4y1y7Sh",
    pageNumber: 2,
  });
  assert.equal(bilibili.platform, "bilibili");
  assert.equal(bilibili.pageNumber, 2);
  const note = buildQuestionAnswerNote({
    request: bilibili,
    answer: "This is a focused answer.",
    canonicalVideoUrl: "https://www.bilibili.com/video/BV1zu4y1y7Sh/?p=2",
    now: 123457,
  });
  assert.equal(
    note.timestampedUrl,
    "https://www.bilibili.com/video/BV1zu4y1y7Sh/?p=2&t=172",
  );
});

test("Codex answers become timestamped question-answer notes", () => {
  const note = buildQuestionAnswerNote({
    request,
    answer: "Weights determine how strongly each input influences the next layer.",
    canonicalVideoUrl: "https://www.youtube.com/watch?v=aircAruvnKk",
    now: 123456,
  });

  assert.equal(note.id, "qa_123456");
  assert.equal(note.noteType, "question_answer");
  assert.equal(note.timestamp, "2:52");
  assert.equal(
    note.timestampedUrl,
    "https://www.youtube.com/watch?v=aircAruvnKk&t=172s",
  );
  assert.match(note.text, /Question[\s\S]*Why do the weights matter\?[\s\S]*Answer/);
  assert.equal(note.rawText, request.sourceText);
});

test("all three side-panel sources expose Ask and save-to-Notes actions", () => {
  const panel = read("sidepanel.js");
  const background = read("background.js");
  const prompt = read("prompts/context-question.md");

  assert.match(panel, /sourceLabel: "Transcript"/);
  assert.match(panel, /sourceLabel: "Overview chapter"/);
  assert.match(panel, /sourceLabel: "Overview quote"/);
  assert.match(panel, /sourceLabel: "Saved note"/);
  assert.match(panel, /action: "askContextQuestion"/);
  assert.match(panel, /action: "saveQuestionAnswerNote"/);
  assert.match(background, /handleContextQuestion/);
  assert.match(background, /handleSaveQuestionAnswerNote/);
  assert.match(prompt, /same language as the question/);
  assert.match(prompt, /insufficient/);
});

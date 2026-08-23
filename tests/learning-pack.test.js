const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildLearningPack,
  draftStorageKey,
  validateLearningPack,
} = require("../learning-pack.js");

function sampleInput() {
  return {
    createdAt: "2026-08-23T08:00:00.000Z",
    source: {
      videoId: "aircAruvnKk",
      url: "https://www.youtube.com/watch?v=aircAruvnKk&feature=test",
      title: "But what is a neural network?",
      channelName: "3Blue1Brown",
      language: "en",
      durationSeconds: 1140,
    },
    analysis: {
      chapters: [
        {
          title: "Pixels and neurons",
          summary: "A visual introduction.",
          timestampSeconds: 49,
        },
      ],
      keyQuotes: [{ quote: "A neuron holds a number.", timestampSeconds: 172 }],
      keyMoments: [49, 172],
    },
    notes: [
      {
        id: "note_1",
        text: "Neurons can be treated as values between zero and one.",
        rawText: "neuron holds a number",
        timestampSeconds: 172,
        createdAt: 1787472000000,
      },
    ],
    reflection: {
      myTake: "The visual model makes abstraction inspectable.",
      agreeDisagree: "I agree with the teaching sequence.",
      connections: "This connects to zero-basics explainers.",
      coreClaim: "Visual explanations reduce abstraction debt.",
    },
    extensionVersion: "1.3.0",
    transcriptLanguage: "en",
    transcriptSegmentCount: 200,
  };
}

test("builder emits the bounded learning_complete schema without a transcript", () => {
  const pack = buildLearningPack(sampleInput());
  assert.equal(pack.schemaVersion, 1);
  assert.equal(pack.kind, "youtube-learning-pack");
  assert.equal(pack.state, "learning_complete");
  assert.equal(pack.articleIntent, false);
  assert.equal(pack.source.url, "https://www.youtube.com/watch?v=aircAruvnKk");
  assert.equal(pack.provenance.transcriptIncluded, false);
  assert.equal(pack.provenance.transcriptSegmentCount, 200);
  assert.equal(pack.provenance.notesCount, 1);
  assert.doesNotMatch(JSON.stringify(pack), /"transcript"\s*:/i);
});

test("validator rejects article intent, transcript data, and destination fields", () => {
  const pack = buildLearningPack(sampleInput());
  assert.throws(
    () => validateLearningPack({ ...pack, articleIntent: true }),
    /cannot start an article/,
  );
  assert.throws(
    () => validateLearningPack({ ...pack, transcriptText: "full captions" }),
    /transcript fields are not allowed/i,
  );
  assert.throws(
    () => validateLearningPack({ ...pack, targetDirectory: "/tmp/escape" }),
    /Unsupported Learning Pack field/,
  );
});

test("draft keys are scoped to a validated YouTube video ID", () => {
  assert.equal(draftStorageKey("aircAruvnKk"), "learning_pack_draft_aircAruvnKk");
  assert.throws(() => draftStorageKey("../escape"), /valid video ID/);
});

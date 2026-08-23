const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildLearningPack } = require("../learning-pack.js");
const {
  loadCreatorHandoffRoot,
  renderLearningPackMarkdown,
  validateWorkspaceRoot,
  writeLearningPack,
} = require("./learning-pack-writer.js");

function samplePack() {
  return buildLearningPack({
    createdAt: "2026-08-23T08:00:00.000Z",
    source: {
      videoId: "aircAruvnKk",
      title: "Neural networks",
      channelName: "3Blue1Brown",
      language: "en",
      durationSeconds: 1140,
    },
    analysis: {
      chapters: [{ title: "Opening", summary: "The task", timestampSeconds: 49 }],
      keyQuotes: [{ quote: "A neuron holds a number.", timestampSeconds: 172 }],
    },
    notes: [{ id: "n1", text: "My saved note", timestampSeconds: 172 }],
    reflection: { myTake: "A useful mental model." },
    extensionVersion: "1.3.0",
    transcriptSegmentCount: 200,
  });
}

test("writer creates both files only below its injected inbox root", (t) => {
  const inboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ytd-creator-"));
  t.after(() => fs.rmSync(inboxRoot, { recursive: true, force: true }));
  const receipt = writeLearningPack(samplePack(), { inboxRoot });
  const realRoot = fs.realpathSync(inboxRoot);
  assert.equal(path.relative(realRoot, receipt.directory).startsWith(".."), false);
  assert.ok(fs.statSync(receipt.jsonPath).isFile());
  assert.ok(fs.statSync(receipt.markdownPath).isFile());
  assert.equal(receipt.state, "learning_complete");
  assert.equal(receipt.articleIntent, false);

  const saved = JSON.parse(fs.readFileSync(receipt.jsonPath, "utf8"));
  assert.equal(saved.source.videoId, "aircAruvnKk");
  assert.equal(saved.provenance.transcriptIncluded, false);
});

test("workspace config resolves one fixed YouTube Digest inbox", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ytd-workspace-config-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const workspaceRoot = path.join(tempRoot, "creator-workspace");
  const configPath = path.join(tempRoot, "workspace-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ workspaceRoot }));
  assert.equal(
    loadCreatorHandoffRoot({ configPath, environmentRoot: "" }),
    path.join(workspaceRoot, "inbox", "youtube-digest"),
  );
  assert.throws(() => validateWorkspaceRoot(path.parse(tempRoot).root), /bounded/);
});

test("Markdown renderer keeps source material visibly separate", () => {
  const markdown = renderLearningPackMarkdown(samplePack());
  assert.match(markdown, /learning-complete intake pack/i);
  assert.match(markdown, /## My reflection/);
  assert.match(markdown, /> A neuron holds a number\./);
  assert.match(markdown, /## Notes/);
  assert.match(markdown, /Full transcript included: `false`/);
});

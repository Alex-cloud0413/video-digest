const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("manifest grants only supported video and loopback bridge hosts", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const packageJson = JSON.parse(read("package.json"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.equal(manifest.name, "Video Digest");
  assert.equal(manifest.version, "1.8.0");
  assert.equal(manifest.action.default_title, "Open Video Digest");
  assert.equal(packageJson.version, manifest.version);
  assert.deepEqual(manifest.host_permissions.sort(), [
    "http://127.0.0.1:43110/*",
    "https://*.googlevideo.com/*",
    "https://*.hdslb.com/*",
    "https://api.bilibili.com/*",
    "https://www.bilibili.com/*",
    "https://www.youtube.com/*",
  ]);
  assert.ok(!manifest.permissions.includes("activeTab"));
  assert.ok(
    manifest.content_scripts.some((entry) =>
      entry.matches.includes("https://www.bilibili.com/video/*"),
    ),
  );
});

test("runtime uses a generated local capability but no provider API key", () => {
  const runtime = [
    "background.js",
    "settings.js",
    "sidepanel.js",
    "options.js",
  ]
    .map(read)
    .join("\n");

  assert.match(runtime, /127\.0\.0\.1:43110/);
  assert.match(runtime, /YTD_LOCAL_BRIDGE/);
  assert.doesNotMatch(runtime, /Authorization:\s*`Bearer/i);
  assert.doesNotMatch(runtime, /api\.deepseek\.com/i);
  assert.doesNotMatch(runtime, /api\.supadata\.ai/i);
});

test("published documentation describes the generic local setup", () => {
  const docs = [
    read("README.md"),
    read("README.zh-CN.md"),
    read("PRIVACY.md"),
    read("SECURITY.md"),
  ].join("\n");

  assert.match(docs, /Codex/i);
  assert.match(docs, /TraeWork/i);
  assert.match(docs, /Video Digest/);
  assert.match(docs, /YouTube or Bilibili|YouTube 或哔哩哔哩/i);
  assert.match(docs, /no .*API key|不需要.*API Key|无需 API Key/i);
  assert.match(docs, /Creator Workspace/);
  assert.match(docs, /zarazhangrui\/youtube-digest/);
  assert.doesNotMatch(docs, /\/Users\/[^/\s]+\/Documents\//i);
  assert.doesNotMatch(docs, /platform\.deepseek\.com\/api_keys/i);
  assert.doesNotMatch(docs, /dash\.supadata\.ai/i);
});

test("notes filters preserve selected state", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  assert.match(html, /id="notesFilterThis"[\s\S]*?aria-pressed="true"/);
  assert.match(html, /id="notesFilterAll"[\s\S]*?aria-pressed="false"/);
  assert.match(js, /setAttribute\("aria-pressed", String\(!showAll\)\)/);
  assert.match(js, /setAttribute\("aria-pressed", String\(showAll\)\)/);
});

test("digest results are source-bound and stale requests are ignored", () => {
  const background = read("background.js");
  const sidepanel = read("sidepanel.js");

  assert.match(background, /Never trust __playinfo__/);
  assert.match(background, /contentKey: `bilibili:\$\{safeVideoId\}:p\$\{safePageNumber\}`/);
  assert.match(background, /contentKey: `youtube:\$\{videoId\}`/);
  assert.match(background, /findYouTubeTabForVideo\(videoId, source\?\.tabId\)/);
  assert.match(background, /finalDetails\?\.videoId !== videoId/);
  assert.match(sidepanel, /requestGeneration !== digestGeneration/);
  assert.match(sidepanel, /t\("sourceMismatchTitle"\)/);
  assert.match(sidepanel, /cacheSchemaVersion !== DIGEST_CACHE_SCHEMA_VERSION/);
  assert.match(sidepanel, /cached\.contentKey !== expectedContentKey/);
  assert.match(sidepanel, /cached\.videoId !== videoId/);
  assert.match(
    sidepanel,
    /const cacheData = \{[\s\S]*?channelName: currentChannelName,\s+videoId,\s+platform: currentPlatform/,
  );
  assert.doesNotMatch(
    sidepanel,
    /function renderAnalysisResults\([\s\S]*?channelName: currentChannelName,\s+videoId,\s+timestampSeconds: chapter\.timestampSeconds/,
  );
});

test("Create tab exposes the bounded Creator Workspace handoff and browser theme", () => {
  const html = read("sidepanel.html");
  const css = read("sidepanel.css");
  const js = read("sidepanel.js");
  const bridge = read("bridge/server.js");

  assert.match(html, /data-tab="create"/);
  assert.match(html, /id="sendToCreatorWorkspaceBtn"/);
  assert.match(html, /Full transcript[\s\S]*?Not included/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /--bg: #ffffff/);
  assert.match(css, /--bg: #0f0f0f/);
  assert.match(css, /body\[data-platform="bilibili"\][\s\S]*?#fb7299/i);
  assert.match(js, /action: "sendLearningPack"/);
  assert.match(bridge, /request\.url === "\/v1\/handoff"/);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("manifest grants only YouTube and loopback bridge hosts", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const packageJson = JSON.parse(read("package.json"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.equal(manifest.name, "YouTube Digest + Codex");
  assert.equal(manifest.version, "1.4.0");
  assert.equal(packageJson.version, manifest.version);
  assert.deepEqual(manifest.host_permissions.sort(), [
    "http://127.0.0.1:43110/*",
    "https://*.googlevideo.com/*",
    "https://www.youtube.com/*",
  ]);
  assert.ok(!manifest.permissions.includes("activeTab"));
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
  assert.match(docs, /YouTube subtitles|YouTube 页面字幕/i);
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
  assert.match(js, /action: "sendLearningPack"/);
  assert.match(bridge, /request\.url === "\/v1\/handoff"/);
});
